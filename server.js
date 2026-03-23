const express = require("express");
const https   = require("https");
const http    = require("http");
const fs      = require("fs");
const path    = require("path");
const bcrypt  = require("bcryptjs");
const jwt     = require("jsonwebtoken");
const { createClient } = require("@supabase/supabase-js");

const app  = express();
const PORT       = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || "pousada-pms-secret-2024";

// Supabase
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

app.use(express.json());

// CORS — antes de qualquer rota
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin",  "*");
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
    req.user = jwt.verify(token, JWT_SECRET);
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
  const { username, password } = req.body || {};
  if (!username || !password)
    return res.status(400).json({ error: "Usuário e senha obrigatórios" });
  const { data: user } = await supabase
    .from("users").select("*").eq("username", username.toLowerCase()).single();
  if (!user) return res.status(401).json({ error: "Usuário não encontrado" });
  const valid = await bcrypt.compare(password, user.password_hash);
  if (!valid) return res.status(401).json({ error: "Senha incorreta" });
  const token = jwt.sign(
    { userId: user.id, role: user.role, username: user.username },
    JWT_SECRET, { expiresIn: "30d" }
  );
  res.json({ token, role: user.role, username: user.username });
});

// ── Setup inicial (só funciona se não existir nenhum usuário) ─────────────────
app.post("/setup-users", async (req, res) => {
  const { data: existing } = await supabase.from("users").select("id").limit(1);
  if (existing && existing.length > 0)
    return res.status(403).json({ error: "Usuários já configurados" });
  const { adminPass, staffPass } = req.body || {};
  if (!adminPass || !staffPass)
    return res.status(400).json({ error: "adminPass e staffPass obrigatórios" });
  const genId = () => Math.random().toString(36).slice(2,10);
  const adminHash = await bcrypt.hash(adminPass, 10);
  const staffHash = await bcrypt.hash(staffPass, 10);
  await supabase.from("users").insert([
    { id: genId(), username: "admin",  password_hash: adminHash, role: "admin" },
    { id: genId(), username: "staff",  password_hash: staffHash, role: "staff" },
  ]);
  res.json({ ok: true, message: "Usuários criados: admin e staff" });
});

// ── Mudar senha ───────────────────────────────────────────────────────────────
app.post("/change-password", authMiddleware, async (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
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
  const q = req.query.q || "";
  let query = supabase.from("guests").select("*").order("name");
  if (q.trim()) {
    query = query.or(
      `name.ilike.%${q}%,phone.ilike.%${q}%,cpf.ilike.%${q}%,email.ilike.%${q}%`
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
  const g = req.body;
  if (!g.id) g.id = Math.random().toString(36).slice(2,10);
  g.updated_at = new Date().toISOString();
  if (!g.created_at) g.created_at = new Date().toISOString();
  const { data, error } = await supabase.from("guests").upsert(g).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.put("/guests/:id", authMiddleware, async (req, res) => {
  const g = { ...req.body, updated_at: new Date().toISOString() };
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
    const c = s.replace(/[TZ]/g, "").slice(0, 8);
    return `${c.slice(0,4)}-${c.slice(4,6)}-${c.slice(6,8)}`;
  };
  for (let i = 1; i < blocks.length; i++) {
    const b   = blocks[i];
    const get = (k) => { const m = b.match(new RegExp(k + "[^:]*:(.+)")); return m ? m[1].trim() : ""; };
    const dtstart = get("DTSTART"), dtend = get("DTEND"), summary = get("SUMMARY"), uid = get("UID");
    if (!dtstart || !dtend) continue;
    // Só ignora bloqueios se for Airbnb — no Booking "Closed" pode ser reserva real
    if (source === "airbnb" && isAirbnbBlock(summary, uid)) continue;
    events.push({ uid, summary, checkIn: parseDate(dtstart), checkOut: parseDate(dtend) });
  }
  return events;
}

function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith("https") ? https : http;
    let body = "";
    lib.get(url, { headers: { "User-Agent": "Mozilla/5.0 (PMS-Pousada/1.0)" } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchUrl(res.headers.location).then(resolve).catch(reject);
      }
      res.on("data", d => body += d);
      res.on("end",  () => resolve(body));
    }).on("error", reject);
  });
}

function genId() { return Math.random().toString(36).slice(2, 10); }

// Health check
app.get("/healthz", (req, res) => res.json({ ok: true, ts: new Date().toISOString() }));

// ── Reservas ──────────────────────────────────────────────────────────────────
app.get("/reservations", authMiddleware, async (req, res) => {
  const { data, error } = await supabase.from("reservations").select("*").order("check_in");
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.post("/reservations", authMiddleware, async (req, res) => {
  const b = req.body;
  if (b.externalUid) {
    const { data: exists } = await supabase.from("reservations").select("id").eq("external_uid", b.externalUid).single();
    if (exists) return res.json({ ok: false, reason: "duplicate" });
  }
  const row = {
    id:           b.id || genId(),
    room_id:      b.roomId,
    guest_name:   b.guestName,
    check_in:     b.checkIn,
    check_out:    b.checkOut,
    source:       b.source    || "direto",
    adults:       b.adults    || 2,
    children:     b.children  || 0,
    phone:        b.phone     || "",
    notes:        b.notes     || "",
    status:       b.status    || "confirmed",
    external_uid: b.externalUid || null,
    created_at:   b.createdAt   || new Date().toISOString(),
  };
  const { data, error } = await supabase.from("reservations").insert(row).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true, reservation: data });
});

app.put("/reservations/:id", authMiddleware, async (req, res) => {
  const b   = req.body;
  const row = {};
  if (b.roomId)     row.room_id    = b.roomId;
  if (b.guestName)  row.guest_name = b.guestName;
  if (b.checkIn)    row.check_in   = b.checkIn;
  if (b.checkOut)   row.check_out  = b.checkOut;
  if (b.source)     row.source     = b.source;
  if (b.adults  !== undefined) row.adults   = b.adults;
  if (b.children!== undefined) row.children = b.children;
  if (b.phone   !== undefined) row.phone    = b.phone;
  if (b.notes   !== undefined) row.notes    = b.notes;
  if (b.status)     row.status     = b.status;
  const { error } = await supabase.from("reservations").update(row).eq("id", req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

app.delete("/reservations/:id", authMiddleware, async (req, res) => {
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
  await supabase.from("settings").upsert({ key: "ical_urls", value: req.body });
  res.json({ ok: true });
});

// ── Sincronização iCal ────────────────────────────────────────────────────────
async function runSync() {
  const { data: settingRow } = await supabase.from("settings").select("value").eq("key", "ical_urls").single();
  const icalUrls = settingRow?.value || { booking: {}, airbnb: {} };
  const log = ["⏳ Iniciando sincronização..."];
  let added = 0;

  for (const [source, urls] of Object.entries(icalUrls)) {
    for (const [roomId, url] of Object.entries(urls || {})) {
      if (!url) continue;
      log.push(`🔍 ${source} — Quarto ${roomId}`);
      try {
        const text = await fetchUrl(url);
        if (!text.includes("BEGIN:VCALENDAR")) { log.push(`   ⚠️ Resposta inválida`); continue; }
        const evts = parseIcal(text, source);
        log.push(`   → ${evts.length} reserva(s) encontrada(s)`);
        for (const ev of evts) {
          const ALL_ROOMS = ["10","11","12","20","21","22","23","24","25"];
          const targetRooms = roomId === "CF"    ? ALL_ROOMS
                            : roomId === "11+12" ? ["11","12"]
                            : [roomId];

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
            log.push(`   ✓ Qto ${targetRoom} — ${ev.summary || "Reserva"} (${ev.checkIn} → ${ev.checkOut})`);
            added++;
          }
        }
      } catch(e) { log.push(`   ✗ Erro: ${e.message}`); }
    }
  }

  log.push(`✅ Concluído — ${added} nova(s) reserva(s)`);
  return { log, added };
}

app.post("/sync", authMiddleware, adminOnly, async (req, res) => {
  const result = await runSync();
  res.json({ ok: true, ...result });
});

// ── Proxy iCal ────────────────────────────────────────────────────────────────
app.get("/proxy-ical", authMiddleware, adminOnly, async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).send("Parâmetro 'url' obrigatório");
  const allowed = ["airbnb.com", "booking.com", "ical.booking.com", "airbnb.com.br"];
  if (!allowed.some(d => url.includes(d))) return res.status(403).send("Domínio não permitido");
  try {
    const text = await fetchUrl(url);
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
app.get("/room-states", authMiddleware, async (req, res) => {
  const today = new Date().toISOString().split("T")[0];
  const { data } = await supabase.from("settings")
    .select("value").eq("key", "room_states_"+today).single();
  res.json(data?.value || { cleaned: [], checkedIn: [] });
});

app.post("/room-states", authMiddleware, async (req, res) => {
  const today = new Date().toISOString().split("T")[0];
  const { cleaned, checkedIn } = req.body || {};
  await supabase.from("settings").upsert({
    key: "room_states_"+today,
    value: { cleaned: cleaned||[], checkedIn: checkedIn||[] }
  });
  res.json({ ok: true });
});

app.delete("/guests/:id", authMiddleware, async (req, res) => {
  const { error } = await supabase.from("guests").delete().eq("id", req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// ── Transações financeiras (admin only) ───────────────────────────────────────
app.get("/transactions", authMiddleware, adminOnly, async (req, res) => {
  const { month, type } = req.query;
  let query = supabase.from("transactions").select("*").order("date", { ascending: false });
  if (month) query = query.eq("month", month);
  if (type)  query = query.eq("type", type);
  const { data, error } = await query.limit(500);
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

app.post("/transactions", authMiddleware, adminOnly, async (req, res) => {
  const t = req.body;
  if (!t.id)    t.id = Math.random().toString(36).slice(2,10);
  if (!t.month) t.month = (t.date || "").slice(0,7);
  t.created_at = new Date().toISOString();
  const { data, error } = await supabase.from("transactions").insert(t).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.put("/transactions/:id", authMiddleware, adminOnly, async (req, res) => {
  const t = { ...req.body };
  if (t.date) t.month = t.date.slice(0,7);
  const { data, error } = await supabase.from("transactions").update(t).eq("id", req.params.id).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.delete("/transactions/:id", authMiddleware, adminOnly, async (req, res) => {
  const { error } = await supabase.from("transactions").delete().eq("id", req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// ── Arquivos estáticos (DEPOIS das rotas de API) ───────────────────────────────
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
