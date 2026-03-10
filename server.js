const express  = require("express");
const cors     = require("cors");
const cron     = require("node-cron");
const fs       = require("fs");
const https    = require("https");
const http     = require("http");

const app      = express();
const PORT     = process.env.PORT || 3000;
const DATA_FILE = "./data.json";

app.use(cors());
app.use(express.json());

// ─── Persistent storage ───────────────────────────────────────────────────────
let data = {
  urls: { booking: {}, airbnb: {} },
  reservations: [],
  lastSync: null,
  syncLog: [],
};

function loadData() {
  if (fs.existsSync(DATA_FILE)) {
    try {
      data = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
      console.log("✅ Dados carregados:", data.reservations.length, "reservas");
    } catch (e) {
      console.error("Erro ao carregar dados:", e.message);
    }
  }
}

function saveData() {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

// ─── iCal parser ─────────────────────────────────────────────────────────────
function parseIcal(text) {
  const events = [];
  const blocks = text.split("BEGIN:VEVENT");

  const parseDate = (s) => {
    const clean = s.replace(/[TZ\r\n]/g, "").slice(0, 8);
    return `${clean.slice(0,4)}-${clean.slice(4,6)}-${clean.slice(6,8)}`;
  };

  for (let i = 1; i < blocks.length; i++) {
    const b   = blocks[i];
    const get = (key) => {
      const m = b.match(new RegExp(key + "[^:]*:([^\r\n]+)"));
      return m ? m[1].trim() : "";
    };
    const dtstart = get("DTSTART");
    const dtend   = get("DTEND");
    const summary = get("SUMMARY");
    const uid     = get("UID");
    if (dtstart && dtend) {
      events.push({
        uid:     uid || `evt-${i}`,
        summary: summary || "Reserva",
        checkIn:  parseDate(dtstart),
        checkOut: parseDate(dtend),
      });
    }
  }
  return events;
}

// ─── HTTP fetch (no external deps) ───────────────────────────────────────────
function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith("https") ? https : http;
    const req = lib.get(url, { timeout: 15000 }, (res) => {
      // Follow redirects
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchUrl(res.headers.location).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => resolve(body));
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("Timeout")); });
  });
}

// ─── Core sync function ───────────────────────────────────────────────────────
async function syncAll() {
  const log = [`🔄 Sincronização iniciada: ${new Date().toLocaleString("pt-BR")}`];
  let added = 0;

  for (const [source, rooms] of Object.entries(data.urls)) {
    for (const [roomId, url] of Object.entries(rooms)) {
      if (!url) continue;
      log.push(`\n📌 ${source} – Quarto ${roomId}`);
      try {
        const text = await fetchUrl(url);
        if (!text.includes("BEGIN:VCALENDAR")) {
          log.push("   ⚠️ URL não retornou iCal válido");
          continue;
        }
        const events = parseIcal(text);
        log.push(`   → ${events.length} evento(s) encontrado(s)`);

        for (const ev of events) {
          const uid = `${source}-${roomId}-${ev.uid}`;
          const exists = data.reservations.find((r) => r.externalUid === uid);
          if (!exists) {
            data.reservations.push({
              id:          `srv-${Date.now()}-${Math.random().toString(36).slice(2,6)}`,
              roomId,
              externalUid: uid,
              status:      "confirmed",
              guestName:   ev.summary,
              checkIn:     ev.checkIn,
              checkOut:    ev.checkOut,
              source,
              adults:      2,
              children:    0,
              phone:       "",
              notes:       "Importado automaticamente via servidor",
              createdAt:   new Date().toISOString(),
            });
            log.push(`   ✓ ${ev.summary} (${ev.checkIn} → ${ev.checkOut})`);
            added++;
          }
        }
      } catch (e) {
        log.push(`   ✗ Erro: ${e.message}`);
      }
    }
  }

  data.lastSync = new Date().toISOString();
  data.syncLog  = log;
  saveData();
  console.log(`✅ Sync concluído — ${added} nova(s) reserva(s)`);
  return { log, added };
}

// ─── Routes ───────────────────────────────────────────────────────────────────

// Health check
app.get("/", (req, res) => {
  res.json({
    status:    "online",
    pms:       "Pousada PMS Server",
    lastSync:  data.lastSync,
    reservas:  data.reservations.filter(r => r.status !== "cancelled").length,
  });
});

// GET all reservations
app.get("/reservations", (req, res) => {
  res.json(data.reservations);
});

// POST create/update reservation
app.post("/reservations", (req, res) => {
  const r = req.body;
  if (!r.id) {
    r.id = `m-${Date.now()}`;
    r.createdAt = new Date().toISOString();
    data.reservations.push(r);
  } else {
    const idx = data.reservations.findIndex(x => x.id === r.id);
    if (idx >= 0) data.reservations[idx] = r;
    else data.reservations.push(r);
  }
  saveData();
  res.json({ ok: true, reservation: r });
});

// DELETE / cancel reservation
app.delete("/reservations/:id", (req, res) => {
  const idx = data.reservations.findIndex(x => x.id === req.params.id);
  if (idx >= 0) {
    data.reservations[idx].status = "cancelled";
    saveData();
    res.json({ ok: true });
  } else {
    res.status(404).json({ error: "Não encontrada" });
  }
});

// GET iCal URLs
app.get("/urls", (req, res) => {
  res.json(data.urls);
});

// POST save iCal URLs
app.post("/urls", (req, res) => {
  data.urls = req.body;
  saveData();
  res.json({ ok: true });
});

// POST trigger manual sync
app.post("/sync", async (req, res) => {
  try {
    const result = await syncAll();
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET last sync log
app.get("/sync/log", (req, res) => {
  res.json({ lastSync: data.lastSync, log: data.syncLog });
});

// ─── Cron: sync every hour ────────────────────────────────────────────────────
cron.schedule("0 * * * *", () => {
  console.log("⏰ Sync automático (a cada hora)");
  syncAll();
});

// ─── Start ────────────────────────────────────────────────────────────────────
loadData();
app.listen(PORT, () => {
  console.log(`🏡 Pousada PMS Server rodando na porta ${PORT}`);
  // Initial sync on startup
  syncAll().catch(console.error);
});
