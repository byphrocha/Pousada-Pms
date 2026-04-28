const express  = require("express");
const crypto   = require("crypto");
const https    = require("https");
const dns      = require("dns").promises;
const fs       = require("fs");
const path     = require("path");
const bcrypt   = require("bcryptjs");
const jwt      = require("jsonwebtoken");
const { createClient } = require("@supabase/supabase-js");

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
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

app.use(express.json({ limit: "256kb" })); // previne DoS via payload gigante

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
setInterval(() => {
  const cut = Date.now() - 15 * 60 * 1000;
  for (const [ip, times] of loginAttempts) {
    const fresh = times.filter(t => t > cut);
    if (fresh.length === 0) loginAttempts.delete(ip);
    else loginAttempts.set(ip, fresh);
  }
}, 30 * 60 * 1000);

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
function authMiddleware(req, res, next) {
  const token = (req.headers.authorization || "").split(" ")[1];
  if (!token) return res.status(401).json({ error: "Não autorizado" });
  try {
    req.user = jwt.verify(token, JWT_SECRET, { algorithms: ["HS256"] });
    next();
  } catch { return res.status(401).json({ error: "Token inválido ou expirado" }); }
}

function adminOnly(req, res, next) {
  if (req.user?.role !== "admin")
    return res.status(403).json({ error: "Acesso restrito ao administrador" });
  next();
}

// ── Login ─────────────────────────────────────────────────────────────────────
app.post("/login", async (req, res) => {
  const rawIp = req.headers["x-forwarded-for"] || req.socket.remoteAddress || "unknown";
  const ip = String(rawIp).split(",")[0].trim();
  if (!checkLoginRate(ip))
    return res.status(429).json({ error: "Muitas tentativas. Aguarde 15 minutos." });
  const { username, password } = req.body || {};
  if (!username || !password)
    return res.status(400).json({ error: "Usuário e senha obrigatórios" });
  const { data: user } = await supabase
    .from("users").select("*").eq("username", username.toLowerCase()).single();
  if (!user) return res.status(401).json({ error: "Credenciais inválidas" });
  const valid = await bcrypt.compare(password, user.password_hash);
  if (!valid) return res.status(401).json({ error: "Credenciais inválidas" });
  const token = jwt.sign(
    { userId: user.id, role: user.role, username: user.username },
    JWT_SECRET, { expiresIn: "30d", algorithm: "HS256" }
  );
  res.json({ token, role: user.role, username: user.username });
});

// ── Setup inicial — DESABILITADO EM PRODUÇÃO ──────────────────────────────────
// Para criar usuários pela primeira vez, descomente temporariamente esta rota,
// faça POST /setup-users com { adminPass, staffPass }, depois comente de volta.
// app.post("/setup-users", async (req, res) => { ... });

// ── Mudar senha ───────────────────────────────────────────────────────────────
app.post("/change-password", authMiddleware, async (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (!currentPassword || !newPassword)
    return res.status(400).json({ error: "Campos obrigatórios" });
  if (newPassword.length < 6)
    return res.status(400).json({ error: "Nova senha deve ter ao menos 6 caracteres" });
  const { data: user } = await supabase
    .from("users").select("*").eq("id", req.user.userId).single();
  if (!user) return res.status(404).json({ error: "Usuário não encontrado" });
  const valid = await bcrypt.compare(currentPassword, user.password_hash);
  if (!valid) return res.status(401).json({ error: "Senha atual incorreta" });
  const hash = await bcrypt.hash(newPassword, 10);
  await supabase.from("users").update({ password_hash: hash }).eq("id", user.id);
  res.json({ ok: true });
});

// ── Hóspedes ──────────────────────────────────────────────────────────────────
app.get("/guests", authMiddleware, async (req, res) => {
  const q = (req.query.q || "").slice(0, 100); // limite de tamanho
  let query = supabase.from("guests").select("*").order("name");
  if (q.trim()) {
    // Escapa % e _ para evitar wildcard abuse no ilike
    const safe = q.replace(/[%_\\]/g, c => "\\" + c);
    query = query.or(
      `name.ilike.%${safe}%,phone.ilike.%${safe}%,cpf.ilike.%${safe}%,email.ilike.%${safe}%`
    );
  }
  const { data, error } = await query.limit(50);
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

app.get("/guests/:id", authMiddleware, async (req, res) => {
  const { data } = await supabase.from("guests").select("*").eq("id", req.params.id).single();
  res.json(data || null);
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
  const { data, error } = await supabase.from("guests").upsert(g).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
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
  const { data, error } = await supabase.from("guests").update(g).eq("id", req.params.id).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// Utilitários iCal
const AIRBNB_BLOCKED = [
  /not available/i, /^blocked$/i, /unavailable/i,
  /bloqueado/i, /indispon/i,
];

function isAirbnbBlock(summary, uid) {
  if (AIRBNB_BLOCKED.some(p => p.test(summary||""))) return true;
  if (/CLOSED|BLOCK/i.test(uid||"") && !summary) return true;
  return false;
}

function parseIcal(text, source) {
  const events = [];
  const blocks  = text.split("BEGIN:VEVENT");
  const parseDate = (s) => {
    if (!s) return null;
    const c = String(s).replace(/[^0-9]/g, "").slice(0, 8);
    if (c.length !== 8) return null;
    return `${c.slice(0,4)}-${c.slice(4,6)}-${c.slice(6,8)}`;
  };
  
  for (let i = 1; i < blocks.length; i++) {
    const b = blocks[i];
    // Extrai de forma mais robusta com split por newlines
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
    
    if (!dtstart || !dtend) continue;
    // Ignora bloqueios do Airbnb (indisponibilidades, não reservas)
    if (source === "airbnb" && isAirbnbBlock(summary, uid)) continue;
    events.push({ uid, summary, checkIn: dtstart, checkOut: dtend });
  }
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

function genId() { return crypto.randomBytes(6).toString("hex"); } // 12 chars hex, criptográfico

// Lock para evitar syncs simultâneos (auto-sync + POST /sync)
let isSyncing = false;

// Valida formato YYYY-MM-DD
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
function isValidDate(s) {
  if (!DATE_RE.test(s)) return false;
  const d = new Date(s + "T12:00:00Z");
  return !isNaN(d.getTime());
}


// Health check
app.get("/healthz", (req, res) => res.json({ ok: true, ts: new Date().toISOString() }));

// ── Reservas ──────────────────────────────────────────────────────────────────
app.get("/reservations", authMiddleware, async (req, res) => {
  const { data, error } = await supabase.from("reservations").select("*").order("check_in");
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
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
  if (b.externalUid) {
    const { data: exists } = await supabase.from("reservations").select("id").eq("external_uid", b.externalUid).single();
    if (exists) return res.json({ ok: false, reason: "duplicate" });
  }
  const row = {
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
  const { data, error } = await supabase.from("reservations").insert(row).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true, reservation: data });
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
  const { error } = await supabase.from("reservations").update(row).eq("id", req.params.id);
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

async function runSync() {
  if (isSyncing) return { log: ["⚠️ Sincronização já em andamento, aguarde."], added: 0 };
  isSyncing = true;
  const { data: settingRow } = await supabase.from("settings").select("value").eq("key", "ical_urls").single();
  const icalUrls = settingRow?.value || { booking: {}, airbnb: {} };
  const log = ["⏳ Iniciando sincronização..."];
  let added = 0;
  let cancelled = 0;
  try {

  for (const [source, urls] of Object.entries(icalUrls)) {
    for (const [roomId, url] of Object.entries(urls || {})) {
      if (!url) continue;
      log.push(`🔍 ${source} — Quarto ${roomId}`);
      try {
        const text = await fetchUrl(url, 0, ICAL_ALLOWED_HOSTS);
        if (!text.includes("BEGIN:VCALENDAR")) { log.push(`   ⚠️ Resposta inválida`); continue; }
        const evts = parseIcal(text, source);
        log.push(`   → ${evts.length} reserva(s) no feed`);

        const ALL_ROOMS = ["10","11","12","20","21","22","23","24","25"];
        const targetRooms = roomId === "CF"    ? ALL_ROOMS
                          : roomId === "11+12" ? ["11","12"]
                          : [roomId];

        // ── Conjunto de UIDs ativos neste feed ──────────────────────────────
        const activeUids = new Set();
        for (const ev of evts) {
          for (const targetRoom of targetRooms) {
            activeUids.add(`${source}-${targetRoom}-${ev.uid}`);
          }
        }

        // ── RECONCILIAÇÃO: cancela reservas do banco que sumiram do feed ────
        // Busca todas as reservas confirmadas importadas deste source+quartos
        const roomFilter = targetRooms;
        const { data: existing } = await supabase
          .from("reservations")
          .select("id, external_uid, guest_name, check_in")
          .eq("source", source)
          .eq("status", "confirmed")
          .in("room_id", roomFilter)
          .not("external_uid", "is", null);

        const toCancel = (existing || []).filter(r =>
          r.external_uid &&
          r.external_uid.startsWith(`${source}-`) &&
          !activeUids.has(r.external_uid)
        );

        for (const r of toCancel) {
          await supabase.from("reservations")
            .update({ status: "cancelled" })
            .eq("id", r.id);
          log.push(`   ✗ Cancelado: Qto ${roomFilter[0] === r.external_uid.split("-")[2] ? roomFilter[0] : "?"} — ${r.guest_name} (${r.check_in}) — sumiu do feed`);
          cancelled++;
        }

        // ── ADIÇÃO: insere reservas novas que ainda não estão no banco ──────
        for (const ev of evts) {
          for (const targetRoom of targetRooms) {
            const roomUid = `${source}-${targetRoom}-${ev.uid}`;
            const { data: exists } = await supabase.from("reservations").select("id").eq("external_uid", roomUid).single();
            if (exists) continue;
            await supabase.from("reservations").insert({
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
            log.push(`   ✓ Novo: Qto ${targetRoom} — ${ev.summary || "Reserva"} (${ev.checkIn} → ${ev.checkOut})`);
            added++;
          }
        }
      } catch(e) { log.push(`   ✗ Erro: ${e.message}`); }
    }
  }

  const parts = [];
  if (added)     parts.push(`${added} nova(s)`);
  if (cancelled) parts.push(`${cancelled} cancelada(s)`);
  log.push(`✅ Concluído${parts.length ? ` — ${parts.join(", ")}` : " — nenhuma novidade"}`);
  return { log, added, cancelled };
  } finally { isSyncing = false; }
}

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

app.get("/room-states", authMiddleware, async (req, res) => {
  const today = todayBrasilia();
  const { data } = await supabase.from("settings")
    .select("value").eq("key", "room_states_"+today).single();
  res.json(data?.value || { cleaned: [], checkedIn: [] });
});

app.post("/room-states", authMiddleware, async (req, res) => {
  const today = todayBrasilia();
  const { cleaned, checkedIn } = req.body || {};
  const VALID_ROOMS = ["10","11","12","20","21","22","23","24","25"];
  // Valida que são arrays e contêm apenas IDs de quartos conhecidos
  const safeClean = Array.isArray(cleaned)
    ? cleaned.filter(r => VALID_ROOMS.includes(String(r))) : [];
  const safeCheckedIn = Array.isArray(checkedIn)
    ? checkedIn.filter(r => VALID_ROOMS.includes(String(r))) : [];
  await supabase.from("settings").upsert({
    key: "room_states_"+today,
    value: { cleaned: safeClean, checkedIn: safeCheckedIn }
  });
  res.json({ ok: true });
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
  let query = supabase.from("transactions").select("*").order("date", { ascending: false });
  if (safeMonth) query = query.eq("month", safeMonth);
  if (safeType)  query = query.eq("type",  safeType);
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
  if (!CALENDAR_TOKEN || req.params.token !== CALENDAR_TOKEN) {
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
      // Anonimiza parcialmente — não vaza nome completo
      const name = r.guest_name
        ? r.guest_name.split(" ")[0] + " (reservado)"
        : "Reservado";

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
    res.status(500).send("Erro: " + e.message);
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
    res.status(500).send("Erro: " + e.message);
  }
});

app.use(express.static(path.join(__dirname, "build")));

// ── Fallback SPA ──────────────────────────────────────────────────────────────
app.get("*", (req, res) => {
  const idx = path.join(__dirname, "build", "index.html");
  if (fs.existsSync(idx)) res.sendFile(idx);
  else res.send("PMS Pousada — servidor OK 🏡");
});

app.listen(PORT, "0.0.0.0", () => {
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
