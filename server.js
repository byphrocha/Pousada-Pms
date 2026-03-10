const express = require("express");
const https   = require("https");
const http    = require("http");
const path    = require("path");
const { createClient } = require("@supabase/supabase-js");

const app  = express();
const PORT = process.env.PORT || 3000;

// ─── Supabase ─────────────────────────────────────────────────────────────────
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

app.use(express.json());
app.use(express.static(path.join(__dirname, "build")));

// CORS
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin",  "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// ─── Utilitários iCal ─────────────────────────────────────────────────────────
function parseIcal(text) {
  const events = [];
  const blocks  = text.split("BEGIN:VEVENT");
  const parseDate = (s) => {
    const c = s.replace(/[TZ]/g, "").slice(0, 8);
    return `${c.slice(0,4)}-${c.slice(4,6)}-${c.slice(6,8)}`;
  };
  for (let i = 1; i < blocks.length; i++) {
    const b   = blocks[i];
    const get = (k) => { const m = b.match(new RegExp(k + "[^:]*:([^\r\n]+")); return m ? m[1].trim() : ""; };
    const dtstart = get("DTSTART"), dtend = get("DTEND"), summary = get("SUMMARY"), uid = get("UID");
    if (dtstart && dtend) events.push({ uid, summary, checkIn: parseDate(dtstart), checkOut: parseDate(dtend) });
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

// ─── Health check (mantém servidor acordado no Render) ────────────────────────
app.get("/healthz", (req, res) => res.json({ ok: true, ts: new Date().toISOString() }));

// ─── Reservas ─────────────────────────────────────────────────────────────────
app.get("/reservations", async (req, res) => {
  const { data, error } = await supabase.from("reservations").select("*").order("check_in");
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.post("/reservations", async (req, res) => {
  const b = req.body;
  // Evitar duplicata por externalUid
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
    source:       b.source || "direto",
    adults:       b.adults || 2,
    children:     b.children || 0,
    phone:        b.phone || "",
    notes:        b.notes || "",
    status:       b.status || "confirmed",
    external_uid: b.externalUid || null,
    created_at:   b.createdAt || new Date().toISOString(),
  };
  const { data, error } = await supabase.from("reservations").insert(row).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true, reservation: data });
});

app.put("/reservations/:id", async (req, res) => {
  const b = req.body;
  const row = {
    room_id:    b.roomId,
    guest_name: b.guestName,
    check_in:   b.checkIn,
    check_out:  b.checkOut,
    source:     b.source,
    adults:     b.adults,
    children:   b.children,
    phone:      b.phone,
    notes:      b.notes,
    status:     b.status,
  };
  const { error } = await supabase.from("reservations").update(row).eq("id", req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

app.delete("/reservations/:id", async (req, res) => {
  const { error } = await supabase.from("reservations").delete().eq("id", req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// ─── URLs iCal ────────────────────────────────────────────────────────────────
app.get("/urls", async (req, res) => {
  const { data } = await supabase.from("settings").select("value").eq("key", "ical_urls").single();
  res.json(data?.value || { booking: {}, airbnb: {} });
});

app.post("/urls", async (req, res) => {
  await supabase.from("settings").upsert({ key: "ical_urls", value: req.body });
  res.json({ ok: true });
});

// ─── Sincronização iCal ───────────────────────────────────────────────────────
app.post("/sync", async (req, res) => {
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
        const evts = parseIcal(text);
        log.push(`   → ${evts.length} evento(s)`);
        for (const ev of evts) {
          const uid = `${source}-${roomId}-${ev.uid}`;
          const { data: exists } = await supabase.from("reservations").select("id").eq("external_uid", uid).single();
          if (exists) continue;
          await supabase.from("reservations").insert({
            id: genId(), room_id: roomId, external_uid: uid, status: "confirmed",
            guest_name:  ev.summary || `${source} reserva`,
            check_in:    ev.checkIn, check_out: ev.checkOut,
            source, adults: 2, children: 0, phone: "",
            notes: "Importado via iCal", created_at: new Date().toISOString(),
          });
          log.push(`   ✓ ${ev.summary || "Reserva"} (${ev.checkIn} → ${ev.checkOut})`);
          added++;
        }
      } catch(e) { log.push(`   ✗ Erro: ${e.message}`); }
    }
  }

  log.push(`✅ Concluído — ${added} nova(s) reserva(s)`);
  res.json({ ok: true, log, added });
});

// ─── Proxy iCal ───────────────────────────────────────────────────────────────
app.get("/proxy-ical", async (req, res) => {
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

// ─── Fallback SPA ─────────────────────────────────────────────────────────────
app.get("*", (req, res) => {
  const idx = path.join(__dirname, "build", "index.html");
  const fs  = require("fs");
  if (fs.existsSync(idx)) res.sendFile(idx);
  else res.send("PMS Pousada — servidor OK 🏡");
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`✅ PMS Pousada rodando na porta ${PORT}`);
});
