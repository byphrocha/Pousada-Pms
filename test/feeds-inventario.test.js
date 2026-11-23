// PMS-010 passo 1: inventário de quem consulta os feeds + feeds paginados. Dados fictícios.
"use strict";
process.env.JWT_SECRET = "segredo-so-de-teste";
process.env.SUPABASE_URL = "http://127.0.0.1:9";
process.env.SUPABASE_KEY = "chave-falsa";
process.env.CALENDAR_TOKEN = "token-de-teste-123";

const test = require("node:test");
const assert = require("node:assert/strict");
const F = require("../lib/feed-access");
const { app, _setSupabaseForTests, _flushFeedAccessForTests, _resetFeedAccessForTests } = require("../server");
const { createFakeSupabase } = require("./helpers/fake-supabase");
const { ADMIN, STAFF } = require("./helpers/auth");

let server, base;
test.before(async () => { server = app.listen(0); await new Promise(r => server.once("listening", r)); base = `http://127.0.0.1:${server.address().port}`; });
test.after(() => server.close());
const quiet = (fn) => async () => { const o = console.log; console.log = () => {}; try { await fn(); } finally { console.log = o; } };
const get = (p, ua) => fetch(base + p, { headers: ua ? { "User-Agent": ua } : {} });

// ── Unitários ────────────────────────────────────────────────────────────────
test("agentFamily reconhece as plataformas sem guardar o User-Agent", () => {
  assert.equal(F.agentFamily("Airbnb/1.0 (calendar sync)"), "Airbnb");
  assert.equal(F.agentFamily("Booking.com iCal importer"), "Booking");
  assert.equal(F.agentFamily("Google-Calendar-Importer"), "Google");
  assert.equal(F.agentFamily("iOS/17 dataaccessd/1.0"), "Apple");
  assert.equal(F.agentFamily("Mozilla/5.0 Chrome/120"), "navegador");
  assert.equal(F.agentFamily(""), "outro");
});

test("mergeInventory soma contagens e mantém primeiro/último acesso", () => {
  const a = F.addAccess({}, { variant: "legado", room: "21", agent: "Airbnb", status: 200, at: "2030-01-02T00:00:00Z" });
  const b = F.addAccess({}, { variant: "legado", room: "21", agent: "Airbnb", status: 200, at: "2030-01-05T00:00:00Z" });
  F.addAccess(b, { variant: "legado", room: "21", agent: "Booking", status: 200, at: "2030-01-04T00:00:00Z" });
  const m = F.mergeInventory(a, b);
  assert.deepEqual(m["legado:21"].agents.Airbnb, { count: 2, firstAt: "2030-01-02T00:00:00Z", lastAt: "2030-01-05T00:00:00Z", lastStatus: 200 });
  assert.equal(m["legado:21"].agents.Booking.count, 1);
});

// ── Integração ───────────────────────────────────────────────────────────────
const FUT = (i) => `2099-0${1 + (i % 9)}-${String(1 + (i % 27)).padStart(2, "0")}`;
function seed(rows = [], opts) {
  _resetFeedAccessForTests();
  const db = createFakeSupabase({ reservations: rows, settings: [] }, opts);
  _setSupabaseForTests(db);
  return db;
}

test("acessos aos feeds viram inventário: variante, quarto, plataforma — nunca o token", quiet(async () => {
  const db = seed();
  await (await get("/calendar/21.ics", "Airbnb/1.0")).text();
  await (await get("/calendar/21.ics", "Airbnb/1.0")).text();
  await (await get("/calendar/token-de-teste-123/CF.ics", "Booking.com iCal")).text();
  await (await get("/calendar/token-errado/CF.ics", "curl/8")).text();
  await _flushFeedAccessForTests();
  const inv = db.tables.settings.find(r => r.key === "feed_access").value;
  assert.equal(inv["legado:21"].agents.Airbnb.count, 2);
  assert.equal(inv["token:CF"].agents.Booking.lastStatus, 200);
  assert.equal(inv["token:CF"].agents.script.lastStatus, 403);
  assert.doesNotMatch(JSON.stringify(inv), /token-de-teste-123|token-errado|curl\/8|Mozilla/);
}));

test("GET /calendar/inventory: admin vê; funcionário não", quiet(async () => {
  seed();
  await (await get("/calendar/22.ics", "Airbnb/1.0")).text();
  const r = await fetch(base + "/calendar/inventory", { headers: { Authorization: ADMIN() } });
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.ok(body.feeds.some(f => f.variant === "legado" && f.room === "22" && f.agents.Airbnb));
  assert.equal((await fetch(base + "/calendar/inventory", { headers: { Authorization: STAFF() } })).status, 403);
}));

test("feed com mais de 1.000 reservas futuras sai completo (paginação)", quiet(async () => {
  const rows = Array.from({ length: 1205 }, (_, i) => ({ id: `r${String(i).padStart(5, "0")}`, room_id: "21", guest_name: `X${i}`,
    check_in: FUT(i), check_out: FUT(i + 1) > FUT(i) ? FUT(i + 1) : "2099-12-31", status: "confirmed", source: "direto" }));
  seed(rows, { maxRows: 1000 });
  const legado = await (await get("/calendar/21.ics")).text();
  assert.equal((legado.match(/BEGIN:VEVENT/g) || []).length, 1205);
  const comToken = await (await get("/calendar/token-de-teste-123/21.ics")).text();
  assert.equal((comToken.match(/BEGIN:VEVENT/g) || []).length, 1205, "feed com token também pagina");
}));

test("feed não leva estadias antigas (mais de um mês atrás); futuras e recentes continuam", quiet(async () => {
  const today = new Date(Date.now() - 3 * 3600e3).toISOString().slice(0, 10);
  seed([
    { id: "velha", room_id: "20", guest_name: "X", check_in: "2020-01-01", check_out: "2020-01-03", status: "confirmed", source: "direto" },
    { id: "hoje", room_id: "20", guest_name: "X", check_in: today, check_out: "2099-01-02", status: "confirmed", source: "direto" },
  ]);
  const body = await (await get("/calendar/20.ics")).text();
  assert.doesNotMatch(body, /DTSTART;VALUE=DATE:20200101/);
  assert.match(body, new RegExp(`DTSTART;VALUE=DATE:${today.replace(/-/g, "")}`));
}));

test("falha ao gravar o inventário não derruba o feed", async () => {
  const db = seed([{ id: "a", room_id: "20", guest_name: "X", check_in: "2099-01-01", check_out: "2099-01-02", status: "confirmed", source: "direto" }]);
  const orig = db.from;
  db.from = (t) => { const q = orig(t); if (t === "settings") q.upsert = () => ({ then: (res) => Promise.resolve({ data: null, error: { code: "XX000" } }).then(res) }); return q; };
  const o = [console.log, console.error]; console.log = console.error = () => {};
  try {
    const r = await get("/calendar/20.ics", "Airbnb/1.0");
    assert.equal(r.status, 200);
    await r.text();
    await _flushFeedAccessForTests();
  } finally { [console.log, console.error] = o; }
});

test("tela: inventário mostra variante, quarto e plataforma", () => {
  const { loadFrontend } = require("./helpers/frontend-harness");
  const fe = loadFrontend({});
  fe.run(`feedInventory = [{ variant: "legado", room: "21", agents: { Airbnb: { count: 12, firstAt: "2030-01-01T00:00:00Z", lastAt: "2030-01-02T10:00:00Z", lastStatus: 200 } } },
                           { variant: "token", room: "CF", agents: { "<b>x</b>": { count: 1, firstAt: "2030-01-01T00:00:00Z", lastAt: "2030-01-01T00:00:00Z", lastStatus: 403 } } }];`);
  const html = fe.run("renderFeedInventory()");
  assert.match(html, /antigo \(sem token\)[\s\S]*21[\s\S]*Airbnb[\s\S]*12/);
  assert.match(html, /com token[\s\S]*Casa Fechada[\s\S]*403/);
  assert.doesNotMatch(html, /<b>x<\/b>/);
});
