const express  = require("express");
const https    = require("https");
const http     = require("http");
const fs       = require("fs");
const path     = require("path");

const app  = express();
const PORT = process.env.PORT || 3000;

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

// ─── Persistência ────────────────────────────────────────────────────────────────
const DATA_FILE = path.join(__dirname, "data.json");

function readData() {
  try {
    if (fs.existsSync(DATA_FILE)) return JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
  } catch {}
  return { reservations: [], icalUrls: { booking: {}, airbnb: {} } };
}
function writeData(data) {
  try { fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2)); }
  catch (e) { console.error("Erro ao salvar:", e); }
}

// ─── Utilitários iCal ────────────────────────────────────────────────────────────
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
      // Segue redirecionamentos
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchUrl(res.headers.location).then(resolve).catch(reject);
      }
      res.on("data", d => body += d);
      res.on("end",  () => resolve(body));
    }).on("error", reject);
  });
}

function genId() { return Math.random().toString(36).slice(2, 10); }

// ─── Reservas ────────────────────────────────────────────────────────────────────
app.get("/reservations", (req, res) => {
  res.json(readData().reservations);
});

app.post("/reservations", (req, res) => {
  const data = readData();
  const r    = { ...req.body, id: req.body.id || genId(), createdAt: req.body.createdAt || new Date().toISOString() };
  if (r.externalUid && data.reservations.find(x => x.externalUid === r.externalUid)) {
    return res.json({ ok: false, reason: "duplicate" });
  }
  data.reservations.push(r);
  writeData(data);
  res.json({ ok: true, reservation: r });
});

app.put("/reservations/:id", (req, res) => {
  const data = readData();
  const idx  = data.reservations.findIndex(r => r.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: "not found" });
  data.reservations[idx] = { ...data.reservations[idx], ...req.body };
  writeData(data);
  res.json({ ok: true });
});

app.delete("/reservations/:id", (req, res) => {
  const data = readData();
  data.reservations = data.reservations.filter(r => r.id !== req.params.id);
  writeData(data);
  res.json({ ok: true });
});

// ─── URLs iCal ───────────────────────────────────────────────────────────────────
app.get("/urls", (req, res) => {
  const data = readData();
  res.json(data.icalUrls || { booking: {}, airbnb: {} });
});

app.post("/urls", (req, res) => {
  const data = readData();
  data.icalUrls = req.body;
  writeData(data);
  res.json({ ok: true });
});

// ─── Sincronização iCal ───────────────────────────────────────────────────────────
app.post("/sync", async (req, res) => {
  const data = readData();
  const log  = ["⏳ Iniciando sincronização..."];
  let added  = 0;

  for (const [source, urls] of Object.entries(data.icalUrls || {})) {
    for (const [roomId, url] of Object.entries(urls || {})) {
      if (!url) continue;
      log.push(`🔍 ${source} — Quarto ${roomId}`);
      try {
        const text = await fetchUrl(url);
        if (!text.includes("BEGIN:VCALENDAR")) {
          log.push(`   ⚠️ Resposta inválida (não é iCal)`);
          continue;
        }
        const evts = parseIcal(text);
        log.push(`   → ${evts.length} evento(s)`);
        for (const ev of evts) {
          const uid = `${source}-${roomId}-${ev.uid}`;
          if (data.reservations.find(r => r.externalUid === uid)) continue;
          data.reservations.push({
            id: genId(), roomId, externalUid: uid, status: "confirmed",
            guestName:  ev.summary || `${source} reserva`,
            checkIn:    ev.checkIn, checkOut: ev.checkOut,
            source, adults: 2, children: 0, phone: "",
            notes: "Importado via iCal", createdAt: new Date().toISOString(),
          });
          log.push(`   ✓ ${ev.summary || "Reserva"} (${ev.checkIn} → ${ev.checkOut})`);
          added++;
        }
      } catch(e) {
        log.push(`   ✗ Erro: ${e.message}`);
      }
    }
  }

  writeData(data);
  log.push(`✅ Concluído — ${added} nova(s) reserva(s) importada(s)`);
  res.json({ ok: true, log, added });
});

// ─── Proxy iCal (teste pontual) ────────────────────────────────────────────────────
app.get("/proxy-ical", async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).send("Parâmetro 'url' obrigatório");
  const allowed = ["airbnb.com", "booking.com", "ical.booking.com", "airbnb.com.br"];
  if (!allowed.some(d => url.includes(d))) return res.status(403).send("Domínio não permitido");
  try {
    const text = await fetchUrl(url);
    res.setHeader("Content-Type", "text/calendar; charset=utf-8");
    res.send(text);
  } catch(e) {
    res.status(500).send("Erro: " + e.message);
  }
});

// ─── Fallback SPA ─────────────────────────────────────────────────────────────────
app.get("*", (req, res) => {
  const idx = path.join(__dirname, "build", "index.html");
  if (fs.existsSync(idx)) res.sendFile(idx);
  else res.send("PMS Pousada — servidor OK 🏡");
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`✅ PMS Pousada rodando na porta ${PORT}`);
});
