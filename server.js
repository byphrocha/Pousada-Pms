const express  = require("express");
const crypto   = require("crypto");
const https    = require("https");
const dns      = require("dns").promises;
const fs       = require("fs");
const path     = require("path");
const bcrypt   = require("bcryptjs");
const jwt      = require("jsonwebtoken");
const { createClient } = require("@supabase/supabase-js");
const availability = require("./lib/availability");
const icalReconcile = require("./lib/ical-reconcile");
const syncStatus = require("./lib/sync-status");
const session = require("./lib/session");

const app  = express();
const PORT       = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET;
const MAX_ICAL_BYTES = 2 * 1024 * 1024; // 2MB por feed
if (!JWT_SECRET) {
  console.error("❌ FATAL: variável JWT_SECRET não definida. Configure no Render → Environment.");
  process.exit(1);
}

// Supabase
if (!process.env.SUPABASE_URL || !process.env.SUPABASE_KEY) {
  console.error("❌ FATAL: SUPABASE_URL e SUPABASE_KEY devem estar definidos.");
  process.exit(1);
}
let supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

// Checagem de disponibilidade no servidor (PMS-004/005, camada 1):
//   warn    → só registra no log quando há conflito e grava mesmo assim (padrão)
//   enforce → recusa com HTTP 409 ROOM_CONFLICT
//   off     → não checa (comportamento antigo)
// Começar em "warn" em produção, olhar os logs, e só então passar para "enforce".
function availabilityMode() {
  const m = String(process.env.AVAILABILITY_CHECK || "warn").toLowerCase();
  return ["warn", "enforce", "off"].includes(m) ? m : "warn";
}

app.use(express.json({ limit: "256kb" })); // previne DoS via payload gigante

// Express 4 não captura erros de handlers async: uma exceção virava
// "unhandledRejection" e o Node derrubava o processo (PMS fora do ar até o
// Render reiniciar). Aqui todo handler de rota passa a encaminhar o erro para
// o tratador no fim do arquivo, que responde 500 sem detalhes internos.
const asyncSafe = (fn) => function (req, res, next) {
  try { return Promise.resolve(fn.call(this, req, res, next)).catch(next); }
  catch (e) { return next(e); }
};
for (const method of ["get", "post", "put", "delete", "patch"]) {
  const original = app[method].bind(app);
  app[method] = (route, ...handlers) => handlers.length === 0
    ? original(route) // app.get("setting") é leitura de configuração, não rota
    : original(route, ...handlers.map(h => (typeof h === "function" && h.length < 4 ? asyncSafe(h) : h)));
}

// ── Rate limiting simples para /login ─────────────────────────────────────────
const loginAttempts = new Map();
function checkLoginRate(ip) {
  const now  = Date.now();
  const list = (loginAttempts.get(ip) || []).filter(t => now - t < 15 * 60 * 1000);
  if (list.length >= 10) return false; // 10 tentativas por 15 min
  list.push(now);
  loginAttempts.set(ip, list);
  return true;
}
// Limpa entradas antigas a cada 30 min para não vazar memória
// (.unref() para não segurar o processo vivo nos testes)
setInterval(() => {
  const cut = Date.now() - 15 * 60 * 1000;
  for (const [ip, times] of loginAttempts) {
    const fresh = times.filter(t => t > cut);
    if (fresh.length === 0) loginAttempts.delete(ip);
    else loginAttempts.set(ip, fresh);
  }
}, 30 * 60 * 1000).unref();

// ── Security headers ──────────────────────────────────────────────────────────
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  next();
});

// CORS — restringe ao domínio do Render
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "https://pousada-pms-209a.onrender.com";
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (!origin || origin === ALLOWED_ORIGIN) {
    res.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
  }
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// ── Auth helpers ─────────────────────────────────────────────────────────────
// PMS-015: o token sozinho não basta. A cada pedido o servidor confere no banco
// (com cache de 60 s) se o usuário ainda existe, qual é o papel ATUAL dele e se
// a senha não mudou desde o login. Antes valia o que estava escrito no token por
// 30 dias: trocar a senha ou rebaixar/remover um usuário não tinha efeito.
const sessionCache = session.createSessionCache(60 * 1000);
async function loadSessionUser(userId) {
  const cached = sessionCache.get(userId);
  if (cached !== undefined) return cached;
  const { data, error } = await supabase.from("users")
    .select("id, username, role, password_hash").eq("id", userId).maybeSingle();
  if (error) throw new Error("falha ao validar sessão");
  const user = data && typeof data.password_hash === "string"
    ? { id: String(data.id), username: data.username, role: data.role, pv: session.passwordFingerprint(data.password_hash) }
    : null;
  sessionCache.set(userId, user);
  return user;
}
function signSession(user) {
  return jwt.sign(
    { userId: String(user.id), role: user.role, username: user.username, pv: session.passwordFingerprint(user.password_hash) },
    JWT_SECRET, { expiresIn: "30d", algorithm: "HS256" });
}

async function authMiddleware(req, res, next) {
  const token = (req.headers.authorization || "").split(" ")[1];
  if (!token) return res.status(401).json({ error: "Não autorizado" });
  let payload;
  try { payload = jwt.verify(token, JWT_SECRET, { algorithms: ["HS256"] }); }
  catch { return res.status(401).json({ error: "Token inválido ou expirado" }); }
  if (!payload || (typeof payload.userId !== "string" && typeof payload.userId !== "number") || typeof payload.pv !== "string")
    return res.status(401).json({ error: "Sessão expirada. Entre de novo." });
  let user;
  try { user = await loadSessionUser(String(payload.userId)); }
  catch {
    console.error("[auth] não foi possível validar a sessão no banco");
    return res.status(503).json({ error: "Não foi possível validar a sessão. Tente novamente." });
  }
  if (!user || user.pv !== payload.pv)
    return res.status(401).json({ error: "Sessão expirada. Entre de novo." });
  // Papel vem do banco, não do token.
  req.user = { userId: user.id, role: user.role, username: user.username };
  next();
}

function adminOnly(req, res, next) {
  if (req.user?.role !== "admin")
    return res.status(403).json({ error: "Acesso restrito ao administrador" });
  next();
}

// ── Login ─────────────────────────────────────────────────────────────────────
// Limite por CONTA, além do limite por IP: o IP vem de X-Forwarded-For, que o
// cliente pode forjar. 20 senhas erradas em 15 min para o mesmo usuário
// bloqueiam novas tentativas dele por 15 min (só falhas contam; acerto zera).
const loginFailures = new Map();
const LOGIN_FAIL_WINDOW = 15 * 60 * 1000, LOGIN_FAIL_MAX = 20;
function recentFailures(user) {
  const now = Date.now();
  const list = (loginFailures.get(user) || []).filter(t => now - t < LOGIN_FAIL_WINDOW);
  if (list.length) loginFailures.set(user, list); else loginFailures.delete(user);
  return list;
}
setInterval(() => { for (const u of [...loginFailures.keys()]) recentFailures(u); }, 30 * 60 * 1000).unref();

const DUMMY_HASH = bcrypt.hashSync("senha-que-nao-existe-" + crypto.randomBytes(8).toString("hex"), 10);

app.post("/login", async (req, res) => {
  const rawIp = req.headers["x-forwarded-for"] || req.socket.remoteAddress || "unknown";
  const ip = String(rawIp).split(",")[0].trim();
  if (!checkLoginRate(ip))
    return res.status(429).json({ error: "Muitas tentativas. Aguarde 15 minutos." });
  const { username, password } = req.body || {};
  if (typeof username !== "string" || typeof password !== "string" || !username || !password ||
      username.length > 100 || password.length > 200)
    return res.status(400).json({ error: "Usuário e senha obrigatórios" });
  const uname = username.trim().toLowerCase();
  if (recentFailures(uname).length >= LOGIN_FAIL_MAX)
    return res.status(429).json({ error: "Muitas tentativas. Aguarde 15 minutos." });
  const fail = () => {
    loginFailures.set(uname, [...recentFailures(uname), Date.now()]);
    return res.status(401).json({ error: "Credenciais inválidas" });
  };
  const { data: user } = await supabase
    .from("users").select("*").eq("username", uname).maybeSingle();
  if (!user || typeof user.password_hash !== "string") {
    // Compara com um hash qualquer para gastar o mesmo tempo: sem isso, usuário
    // inexistente respondia mais rápido e revelava quais contas existem.
    await bcrypt.compare(password, DUMMY_HASH);
    return fail();
  }
  const valid = await bcrypt.compare(password, user.password_hash);
  if (!valid) return fail();
  loginFailures.delete(uname);
  const token = signSession(user);
  res.json({ token, role: user.role, username: user.username });
});

// ── Setup inicial — DESABILITADO EM PRODUÇÃO ──────────────────────────────────
// Para criar usuários pela primeira vez, descomente temporariamente esta rota,
// faça POST /setup-users com { adminPass, staffPass }, depois comente de volta.
// app.post("/setup-users", async (req, res) => { ... });

// ── Mudar senha ───────────────────────────────────────────────────────────────
// Trocar a senha derruba as sessões antigas (outros aparelhos entram de novo)
// e devolve um token novo para este aparelho continuar logado.
// Erros de senha atual contam no mesmo limite do login: sem isso, um token
// roubado permitia testar senhas aqui sem limite.
app.post("/change-password", authMiddleware, async (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (typeof currentPassword !== "string" || typeof newPassword !== "string" || !currentPassword || !newPassword)
    return res.status(400).json({ error: "Campos obrigatórios" });
  if (newPassword.length < 6)
    return res.status(400).json({ error: "Nova senha deve ter ao menos 6 caracteres" });
  // bcrypt ignora o que passa de 72 bytes: senha maior daria falsa sensação de segurança.
  if (Buffer.byteLength(newPassword, "utf8") > 72 || currentPassword.length > 200)
    return res.status(400).json({ error: "Nova senha deve ter no máximo 72 caracteres" });
  const uname = String(req.user.username || "").toLowerCase();
  if (recentFailures(uname).length >= LOGIN_FAIL_MAX)
    return res.status(429).json({ error: "Muitas tentativas. Aguarde 15 minutos." });
  const { data: user } = await supabase
    .from("users").select("*").eq("id", req.user.userId).maybeSingle();
  if (!user) return res.status(404).json({ error: "Usuário não encontrado" });
  const valid = await bcrypt.compare(currentPassword, user.password_hash);
  if (!valid) {
    loginFailures.set(uname, [...recentFailures(uname), Date.now()]);
    // 400, não 401: a tela trata 401 como sessão expirada e deslogaria o usuário.
    return res.status(400).json({ error: "Senha atual incorreta" });
  }
  const hash = await bcrypt.hash(newPassword, 10);
  const { error } = await supabase.from("users").update({ password_hash: hash }).eq("id", user.id);
  if (error) return res.status(500).json({ error: "Não foi possível trocar a senha. Nada foi alterado." });
  sessionCache.delete(String(user.id));
  loginFailures.delete(uname);
  res.json({ ok: true, token: signSession({ ...user, password_hash: hash }) });
});

// ── Hóspedes ──────────────────────────────────────────────────────────────────
// CPF de hóspede: só o administrador vê completo. Funcionário vê os 2 últimos
// dígitos (decisão do Paulo, 23/11/2026). Feito no servidor: esconder na tela
// não protege, a API devolveria tudo.
const isAdmin = (req) => req.user?.role === "admin";

// Valores de reserva (decisão do Paulo, 23/11/2026): o funcionário faz e edita
// reservas, mas não vê nem altera valor e forma de pagamento. Garantido aqui,
// não só na tela.
const MONEY_FIELDS = ["amount", "payment"];
function reservationForRole(req, r) {
  if (!r || isAdmin(req)) return r;
  const out = { ...r };
  for (const k of MONEY_FIELDS) delete out[k];
  return out;
}
function maskCpf(cpf) {
  const d = String(cpf || "").replace(/\D/g, "");
  return d.length >= 2 ? `***.***.***-${d.slice(-2)}` : "";
}
const guestForRole = (req, g) => (g && !isAdmin(req) ? { ...g, cpf: maskCpf(g.cpf) } : g);
const isMasked = (v) => String(v || "").includes("*");

app.get("/guests", authMiddleware, async (req, res) => {
  const q = (req.query.q || "").slice(0, 100); // limite de tamanho
  let query = supabase.from("guests").select("*").order("name");
  if (q.trim()) {
    // Escapa % e _ para evitar wildcard abuse no ilike
    const safe = q.replace(/[%_\\]/g, c => "\\" + c);
    // Funcionário não busca por CPF (evita descobrir CPF por tentativa).
    const fields = isAdmin(req) ? ["name", "phone", "cpf", "email"] : ["name", "phone", "email"];
    query = query.or(fields.map(f => `${f}.ilike.%${safe}%`).join(","));
  }
  const { data, error } = await query.limit(50);
  if (error) return res.status(500).json({ error: error.message });
  res.json((data || []).map(g => guestForRole(req, g)));
});

app.get("/guests/:id", authMiddleware, async (req, res) => {
  const { data } = await supabase.from("guests").select("*").eq("id", req.params.id).maybeSingle();
  res.json(guestForRole(req, data) || null);
});

app.post("/guests", authMiddleware, async (req, res) => {
  const b = req.body || {};
  const g = {
    id:         b.id || Math.random().toString(36).slice(2,10),
    name:       (b.name    || "").slice(0, 200),
    phone:      (b.phone   || "").slice(0, 30),
    email:      (b.email   || "").slice(0, 200),
    cpf:        (b.cpf     || "").slice(0, 20),
    address:    (b.address || "").slice(0, 300),
    notes:      (b.notes   || "").slice(0, 1000),
    updated_at: new Date().toISOString(),
  };
  if (!g.created_at) g.created_at = new Date().toISOString();
  // Nunca grava CPF mascarado; funcionário não altera CPF de hóspede existente
  // (o upsert só atualiza as colunas enviadas, então remover a chave preserva o valor).
  if (isMasked(g.cpf)) delete g.cpf;
  if (!isAdmin(req) && "cpf" in g) {
    const { data: existing } = await supabase.from("guests").select("id").eq("id", g.id).maybeSingle();
    if (existing) delete g.cpf;
  }
  const { data, error } = await supabase.from("guests").upsert(g).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(guestForRole(req, data));
});

app.put("/guests/:id", authMiddleware, async (req, res) => {
  const b = req.body || {};
  const g = {
    name:       (b.name    || "").slice(0, 200),
    phone:      (b.phone   || "").slice(0, 30),
    email:      (b.email   || "").slice(0, 200),
    cpf:        (b.cpf     || "").slice(0, 20),
    address:    (b.address || "").slice(0, 300),
    notes:      (b.notes   || "").slice(0, 1000),
    updated_at: new Date().toISOString(),
  };
  if (!isAdmin(req) || isMasked(g.cpf)) delete g.cpf;
  const { data, error } = await supabase.from("guests").update(g).eq("id", req.params.id).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(guestForRole(req, data));
});

// Utilitários iCal
const AIRBNB_BLOCKED = [
  /^blocked$/i,           // Bloqueios explícitos
  /^unavailable$/i,       // Indisponibilidades
  /bloqueado/i,           // Em português
  /indispon/i,            // Em português
];

function isAirbnbBlock(summary, uid) {
  // Airbnb usa "Airbnb (Not available)" como SUMMARY padrão para RESERVAS confirmadas
  // Não deve ser bloqueado — apenas bloqueios e indisponibilidades reais
  if (summary === "Airbnb (Not available)") return false;
  
  if (AIRBNB_BLOCKED.some(p => p.test(summary||""))) return true;
  if (/CLOSED|BLOCK/i.test(uid||"") && !summary) return true;
  return false;
}

function parseIcal(text, source) {
  const events = [];
  
  // DEBUG: log do tamanho e conteúdo inicial
  if (!text || text.length === 0) {
    console.error(`[parseIcal] iCal vazio ou null para source=${source}`);
    return events;
  }
  
  console.log(`[parseIcal] Recebido ${text.length} bytes do ${source}`);
  
  // Verifica se tem BEGIN:VCALENDAR
  if (!text.includes("BEGIN:VCALENDAR")) {
    console.error(`[parseIcal] Não encontrado BEGIN:VCALENDAR no iCal do ${source}`);
    return events;
  }
  
  const blocks = text.split("BEGIN:VEVENT");
  console.log(`[parseIcal] Encontrados ${blocks.length - 1} blocos VEVENT do ${source}`);
  
  if (blocks.length <= 1) {
    console.log(`[parseIcal] Nenhum evento encontrado no iCal do ${source}`);
    return events;
  }
  
  const parseDate = (s) => {
    if (!s) return null;
    const c = String(s).replace(/[^0-9]/g, "").slice(0, 8);
    if (c.length !== 8) {
      console.warn(`[parseDate] Data inválida: ${s} -> ${c}`);
      return null;
    }
    return `${c.slice(0,4)}-${c.slice(4,6)}-${c.slice(6,8)}`;
  };
  
  for (let i = 1; i < blocks.length; i++) {
    const b = blocks[i];
    const lines = b.split("\n");
    let dtstart = null, dtend = null, summary = "", uid = "";
    
    for (const line of lines) {
      const [key, ...valueParts] = line.split(":");
      const value = valueParts.join(":").trim();
      
      if (key.startsWith("DTSTART")) dtstart = parseDate(value);
      else if (key.startsWith("DTEND")) dtend = parseDate(value);
      else if (key === "SUMMARY") summary = value;
      else if (key === "UID") uid = value;
    }
    
    if (!dtstart || !dtend) {
      console.warn(`[parseIcal] Evento ${i} do ${source} sem datas válidas: dtstart=${dtstart}, dtend=${dtend}`);
      continue;
    }
    
    if (source === "airbnb" && isAirbnbBlock(summary, uid)) continue;

    // Sem log por evento: o SUMMARY pode trazer dados do hóspede (achado I7).
    events.push({ uid, summary, checkIn: dtstart, checkOut: dtend });
  }
  
  console.log(`[parseIcal] Total de eventos extraídos do ${source}: ${events.length}`);
  return events;
}

function isAllowedHostname(url, allowedHosts) {
  if (!allowedHosts || allowedHosts.length === 0) return true;
  return allowedHosts.some(h => url.hostname === h || url.hostname.endsWith("." + h));
}

function isPrivateIp(ip) {
  const h = String(ip || "").toLowerCase();
  if (!h) return true;
  if (h === "localhost" || h === "::1" || h === "0.0.0.0") return true;
  if (/^127\./.test(h)) return true;
  if (/^10\./.test(h)) return true;
  if (/^192\.168\./.test(h)) return true;
  if (/^169\.254\./.test(h)) return true;
  if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(h)) return true;
  if (/^::ffff:(127|10|192\.168|169\.254|172\.(1[6-9]|2\d|3[0-1]))\./.test(h)) return true;
  if (/^fc|^fd/.test(h)) return true; // ULA
  if (/^fe8|^fe9|^fea|^feb/.test(h)) return true; // link-local IPv6
  return false;
}

async function assertPublicDns(hostname) {
  const results = await dns.lookup(hostname, { all: true, verbatim: true });
  if (!results || results.length === 0) throw new Error("Hostname sem resolução DNS");
  if (results.some((r) => isPrivateIp(r.address)))
    throw new Error("Destino resolve para IP privado/interno");
}

async function fetchUrl(url, depth = 0, allowedHosts = null) {
  if (depth > 3) return Promise.reject(new Error("Muitos redirecionamentos"));
  let parsed;
  try { parsed = new URL(url); } catch { return Promise.reject(new Error("URL inválida")); }
  if (parsed.protocol !== "https:") return Promise.reject(new Error("Apenas HTTPS permitido"));
  if (parsed.username || parsed.password)
    return Promise.reject(new Error("URL com credenciais não é permitida"));
  if (isPrivateIp(parsed.hostname))
    return Promise.reject(new Error("Destino privado/interno não permitido"));
  if (!isAllowedHostname(parsed, allowedHosts))
    return Promise.reject(new Error("Domínio não permitido"));
  await assertPublicDns(parsed.hostname);

  return new Promise((resolve, reject) => {
    let done = false;
    const fail = (err) => {
      if (done) return;
      done = true;
      reject(err);
    };
    const ok = (body) => {
      if (done) return;
      done = true;
      resolve(body);
    };

    const lib = https;
    let body = "";
    let size = 0;
    const req = lib.get(parsed.toString(), { headers: { "User-Agent": "Mozilla/5.0 (PMS-Pousada/1.0)" } }, (res) => {
      if (res.statusCode >= 400) return fail(new Error(`HTTP ${res.statusCode}`));
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const nextUrl = new URL(res.headers.location, parsed).toString();
        return fetchUrl(nextUrl, depth + 1, allowedHosts).then(ok).catch(fail);
      }
      if (res.statusCode < 200 || res.statusCode >= 300)
        return fail(new Error(`HTTP ${res.statusCode}`));
      res.on("data", (d) => {
        size += Buffer.byteLength(d);
        if (size > MAX_ICAL_BYTES) {
          req.destroy(new Error("Arquivo iCal excede limite de tamanho"));
          return;
        }
        body += d;
      });
      res.on("end",  () => ok(body));
    }).on("error", fail);
    // Timeout de 15 segundos para não travar o auto-sync
    req.setTimeout(15000, () => req.destroy(new Error("Timeout ao buscar iCal")));
  });
}

// Comparação de segredo em tempo constante (não revela o token por tempo de resposta).
function safeEqual(a, b) {
  const ha = crypto.createHash("sha256").update(String(a ?? "")).digest();
  const hb = crypto.createHash("sha256").update(String(b ?? "")).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function genId() { return crypto.randomBytes(6).toString("hex"); } // 12 chars hex, criptográfico

// Lock para evitar syncs simultâneos (auto-sync + POST /sync)
let isSyncing = false;

// Valida data de calendário real no formato YYYY-MM-DD (rejeita 2026-02-31 — achado D3)
const isValidDate = availability.isBusinessDate;

// Consulta reservas que ocupam algum dos quartos no período [checkIn, checkOut).
// Retorna { conflicts: [{id, room_id}], error }. Só identificadores, nunca dados do hóspede.
async function checkAvailability({ rooms, checkIn, checkOut, ignoreIds = [] }) {
  const { data, error } = await supabase
    .from("reservations")
    // source e guest_name só servem para reconhecer bloqueios do Airbnb;
    // nunca são registrados em log nem devolvidos ao cliente.
    .select("id, room_id, check_in, check_out, status, source, guest_name")
    .in("room_id", rooms)
    .neq("status", "cancelled")
    .lt("check_in", checkOut)
    .gt("check_out", checkIn);
  if (error) return { conflicts: [], error };
  return { conflicts: availability.findConflicts(data, { rooms, checkIn, checkOut, ignoreIds }), error: null };
}

// Aplica o modo configurado. Retorna null para seguir gravando, ou {status, body} para responder.
async function guardAvailability(stay, contexto) {
  const mode = availabilityMode();
  if (mode === "off") return null;
  const { conflicts, error } = await checkAvailability(stay);
  if (error) {
    console.error(`[availability] falha ao consultar disponibilidade (${contexto}): ${error.message || error}`);
    return mode === "enforce"
      ? { status: 503, body: { error: { code: "AVAILABILITY_UNKNOWN", message: "Não foi possível verificar a disponibilidade. Nada foi salvo; tente novamente." } } }
      : null;
  }
  if (conflicts.length === 0) return null;
  const rooms = conflicts.map(c => c.room_id);
  // Log sem nome/telefone: só quartos, período e ids internos.
  console.warn(`[availability] conflito (${mode}, ${contexto}) quartos=${[...new Set(rooms)].join(",")} ` +
               `periodo=${stay.checkIn}..${stay.checkOut} reservas=${conflicts.map(c => c.id).join(",")}`);
  return mode === "enforce" ? { status: 409, body: availability.conflictError(rooms) } : null;
}


// O banco recusa sobreposição (constraint reservations_no_overlap, código 23P01).
// Isso fecha a corrida entre dois pedidos simultâneos que a checagem acima não fecha.
const isOverlapError = (err) => !!err && err.code === "23P01";
async function overlapResponse(res, rooms, stay, contexto) {
  // Descobre quais quartos colidiram (só ids e quartos; nada sobre o outro hóspede).
  let hit = rooms;
  if (stay) {
    const { conflicts } = await checkAvailability({ rooms, checkIn: stay.checkIn, checkOut: stay.checkOut, ignoreIds: stay.ignoreIds || [] });
    if (conflicts.length) hit = conflicts.map(c => c.room_id);
  }
  console.warn(`[availability] banco recusou sobreposição (${contexto}) quartos=${[...new Set(hit)].join(",")}`);
  return res.status(409).json(availability.conflictError(hit));
}

// Health check
app.get("/healthz", (req, res) => res.json({ ok: true, ts: new Date().toISOString() }));

// ── Reservas ──────────────────────────────────────────────────────────────────
// O Supabase/PostgREST devolve no máximo 1.000 linhas por consulta. Com mais
// reservas que isso, a tela recebia só as mais antigas e mostrava os quartos
// livres. Esta função busca todas as páginas.
const PAGE_SIZE = 1000;
async function selectAllPages(buildQuery) {
  const all = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await buildQuery().range(from, from + PAGE_SIZE - 1);
    if (error) return { data: null, error };
    all.push(...(data || []));
    if (!data || data.length < PAGE_SIZE) return { data: all, error: null };
  }
}

app.get("/reservations", authMiddleware, async (req, res) => {
  const { data, error } = await selectAllPages(() =>
    supabase.from("reservations").select("*").order("check_in").order("id"));
  if (error) return res.status(500).json({ error: error.message });
  // Bloqueios "Not available" do Airbnb: a tela já os descartava (isAirbnbBlock);
  // filtrar aqui reduz a resposta sem mudar o que é exibido.
  res.json(data.filter(r => !availability.isCalendarBlock(r)).map(r => reservationForRole(req, r)));
});

app.post("/reservations", authMiddleware, async (req, res) => {
  const b = req.body || {};
  // Valida campos obrigatórios
  if (!b.guestName || !b.checkIn || !b.checkOut || !b.roomId)
    return res.status(400).json({ error: "guestName, checkIn, checkOut e roomId são obrigatórios" });
  if (!isValidDate(b.checkIn) || !isValidDate(b.checkOut))
    return res.status(400).json({ error: "checkIn e checkOut devem estar no formato YYYY-MM-DD" });
  if (b.checkOut <= b.checkIn)
    return res.status(400).json({ error: "checkOut deve ser após checkIn" });
  // Cada linha de reserva é um quarto físico. CF e 11+12 chegam aqui já
  // divididos em linhas pelo frontend.
  if (!availability.isPhysicalRoom(b.roomId))
    return res.status(400).json({ error: "roomId deve ser um quarto físico (10, 11, 12, 20–25)" });
  const newStatus = ["confirmed","cancelled","pending"].includes(b.status) ? b.status : "confirmed";
  if (availability.isBlocking(newStatus)) {
    const blocked = await guardAvailability(
      { rooms: [String(b.roomId)], checkIn: b.checkIn, checkOut: b.checkOut }, "POST /reservations");
    if (blocked) return res.status(blocked.status).json(blocked.body);
  }
  if (b.externalUid) {
    const { data: exists } = await supabase.from("reservations").select("id").eq("external_uid", b.externalUid).single();
    if (exists) return res.json({ ok: false, reason: "duplicate" });
  }
  const row = buildReservationRow(b);
  if (!isAdmin(req)) { row.amount = 0; row.payment = "pix"; } // valor fica para o admin lançar
  const { data, error } = await supabase.from("reservations").insert(row).select().single();
  if (isOverlapError(error))
    return overlapResponse(res, [row.room_id], { checkIn: row.check_in, checkOut: row.check_out }, "POST /reservations");
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true, reservation: reservationForRole(req, data) });
});

// Normaliza o corpo de uma reserva nova para a linha do banco (POST simples e grupo).
function buildReservationRow(b) {
  return {
    id:           b.id || genId(),
    room_id:      String(b.roomId).slice(0, 10),
    guest_name:   String(b.guestName).slice(0, 200),
    check_in:     b.checkIn,
    check_out:    b.checkOut,
    source:       ["direto","booking","airbnb"].includes(b.source) ? b.source : "direto",
    adults:       Math.max(1, Math.min(40, parseInt(b.adults)  || 2)),
    children:     Math.max(0, Math.min(20, parseInt(b.children)|| 0)),
    phone:        String(b.phone  || "").slice(0, 30),
    notes:        String(b.notes  || "").slice(0, 2000),
    status:       ["confirmed","cancelled","pending"].includes(b.status) ? b.status : "confirmed",
    external_uid: b.externalUid ? String(b.externalUid).slice(0, 300) : null,
    created_at:   b.createdAt || new Date().toISOString(),
    amount:       Math.max(0, parseFloat(b.amount) || 0),
    payment:      ["pix","dinheiro","cartao","transferencia"].includes(b.payment) ? b.payment : "pix",
  };
}

// Reserva composta (CF ou 11+12) gravada de uma vez — regra 5: tudo ou nada.
// O cliente manda uma linha por quarto físico (mantém as marcas [Casa toda:…] /
// [Suíte grupo:…] nas notas). O servidor exige que os quartos formem exatamente
// um produto, que todas as linhas tenham as mesmas datas e status, checa a
// disponibilidade de TODOS os quartos e grava num único INSERT: o Postgres
// executa um INSERT com várias linhas como uma instrução só, então ou entram
// todas ou nenhuma. A corrida entre checar e gravar só fecha com a constraint
// no banco (PR 6 da revisão).
app.post("/reservations/group", authMiddleware, async (req, res) => {
  const list = req.body && req.body.rows;
  if (!Array.isArray(list) || list.length < 2 || list.length > availability.ROOM_IDS.length)
    return res.status(400).json({ error: "rows deve ter de 2 a 9 linhas" });
  if (list.some(b => !b || typeof b !== "object"))
    return res.status(400).json({ error: "rows inválido" });

  const rooms = list.map(b => String(b.roomId ?? ""));
  const product = Object.keys(availability.PRODUCTS).find(p => {
    const expected = availability.PRODUCTS[p];
    return expected.length === rooms.length && expected.every(r => rooms.includes(r));
  });
  if (!product)
    return res.status(400).json({ error: "Os quartos devem formar exatamente a Casa Fechada (9 quartos) ou a suíte 11+12" });

  const first = list[0];
  if (!first.guestName || !String(first.guestName).trim())
    return res.status(400).json({ error: "guestName é obrigatório" });
  const invalid = availability.validateStay(first.checkIn, first.checkOut);
  if (invalid) return res.status(400).json({ error: invalid });
  const status = first.status ?? "confirmed";
  const same = list.every(b =>
    b.checkIn === first.checkIn && b.checkOut === first.checkOut && (b.status ?? "confirmed") === status &&
    b.guestName && String(b.guestName).trim());
  if (!same) return res.status(400).json({ error: "Todas as linhas precisam ter o mesmo hóspede, datas e status" });
  if (list.some(b => b.externalUid))
    return res.status(400).json({ error: "Reservas importadas não usam esta rota" });
  const ids = list.map(b => b.id).filter(Boolean).map(String);
  if (new Set(ids).size !== ids.length)
    return res.status(400).json({ error: "ids repetidos" });

  if (availability.isBlocking(status)) {
    const blocked = await guardAvailability(
      { rooms, checkIn: first.checkIn, checkOut: first.checkOut }, `POST /reservations/group ${product}`);
    if (blocked) return res.status(blocked.status).json(blocked.body);
  }

  const rows = list.map(buildReservationRow);
  if (!isAdmin(req)) for (const r of rows) { r.amount = 0; r.payment = "pix"; }
  const { data, error } = await supabase.from("reservations").insert(rows).select();
  if (isOverlapError(error))
    return overlapResponse(res, rooms, { checkIn: first.checkIn, checkOut: first.checkOut }, `POST /reservations/group ${product}`);
  if (error) {
    console.error(`[reservations/group] falha ao gravar ${product}: ${error.message || error}`);
    return res.status(500).json({ error: "Não foi possível gravar a reserva. Nada foi salvo; tente novamente." });
  }
  // Devolve na mesma ordem em que o cliente mandou (o 1º id recebe o lançamento financeiro).
  const byId = new Map((data || []).map(r => [String(r.id), r]));
  res.json({ ok: true, product, reservations: rows.map(r => reservationForRole(req, byId.get(String(r.id)) || r)) });
});

app.put("/reservations/:id", authMiddleware, async (req, res) => {
  const b   = req.body || {};
  const row = {};
  if (b.roomId    !== undefined) row.room_id    = String(b.roomId).slice(0, 10);
  if (b.guestName !== undefined) row.guest_name = String(b.guestName).slice(0, 200);
  if (b.checkIn   !== undefined) row.check_in   = b.checkIn;
  if (b.checkOut  !== undefined) row.check_out  = b.checkOut;
  if (b.source    !== undefined) row.source     = ["direto","booking","airbnb"].includes(b.source) ? b.source : "direto";
  if (b.adults    !== undefined) row.adults     = Math.max(1, Math.min(40, parseInt(b.adults)  || 2));
  if (b.children  !== undefined) row.children   = Math.max(0, Math.min(20, parseInt(b.children)|| 0));
  if (b.phone     !== undefined) row.phone      = String(b.phone  || "").slice(0, 30);
  if (b.notes     !== undefined) row.notes      = String(b.notes  || "").slice(0, 2000);
  if (b.amount    !== undefined) row.amount     = Math.max(0, parseFloat(b.amount) || 0);
  if (b.payment   !== undefined) row.payment    = ["pix","dinheiro","cartao","transferencia"].includes(b.payment) ? b.payment : "pix";
  if (b.status    !== undefined) row.status     = ["confirmed","cancelled","pending"].includes(b.status) ? b.status : "confirmed";
  // Funcionário: valor e pagamento são ignorados (a tela dele nem mostra os campos;
  // ignorar em vez de recusar evita apagar o valor quando o formulário vem sem ele).
  if (!isAdmin(req)) for (const k of MONEY_FIELDS) delete row[k];

  // Mudança de quarto, datas ou status: valida o resultado final da reserva
  // (antes o PUT aceitava qualquer data, inclusive saída antes da entrada — D2).
  const touchesStay = ["room_id","check_in","check_out","status"].some(k => k in row);
  if (touchesStay) {
    const { data: current, error: readErr } = await supabase
      .from("reservations").select("id, room_id, check_in, check_out, status")
      .eq("id", req.params.id).maybeSingle();
    if (readErr) return res.status(500).json({ error: readErr.message });
    if (!current) return res.status(404).json({ error: "Reserva não encontrada" });
    const next = {
      room_id:   row.room_id   ?? String(current.room_id),
      check_in:  row.check_in  ?? String(current.check_in).slice(0, 10),
      check_out: row.check_out ?? String(current.check_out).slice(0, 10),
      status:    row.status    ?? current.status,
    };
    // Só recusa quando o quarto MUDA para algo inválido; linhas antigas com
    // room_id fora do padrão continuam editáveis (ver bloco 4 do inventário).
    if ("room_id" in row && row.room_id !== String(current.room_id) && !availability.isPhysicalRoom(next.room_id))
      return res.status(400).json({ error: "roomId deve ser um quarto físico (10, 11, 12, 20–25)" });
    if ("check_in" in row || "check_out" in row) {
      const invalid = availability.validateStay(next.check_in, next.check_out);
      if (invalid) return res.status(400).json({ error: invalid });
    }
    if (availability.isBlocking(next.status)) {
      const blocked = await guardAvailability(
        { rooms: [next.room_id], checkIn: next.check_in, checkOut: next.check_out, ignoreIds: [req.params.id] },
        "PUT /reservations/:id");
      if (blocked) return res.status(blocked.status).json(blocked.body);
    }
  }

  const { error } = await supabase.from("reservations").update(row).eq("id", req.params.id);
  if (isOverlapError(error)) {
    const { data: cur } = await supabase.from("reservations").select("room_id, check_in, check_out")
      .eq("id", req.params.id).maybeSingle();
    const room = row.room_id ?? (cur && String(cur.room_id));
    return overlapResponse(res, room ? [room] : [], room ? {
      checkIn: row.check_in ?? String(cur.check_in).slice(0, 10),
      checkOut: row.check_out ?? String(cur.check_out).slice(0, 10),
      ignoreIds: [req.params.id],
    } : null, "PUT /reservations/:id");
  }
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

app.delete("/reservations/:id", authMiddleware, adminOnly, async (req, res) => {
  const { error } = await supabase.from("reservations").delete().eq("id", req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// ── URLs iCal ─────────────────────────────────────────────────────────────────
app.get("/urls", authMiddleware, adminOnly, async (req, res) => {
  const { data } = await supabase.from("settings").select("value").eq("key", "ical_urls").single();
  res.json(data?.value || { booking: {}, airbnb: {} });
});

app.post("/urls", authMiddleware, adminOnly, async (req, res) => {
  const body = req.body || {};
  // Valida estrutura: apenas chaves booking e airbnb, valores são objetos de strings
  const VALID_SOURCES = ["booking", "airbnb"];
  const VALID_ROOMS   = ["10","11","12","20","21","22","23","24","25","CF","11+12"];
  const safe = {};
  for (const src of VALID_SOURCES) {
    safe[src] = {};
    if (body[src] && typeof body[src] === "object") {
      for (const [room, url] of Object.entries(body[src])) {
        if (VALID_ROOMS.includes(room) && typeof url === "string")
          safe[src][room] = url.slice(0, 500);
      }
    }
  }
  await supabase.from("settings").upsert({ key: "ical_urls", value: safe });
  res.json({ ok: true });
});

// ── Sincronização iCal ────────────────────────────────────────────────────────
const ICAL_ALLOWED_HOSTS = [
  "airbnb.com", "www.airbnb.com", "www.airbnb.com.br",
  "booking.com", "ical.booking.com", "www.booking.com",
];

// Reconciliação dos feeds (PMS-009, achados I1/I2):
//   report → só registra no log o que atualizaria/cancelaria (padrão)
//   apply  → aplica as atualizações de datas e os cancelamentos
//   off    → não reconcilia
function icalReconcileMode() {
  const m = String(process.env.ICAL_RECONCILE || "report").toLowerCase();
  return ["report", "apply", "off"].includes(m) ? m : "report";
}
// Ausências seguidas de cada linha no feed (em memória; reinício do servidor zera,
// o que só atrasa um cancelamento, nunca antecipa).
const icalMissingCounts = new Map();

async function runSync({ fetcher = fetchUrl } = {}) {
  if (isSyncing) return { log: ["⚠️ Sincronização já em andamento, aguarde."], added: 0 };
  isSyncing = true;
  const log = ["⏳ Iniciando sincronização..."];
  let added = 0, cancelled = 0, updated = 0, failed = 0;
  const feedResults = []; // resumo por calendário para o status (PMS-011)
  try {
  const { data: settingRow, error: urlsErr } = await supabase.from("settings").select("value").eq("key", "ical_urls").maybeSingle();
  if (urlsErr) {
    // Sem a lista de calendários não houve sincronização: não grava status
    // (gravar "ok" com zero calendários esconderia o problema).
    console.error(`[runSync] não foi possível ler os calendários configurados: ${urlsErr.code || urlsErr.message || "erro"}`);
    log.push("✗ Não foi possível ler os calendários configurados. Nada foi sincronizado.");
    return { log, added, cancelled, updated, failed: failed + 1 };
  }
  const icalUrls = settingRow?.value || { booking: {}, airbnb: {} };
  const mode = icalReconcileMode();
  const today = todayBrasilia();

  for (const [source, urls] of Object.entries(icalUrls)) {
    for (const [roomId, url] of Object.entries(urls || {})) {
      if (!url) continue;
      log.push(`🔍 ${source} — Quarto ${roomId}`);
      const feed = { key: `${source}/${roomId}`, ok: false, problem: null, events: 0, conflicts: [] };
      feedResults.push(feed);
      const failedBefore = failed;
      try {
        const targetRooms = availability.resolveRooms(roomId);
        if (!targetRooms) { feed.problem = "quarto desconhecido"; log.push(`   ⚠️ Quarto desconhecido na configuração`); continue; }

        const text = await fetcher(url, 0, ICAL_ALLOWED_HOSTS);
        console.log(`[runSync] Recebido ${text.length} bytes do ${source}/${roomId}`);
        if (!text.includes("BEGIN:VCALENDAR")) {
          console.error(`[runSync] Resposta inválida do ${source}/${roomId}: não é iCal`);
          feed.problem = "resposta inválida";
          log.push(`   ⚠️ Resposta inválida`);
          continue;
        }
        const evts = parseIcal(text, source);
        feed.events = evts.length;
        log.push(`   → ${evts.length} reserva(s) no feed`);

        // Antes havia aqui um bloco que CANCELAVA toda reserva com check-out
        // passado (achado I1). Removido: estadia terminada não é cancelamento.

        // ── ADIÇÃO: insere reservas novas que ainda não estão no banco ──────
        for (const ev of evts) {
          for (const targetRoom of targetRooms) {
            const roomUid = icalReconcile.rowKey(source, targetRoom, ev.uid);
            const { data: exists } = await supabase.from("reservations").select("id").eq("external_uid", roomUid).maybeSingle();
            if (exists) continue;
            const { error: insErr } = await supabase.from("reservations").insert({
              id: genId(), room_id: targetRoom, external_uid: roomUid, status: "confirmed",
              guest_name:  ev.summary || `${source} reserva`,
              check_in:    ev.checkIn,
              check_out:   ev.checkOut,
              source, adults: 2, children: 0, phone: "",
              notes: roomId === "CF"    ? `Importado via iCal (Casa Fechada) [Casa toda:cf-${ev.uid}]`
                   : roomId === "11+12" ? `Importado via iCal (Suíte 11+12)`
                   : "Importado via iCal",
              created_at: new Date().toISOString(),
            });
            if (insErr) {
              // Antes o erro era ignorado em silêncio (achado I3).
              failed++;
              // Recusa do banco por sobreposição: a plataforma vendeu datas já ocupadas
              // (overbooking real). A reserva NÃO entra no PMS, então precisa aparecer
              // no aviso da tela com quarto e datas para alguém resolver.
              if (isOverlapError(insErr)) feed.conflicts.push({ room: targetRoom, checkIn: ev.checkIn, checkOut: ev.checkOut });
              console.error(`[runSync] Falha ao importar ${source}/${roomId} quarto=${targetRoom} ` +
                            `periodo=${ev.checkIn}..${ev.checkOut}: ${insErr.code || insErr.message || "erro"}`);
              log.push(`   ✗ Não importado: Qto ${targetRoom} (${ev.checkIn} → ${ev.checkOut})`);
              continue;
            }
            log.push(`   ✓ Novo: Qto ${targetRoom} — ${ev.summary || "Reserva"} (${ev.checkIn} → ${ev.checkOut})`);
            added++;
          }
        }

        // ── RECONCILIAÇÃO: datas alteradas e reservas que sumiram do feed ───
        if (mode !== "off") {
          const { data: rows, error: rowsErr } = await selectAllPages(() => supabase.from("reservations")
            .select("id, room_id, external_uid, check_in, check_out, notes")
            .eq("source", source).eq("status", "confirmed")
            .in("room_id", targetRooms).gte("check_out", today).order("id"));
          if (rowsErr) throw new Error("falha ao ler reservas para reconciliar");
          const plan = icalReconcile.planReconcile({
            source, feedRoomId: roomId, events: evts, rows, today, missingCounts: icalMissingCounts,
          });
          if (plan.skipped) {
            console.warn(`[ical-reconcile] ${source}/${roomId}: pulado (${plan.skipped})`);
          } else {
            for (const [k, v] of plan.nextCounts) icalMissingCounts.set(k, v);
            for (const r of rows || []) if (!plan.nextCounts.has(r.id)) icalMissingCounts.delete(r.id);
            // Log só com ids, quartos e datas.
            console.log(`[ical-reconcile] (${mode}) ${source}/${roomId}: ` +
              `atualizar=${plan.updates.length} cancelar=${plan.cancels.length} aguardando=${plan.pending.length}` +
              (plan.updates.length ? ` | datas: ${plan.updates.map(u => `${u.id}@${u.room_id} ${u.from.join("..")}->${u.to.join("..")}`).join(", ")}` : "") +
              (plan.cancels.length ? ` | cancelar: ${plan.cancels.map(c => `${c.id}@${c.room_id}`).join(", ")}` : ""));
            if (mode === "apply") {
              for (const u of plan.updates) {
                const { error } = await supabase.from("reservations")
                  .update({ check_in: u.to[0], check_out: u.to[1] }).eq("id", u.id).eq("status", "confirmed");
                if (error) { failed++; console.error(`[ical-reconcile] falha ao atualizar ${u.id}: ${error.code || error.message}`); }
                else { updated++; log.push(`   ↻ Datas alteradas: Qto ${u.room_id} ${u.from.join(" → ")} ⇒ ${u.to.join(" → ")}`); }
              }
              for (const c of plan.cancels) {
                const { error } = await supabase.from("reservations")
                  .update({ status: "cancelled" }).eq("id", c.id).eq("status", "confirmed");
                if (error) { failed++; console.error(`[ical-reconcile] falha ao cancelar ${c.id}: ${error.code || error.message}`); }
                else { cancelled++; icalMissingCounts.delete(c.id); log.push(`   ✕ Saiu do calendário: Qto ${c.room_id} (${c.id})`); }
              }
            } else if (plan.updates.length || plan.cancels.length) {
              log.push(`   ℹ️ Modo relatório: ${plan.updates.length} alteração(ões) de data e ${plan.cancels.length} cancelamento(s) seriam aplicados`);
            }
          }
        }
        if (feed.conflicts.length) feed.problem = "conflito com outra reserva";
        else if (failed > failedBefore) feed.problem = "falha ao gravar";
        else feed.ok = true;
      } catch(e) {
        feed.problem = syncStatus.classifyError(e);
        log.push(`   ✗ Erro: ${e.message}`);
      }
    }
  }

  const parts = [];
  if (added)     parts.push(`${added} nova(s)`);
  if (updated)   parts.push(`${updated} com datas alteradas`);
  if (cancelled) parts.push(`${cancelled} cancelada(s)`);
  if (failed)    parts.push(`${failed} falha(s)`);
  log.push(`✅ Concluído${parts.length ? ` — ${parts.join(", ")}` : " — nenhuma novidade"}`);
  await saveSyncStatus({ feeds: feedResults, added, updated, cancelled, failed });
  return { log, added, cancelled, updated, failed };
  } finally { isSyncing = false; }
}

// Grava o resumo da passada em settings.ical_sync_status (chave/valor jsonb, já
// existente). Falhar aqui nunca derruba o sync: só registra no log.
const SYNC_STATUS_KEY = "ical_sync_status";
async function saveSyncStatus(run) {
  try {
    const { data: prev } = await supabase.from("settings").select("value").eq("key", SYNC_STATUS_KEY).maybeSingle();
    const value = syncStatus.mergeStatus(prev && prev.value, run, new Date().toISOString());
    const { error } = await supabase.from("settings").upsert({ key: SYNC_STATUS_KEY, value });
    if (error) throw new Error(error.code || error.message || "erro");
    const bad = Object.entries(value.feeds).filter(([, f]) => f.problem);
    if (bad.length) console.warn(`[sync-status] calendários com problema: ${bad.map(([k, f]) => `${k} (${f.problem})`).join(", ")}`);
  } catch (e) {
    console.error(`[sync-status] não foi possível gravar o status: ${e.message}`);
  }
}

// Situação dos calendários para a tela (todos os perfis): sem URL, sem dados de hóspede.
app.get("/sync/status", authMiddleware, async (req, res) => {
  const { data, error } = await supabase.from("settings").select("value").eq("key", SYNC_STATUS_KEY).maybeSingle();
  if (error) return res.status(500).json({ error: "Não foi possível ler a situação dos calendários" });
  const status = (data && data.value) || null;
  res.json({
    now: new Date().toISOString(),
    syncing: isSyncing,
    staleAfterMin: syncStatus.STALE_AFTER_MIN,
    health: syncStatus.computeHealth(status, Date.now()),
    feeds: (status && status.feeds) || {},
  });
});

app.post("/sync", authMiddleware, adminOnly, async (req, res) => {
  const result = await runSync();
  res.json({ ok: true, ...result });
});

// ── Proxy iCal ────────────────────────────────────────────────────────────────
app.get("/proxy-ical", authMiddleware, adminOnly, async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).send("Parâmetro 'url' obrigatório");
  // Valida domínio via parse de URL — evita bypass com evil.com?x=airbnb.com
  const ALLOWED_HOSTS = ["airbnb.com", "www.airbnb.com", "www.airbnb.com.br",
                         "booking.com", "ical.booking.com", "www.booking.com"];
  let parsed;
  try { parsed = new URL(url); } catch { return res.status(400).send("URL inválida"); }
  if (!ALLOWED_HOSTS.some(h => parsed.hostname === h || parsed.hostname.endsWith("."+h)))
    return res.status(403).send("Domínio não permitido");
  if (parsed.protocol !== "https:") return res.status(403).send("Apenas HTTPS permitido");
  try {
    const text = await fetchUrl(url, 0, ALLOWED_HOSTS);
    res.setHeader("Content-Type", "text/calendar; charset=utf-8");
    res.send(text);
  } catch(e) { res.status(500).send("Erro: " + e.message); }
});

// ── Limpeza de bloqueios iCal ─────────────────────────────────────────────────
app.post("/cleanup-blocked", authMiddleware, adminOnly, async (req, res) => {
  const BLOCKED = [
    "not available", "blocked", "bloqueado", "unavailable", "indispon",
    // NÃO inclui "closed" — no Booking.com pode ser reserva real
  ];
  // Busca apenas registros do Airbnb
  const { data, error } = await supabase
    .from("reservations")
    .select("id, guest_name, source")
    .eq("source", "airbnb");
  if (error) return res.status(500).json({ error: error.message });

  const toDelete = (data||[]).filter(r => {
    const name = (r.guest_name||"").toLowerCase();
    return BLOCKED.some(b => name.includes(b));
  }).map(r => r.id);

  if (toDelete.length === 0) return res.json({ ok: true, deleted: 0 });

  const { error: delErr } = await supabase
    .from("reservations")
    .delete()
    .in("id", toDelete);

  if (delErr) return res.status(500).json({ error: delErr.message });
  res.json({ ok: true, deleted: toDelete.length });
});

// ── Estados de quarto (limpeza / check-in) ────────────────────────────────────
function todayBrasilia() {
  // UTC-3 fixo (Brasília/Londrina não usa horário de verão desde 2019)
  const d = new Date(Date.now() - 3 * 60 * 60 * 1000);
  return d.toISOString().split("T")[0];
}

// Estados do dia (limpeza / check-in), guardados em settings.room_states_<dia>.
// Antes, cada aparelho gravava as listas inteiras: a última gravação apagava as
// marcações feitas em outro aparelho (P1.4). Agora as gravações são somadas e
// feitas uma por vez (o Render roda uma instância só). A tela só marca, nunca
// desmarca, então somar é seguro. Modelo definitivo: eventos por quarto (PMS-013).
const ROOM_STATE_ROOMS = availability.ROOM_IDS;
let roomStateQueue = Promise.resolve();
function withRoomStateLock(fn) {
  const run = roomStateQueue.then(fn, fn);
  roomStateQueue = run.catch(() => {});
  return run;
}
async function readRoomStates(day) {
  const { data, error } = await supabase.from("settings")
    .select("value").eq("key", "room_states_" + day).maybeSingle();
  if (error) throw new Error("falha ao ler estados dos quartos");
  const v = data?.value || {};
  return {
    cleaned:   Array.isArray(v.cleaned)   ? v.cleaned.map(String)   : [],
    checkedIn: Array.isArray(v.checkedIn) ? v.checkedIn.map(String) : [],
  };
}
async function addRoomStates(day, add) {
  return withRoomStateLock(async () => {
    const cur = await readRoomStates(day);
    const merged = {
      cleaned:   [...new Set([...cur.cleaned,   ...add.cleaned])].sort(),
      checkedIn: [...new Set([...cur.checkedIn, ...add.checkedIn])].sort(),
    };
    const { error } = await supabase.from("settings").upsert({ key: "room_states_" + day, value: merged });
    if (error) throw new Error("falha ao gravar estados dos quartos");
    return merged;
  });
}
const onlyRooms = (list) => Array.isArray(list) ? list.map(String).filter(r => ROOM_STATE_ROOMS.includes(r)) : [];

app.get("/room-states", authMiddleware, async (req, res) => {
  res.json(await readRoomStates(todayBrasilia()));
});

// Rota antiga (aparelhos com a tela antiga em cache): soma, não substitui.
app.post("/room-states", authMiddleware, async (req, res) => {
  const { cleaned, checkedIn } = req.body || {};
  const merged = await addRoomStates(todayBrasilia(), { cleaned: onlyRooms(cleaned), checkedIn: onlyRooms(checkedIn) });
  res.json({ ok: true, ...merged });
});

// Marca um quarto: POST /room-states/24/cleaned ou /room-states/24/checkedIn
app.post("/room-states/:roomId/:kind", authMiddleware, async (req, res) => {
  const { roomId, kind } = req.params;
  if (!ROOM_STATE_ROOMS.includes(roomId) || !["cleaned", "checkedIn"].includes(kind))
    return res.status(400).json({ error: "Quarto ou tipo inválido" });
  const add = { cleaned: [], checkedIn: [] };
  add[kind].push(roomId);
  const merged = await addRoomStates(todayBrasilia(), add);
  res.json({ ok: true, ...merged });
});

app.delete("/guests/:id", authMiddleware, adminOnly, async (req, res) => {
  const { error } = await supabase.from("guests").delete().eq("id", req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// ── Transações financeiras (admin only) ───────────────────────────────────────
app.get("/transactions", authMiddleware, adminOnly, async (req, res) => {
  const { month, type } = req.query;
  // Valida parâmetros antes de enviar ao banco
  const safeMonth = (month && /^\d{4}-\d{2}$/.test(month)) ? month : null;
  const safeType  = ["income","expense"].includes(type) ? type : null;
  // Filtro por reserva: usado na edição para achar o lançamento vinculado
  // independentemente do mês carregado na tela (achado F2).
  const rid = req.query.reservation_id;
  const safeResId = (typeof rid === "string" && /^[A-Za-z0-9_-]{1,20}$/.test(rid)) ? rid : null;
  // Filtro pedido mas inválido: recusa em vez de ignorar (ignorar devolveria
  // todos os lançamentos e a tela poderia atualizar o lançamento errado).
  if (rid !== undefined && !safeResId)
    return res.status(400).json({ error: "reservation_id inválido" });
  let query = supabase.from("transactions").select("*").order("date", { ascending: false });
  if (safeMonth) query = query.eq("month", safeMonth);
  if (safeType)  query = query.eq("type",  safeType);
  if (safeResId) query = query.eq("reservation_id", safeResId);
  const { data, error } = await query.limit(500);
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

app.post("/transactions", authMiddleware, adminOnly, async (req, res) => {
  const b = req.body || {};
  const t = {
    id:             b.id || Math.random().toString(36).slice(2,10),
    type:           ["income","expense"].includes(b.type) ? b.type : "income",
    category:       String(b.category || "outro_ingresso").slice(0, 50),
    description:    String(b.description || "").slice(0, 500),
    amount:         Math.max(0, parseFloat(b.amount) || 0),
    date:           b.date || new Date().toISOString().split("T")[0],
    month:          b.month || (b.date || "").slice(0,7),
    reservation_id: b.reservation_id ? String(b.reservation_id).slice(0,20) : null,
    created_at:     new Date().toISOString(),
  };
  if (!t.month) t.month = t.date.slice(0,7);
  const { data, error } = await supabase.from("transactions").insert(t).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.put("/transactions/:id", authMiddleware, adminOnly, async (req, res) => {
  const b = req.body || {};
  const t = {
    type:        ["income","expense"].includes(b.type) ? b.type : undefined,
    category:    b.category    ? String(b.category).slice(0,50)    : undefined,
    description: b.description ? String(b.description).slice(0,500): undefined,
    amount:      b.amount !== undefined ? Math.max(0, parseFloat(b.amount)||0) : undefined,
    date:        b.date        || undefined,
    month:       b.date        ? b.date.slice(0,7) : undefined,
  };
  // Remove undefined
  Object.keys(t).forEach(k => t[k] === undefined && delete t[k]);
  const { data, error } = await supabase.from("transactions").update(t).eq("id", req.params.id).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.delete("/transactions/:id", authMiddleware, adminOnly, async (req, res) => {
  const { error } = await supabase.from("transactions").delete().eq("id", req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// ── Pré-reservas (leads / interesse de hóspedes) ─────────────────────────────
app.get("/prereservations", authMiddleware, adminOnly, async (req, res) => {
  const { data, error } = await supabase
    .from("prereservations").select("*").order("check_in");
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

app.post("/prereservations", authMiddleware, adminOnly, async (req, res) => {
  const b = req.body || {};
  const row = {
    id:         b.id || genId(),
    room_id:    String(b.roomId || "").slice(0, 10),
    guest_name: String(b.guestName || "").slice(0, 200),
    phone:      String(b.phone || "").slice(0, 30),
    check_in:   b.checkIn  || null,
    check_out:  b.checkOut || null,
    notes:      String(b.notes || "").slice(0, 2000),
    status:     ["aguardando","confirmado","recusado"].includes(b.status) ? b.status : "aguardando",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  const { data, error } = await supabase.from("prereservations").insert(row).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.put("/prereservations/:id", authMiddleware, adminOnly, async (req, res) => {
  const b = req.body || {};
  const row = {
    room_id:    b.roomId    !== undefined ? String(b.roomId).slice(0, 10)     : undefined,
    guest_name: b.guestName !== undefined ? String(b.guestName).slice(0, 200) : undefined,
    phone:      b.phone     !== undefined ? String(b.phone).slice(0, 30)      : undefined,
    check_in:   b.checkIn   !== undefined ? b.checkIn  : undefined,
    check_out:  b.checkOut  !== undefined ? b.checkOut : undefined,
    notes:      b.notes     !== undefined ? String(b.notes).slice(0, 2000)    : undefined,
    status:     b.status    !== undefined ?
      (["aguardando","confirmado","recusado"].includes(b.status) ? b.status : "aguardando") : undefined,
    updated_at: new Date().toISOString(),
  };
  Object.keys(row).forEach(k => row[k] === undefined && delete row[k]);
  const { data, error } = await supabase.from("prereservations").update(row).eq("id", req.params.id).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.delete("/prereservations/:id", authMiddleware, adminOnly, async (req, res) => {
  const { error } = await supabase.from("prereservations").delete().eq("id", req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// ── Exportação iCal do PMS (para colar no Booking e Airbnb) ──────────────────
// Rota PÚBLICA — Booking/Airbnb buscam sem autenticação
// Segurança via token secreto na URL: /calendar/:token/:roomId.ics
app.get("/calendar/:token/:roomId.ics", async (req, res) => {
  const CALENDAR_TOKEN = process.env.CALENDAR_TOKEN || "";
  if (!CALENDAR_TOKEN || !safeEqual(req.params.token, CALENDAR_TOKEN)) {
    return res.status(403).send("Acesso negado");
  }

  const roomId = req.params.roomId;
  const ALL_ROOMS = ["10","11","12","20","21","22","23","24","25","CF","11+12"];
  if (!ALL_ROOMS.includes(roomId)) {
    return res.status(404).send("Quarto não encontrado");
  }

  try {
    let query = supabase
      .from("reservations")
      .select("id, room_id, guest_name, check_in, check_out, external_uid")
      .eq("status", "confirmed");

    if (roomId === "11+12") {
      query = query.in("room_id", ["11","12"]);
    } else if (roomId !== "CF") {
      query = query.eq("room_id", roomId);
    }

    const { data, error } = await query;
    if (error) throw error;

    const now = new Date().toISOString().replace(/[-:.]/g,"").slice(0,15) + "Z";

    let cal = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      `PRODID:-//PMS Pousada//Room ${roomId}//PT`,
      "CALSCALE:GREGORIAN",
      "METHOD:PUBLISH",
      `X-WR-CALNAME:Pousada - Quarto ${roomId}`,
      "X-WR-TIMEZONE:America/Sao_Paulo",
    ];

    const seen = new Set();
    for (const r of (data || [])) {
      // Deduplica para CF e 11+12
      const key = `${r.check_in}|${r.check_out}|${r.guest_name}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const uid  = r.external_uid ? `pms-${r.external_uid}@pousada` : `pms-${r.id}@pousada`;
      const dtstart = r.check_in.replace(/-/g,"");
      const dtend   = r.check_out.replace(/-/g,"");
      // Feed vai para Airbnb/Booking: nenhum dado do hóspede (achado I6).
      const name = "Reservado";

      cal.push(
        "BEGIN:VEVENT",
        `UID:${uid}`,
        `DTSTAMP:${now}`,
        `DTSTART;VALUE=DATE:${dtstart}`,
        `DTEND;VALUE=DATE:${dtend}`,
        `SUMMARY:${name}`,
        "DESCRIPTION:Reserva via PMS Pousada",
        "STATUS:CONFIRMED",
        "END:VEVENT"
      );
    }

    cal.push("END:VCALENDAR");

    res.setHeader("Content-Type", "text/calendar; charset=utf-8");
    res.setHeader("Content-Disposition", `inline; filename="quarto-${roomId}.ics"`);
    res.setHeader("Cache-Control", "no-cache, no-store");
    res.send(cal.join("\r\n"));
  } catch(e) {
    console.error(`[calendar] falha ao gerar feed: ${e.message}`);
    res.status(500).send("Erro ao gerar calendário");
  }
});

// Lista todas as URLs de calendário (admin)
app.get("/calendar-urls", authMiddleware, adminOnly, async (req, res) => {
  const token = process.env.CALENDAR_TOKEN || "";
  if (!token) return res.status(503).json({ error: "CALENDAR_TOKEN não definido. Adicione nas variáveis de ambiente do Render." });
  const base  = process.env.ALLOWED_ORIGIN || "https://pousada-pms-209a.onrender.com";
  const rooms = ["10","11","12","20","21","22","23","24","25","11+12","CF"];
  const urls  = Object.fromEntries(rooms.map(r => [r, `${base}/calendar/${token}/${r}.ics`]));
  res.json({ urls });
});


// ── Exportação iCal (para colar no Booking e Airbnb) ─────────────────────────
// URL: /calendar/QUARTO.ics  ex: /calendar/24.ics  /calendar/all.ics
// Protegido por token opcional: ?token=ICAL_TOKEN
const ICAL_TOKEN = process.env.ICAL_TOKEN || null;

app.get("/calendar/:roomId.ics", async (req, res) => {
  if (ICAL_TOKEN && req.query.token !== ICAL_TOKEN)
    return res.status(401).send("Unauthorized");

  const roomId  = req.params.roomId;
  const ALL_ROOMS = ["10","11","12","20","21","22","23","24","25"];
  if (!ALL_ROOMS.includes(roomId) && roomId !== "all")
    return res.status(404).send("Quarto não encontrado");

  try {
    let query = supabase
      .from("reservations")
      .select("id, room_id, guest_name, check_in, check_out, status, source")
      .neq("status", "cancelled")
      .order("check_in");
    if (roomId !== "all") query = query.eq("room_id", roomId);

    const { data, error } = await query;
    if (error) return res.status(500).send("Erro ao buscar reservas");

    const now  = new Date().toISOString().replace(/[-:.]/g,"").slice(0,15) + "Z";
    const host = req.headers.host || "pousada-pms-209a.onrender.com";

    const lines = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      `PRODID:-//Pousada PMS//Quarto ${roomId}//PT`,
      "CALSCALE:GREGORIAN",
      "METHOD:PUBLISH",
      `X-WR-CALNAME:Pousada - Quarto ${roomId === "all" ? "Todos" : roomId}`,
      "X-WR-TIMEZONE:America/Sao_Paulo",
    ];

    for (const r of (data || [])) {
      const dtStart = r.check_in.replace(/-/g, "");
      const dtEnd   = r.check_out.replace(/-/g, "");
      // Não expõe nome do hóspede — apenas bloqueia a data
      const summary = `Reservado`;
      lines.push(
        "BEGIN:VEVENT",
        `UID:pms-${r.id}@${host}`,
        `DTSTAMP:${now}`,
        `DTSTART;VALUE=DATE:${dtStart}`,
        `DTEND;VALUE=DATE:${dtEnd}`,
        `SUMMARY:${summary}`,
        "STATUS:CONFIRMED",
        "TRANSP:OPAQUE",
        "END:VEVENT"
      );
    }
    lines.push("END:VCALENDAR");

    res.setHeader("Content-Type", "text/calendar; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="quarto-${roomId}.ics"`);
    res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
    res.send(lines.join("\r\n"));
  } catch(e) {
    console.error(`[calendar] falha ao gerar feed: ${e.message}`);
    res.status(500).send("Erro ao gerar calendário");
  }
});

app.use(express.static(path.join(__dirname, "build")));

// ── Fallback SPA ──────────────────────────────────────────────────────────────
app.get("*", (req, res) => {
  const idx = path.join(__dirname, "build", "index.html");
  if (fs.existsSync(idx)) res.sendFile(idx);
  else res.send("PMS Pousada — servidor OK 🏡");
});

// Tratador final de erros: registra no log e responde 500 genérico, sem
// expor detalhes internos. O processo continua no ar.
app.use((err, req, res, next) => {
  console.error(`[erro] ${req.method} ${req.path}: ${err && err.message ? err.message : err}`);
  if (res.headersSent) return next(err);
  res.status(err && err.type === "entity.parse.failed" ? 400 : 500)
     .json({ error: err && err.type === "entity.parse.failed" ? "JSON inválido" : "Erro interno" });
});

// Exporta o app para os testes; só abre a porta e agenda o sync quando
// executado diretamente (node server.js / npm start).
module.exports = {
  app, runSync,
  _setSupabaseForTests: (client) => { supabase = client; sessionCache.clear(); },
  _resetIcalStateForTests: () => icalMissingCounts.clear(),
  _resetSessionCacheForTests: () => sessionCache.clear(),
};
if (require.main === module) app.listen(PORT, "0.0.0.0", () => {
  console.log(`✅ PMS Pousada rodando na porta ${PORT}`);

  // ── Auto-sync a cada 15 minutos ──────────────────────────────────────────────
  const SYNC_INTERVAL = 15 * 60 * 1000; // 15 min
  async function autoSync() {
    const now = new Date().toLocaleTimeString("pt-BR");
    console.log(`🔄 [${now}] Auto-sync iniciando...`);
    try {
      const { added } = await runSync();
      if (added > 0) console.log(`   ✓ ${added} nova(s) reserva(s) importada(s)`);
      else            console.log(`   → Nenhuma novidade`);
    } catch(e) {
      console.error(`   ✗ Erro no auto-sync: ${e.message}`);
    }
  }

  // Executa imediatamente ao iniciar e depois a cada 15 min
  setTimeout(autoSync, 10000); // aguarda 10s para o servidor estabilizar
  setInterval(autoSync, SYNC_INTERVAL);
});
