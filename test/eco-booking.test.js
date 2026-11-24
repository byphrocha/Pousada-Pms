// PMS-010 (piloto): "eco" da plataforma. Quando o Booking lê o link da PMS, fecha
// as datas e passa a devolvê-las no calendário dele como "CLOSED - Not available".
// Isso não é overbooking. Mas reserva real que chegou ANTES de o Booking ler o
// link continua sendo conflito. Supabase simulado com a constraint; dados fictícios.
"use strict";
process.env.JWT_SECRET = "segredo-so-de-teste";
process.env.SUPABASE_URL = "http://127.0.0.1:9";
process.env.SUPABASE_KEY = "chave-falsa";
process.env.CALENDAR_TOKEN = "token-ficticio-de-teste";

const test = require("node:test");
const assert = require("node:assert/strict");
const fx = require("../lib/feed-export");
const syncStatus = require("../lib/sync-status");
const { app, runSync, _setSupabaseForTests, _resetIcalStateForTests } = require("../server");
const { createFakeSupabase } = require("./helpers/fake-supabase");

const URL_20 = "https://ical.booking.com/fonte-ficticia-20.ics";
const UA_BOOKING = "Booking.com iCal fetcher";
const ics = (...evs) => ["BEGIN:VCALENDAR", ...evs.flatMap(([uid, ci, co]) => ["BEGIN:VEVENT", `UID:${uid}`,
  `DTSTART;VALUE=DATE:${ci.replace(/-/g, "")}`, `DTEND;VALUE=DATE:${co.replace(/-/g, "")}`,
  "SUMMARY:CLOSED - Not available", "END:VEVENT"]), "END:VCALENDAR"].join("\n");
const direta = (ci, co, id = "dir20") => ({ id, room_id: "20", source: "direto", guest_name: "Hóspede Fictício",
  phone: "TEL-FICTICIO", check_in: ci, check_out: co, status: "confirmed" });
const pausa = () => new Promise(r => setTimeout(r, 5));
const quiet = (fn) => async () => { const o = [console.log, console.error, console.warn];
  console.log = console.error = console.warn = () => {}; try { await fn(); } finally { [console.log, console.error, console.warn] = o; } };
const withApply = (fn) => quiet(async () => { const p = process.env.ICAL_RECONCILE; process.env.ICAL_RECONCILE = "apply";
  try { _resetIcalStateForTests(); await fn(); } finally { if (p === undefined) delete process.env.ICAL_RECONCILE; else process.env.ICAL_RECONCILE = p; } });

let server, base;
test.before(async () => { server = app.listen(0); await new Promise(r => server.once("listening", r)); base = `http://127.0.0.1:${server.address().port}`; });
test.after(() => server.close());
const lerLink = (ua, channel = "booking", room = "20") =>
  fetch(`${base}/calendar/token-ficticio-de-teste/${channel}/${room}.ics`, { headers: { "User-Agent": ua } }).then(r => r.status);

function banco(reservations, opts = {}) {
  const db = createFakeSupabase({ reservations,
    settings: [{ key: "ical_urls", value: { airbnb: {}, booking: { "20": URL_20 } } }] }, { noOverlap: true });
  _setSupabaseForTests(db);
  return db;
}
const setting = (db, key) => (db.tables.settings.find(s => s.key === key) || {}).value;
const feed20 = (db) => setting(db, "ical_sync_status").feeds["booking/20"];
const booking20 = (db) => db.tables.reservations.filter(r => r.source === "booking");

// ── regras puras ─────────────────────────────────────────────────────────────
test("noites: [entrada, saída) e o 'desde' se mantém enquanto a noite continuar fechada", () => {
  assert.deepEqual(fx.nightsOf("2099-03-30", "2099-04-02"), ["2099-03-30", "2099-03-31", "2099-04-01"]);
  assert.deepEqual(fx.nightsOf("2099-03-01", "2099-03-01"), []);
  const a = fx.mergeSentNights(null, [["2099-03-01", "2099-03-03"]], "T1");
  assert.deepEqual(a, { "2099-03-01": "T1", "2099-03-02": "T1" });
  const b = fx.mergeSentNights(a, [["2099-03-02", "2099-03-04"]], "T2");
  assert.deepEqual(b, { "2099-03-02": "T1", "2099-03-03": "T2" }, "01 reabriu e sai; 02 mantém T1; 03 é nova");
  const c = fx.mergeSentNights(fx.mergeSentNights(b, [], "T3"), [["2099-03-02", "2099-03-03"]], "T4");
  assert.deepEqual(c, { "2099-03-02": "T4" }, "reabriu e fechou de novo: recomeça");
});

test("eco só se TODAS as noites já iam fechadas antes de a PMS ver o evento", () => {
  const sent = { "2099-03-01": "2030-01-01T10:00:00.000Z", "2099-03-02": "2030-01-01T12:00:00.000Z" };
  assert.equal(fx.isEcho(sent, "2099-03-01", "2099-03-03", "2030-01-01T12:30:00.000Z"), true);
  assert.equal(fx.isEcho(sent, "2099-03-01", "2099-03-03", "2030-01-01T11:00:00.000Z"), false, "uma noite foi enviada depois");
  assert.equal(fx.isEcho(sent, "2099-03-01", "2099-03-03", "2030-01-01T12:00:00.000Z"), false, "mesmo instante não conta");
  assert.equal(fx.isEcho(sent, "2099-03-01", "2099-03-04", "2030-01-02T00:00:00.000Z"), false, "noite 03 nunca foi enviada");
  assert.equal(fx.isEcho(null, "2099-03-01", "2099-03-02", "2030-01-02T00:00:00.000Z"), false);
  assert.equal(fx.isEcho(sent, "2099-03-01", "2099-03-02", null), false);
  assert.equal(fx.isEcho(sent, "2099-03-01", "2099-03-01", "2030-01-02T00:00:00.000Z"), false, "evento sem noite nunca é eco");
});

// ── registro do que foi enviado ──────────────────────────────────────────────
test("link: só a leitura da própria plataforma registra as noites enviadas", quiet(async () => {
  const db = banco([direta("2099-03-01", "2099-03-03")]);
  assert.equal(await lerLink("Mozilla/5.0 Safari"), 200);
  assert.equal(await lerLink("Airbnb calendar sync"), 200, "Airbnb lendo o link do Booking");
  assert.equal(setting(db, "feed_export:booking:20"), undefined, "navegador e outra plataforma não registram");
  assert.equal(await lerLink(UA_BOOKING), 200);
  const rec = setting(db, "feed_export:booking:20");
  assert.deepEqual(Object.keys(rec.nights), ["2099-03-01", "2099-03-02"]);
  const antes = rec.nights["2099-03-01"];
  await pausa();
  await lerLink(UA_BOOKING);
  assert.equal(setting(db, "feed_export:booking:20").nights["2099-03-01"], antes, "segunda leitura mantém o 'desde'");
  assert.doesNotMatch(JSON.stringify(rec), /Fictício|TEL-FICTICIO|dir20/, "só datas");
}));

test("link: se não der para ler o registro anterior, não grava por cima", quiet(async () => {
  const db = banco([direta("2099-03-01", "2099-03-03")]);
  db.tables.settings.push({ key: "feed_export:booking:20", value: { at: "x", nights: { "2099-03-01": "2030-01-01T00:00:00.000Z" } } });
  const from = db.from;
  db.from = (t) => { const q = from(t); if (t !== "settings") return q;
    const eq = q.eq; q.eq = (c, v) => (String(v).startsWith("feed_export:") ? { maybeSingle: async () => ({ data: null, error: { message: "falha simulada" } }) } : eq(c, v)); return q; };
  assert.equal(await lerLink(UA_BOOKING), 200, "o calendário sai mesmo assim");
  assert.equal(setting(db, "feed_export:booking:20").nights["2099-03-01"], "2030-01-01T00:00:00.000Z");
}));

// ── sincronização ────────────────────────────────────────────────────────────
test("eco: Booking leu o link e depois devolveu o fechamento — não entra, não é conflito, fica registrado", withApply(async () => {
  const db = banco([direta("2099-03-01", "2099-03-04")]);
  await lerLink(UA_BOOKING);
  await pausa();
  const r = await runSync({ fetcher: async () => ics(["K1", "2099-03-01", "2099-03-04"]) });
  assert.equal(r.failed, 0);
  assert.equal(booking20(db).length, 0, "nada importado");
  const f = feed20(db);
  assert.equal(f.problem, null);
  assert.deepEqual(f.conflicts, []);
  assert.deepEqual(f.echoes, [{ room: "20", checkIn: "2099-03-01", checkOut: "2099-03-04" }]);
  const h = syncStatus.computeHealth(setting(db, "ical_sync_status"), Date.now());
  assert.equal(h.ok, true, "eco não dispara o aviso geral");
  assert.deepEqual(h.echoes, [{ feed: "booking/20", room: "20", checkIn: "2099-03-01", checkOut: "2099-03-04" }]);
  // fechamento de parte das noites (o Booking pode quebrar em pedaços) também é eco
  await pausa();
  await runSync({ fetcher: async () => ics(["K1", "2099-03-01", "2099-03-04"], ["K2", "2099-03-02", "2099-03-03"]) });
  assert.equal(feed20(db).echoes.length, 2);
}));

test("reserva real que chegou antes de o Booking ler o link continua conflito, mesmo depois de reiniciar", withApply(async () => {
  const db = banco([direta("2099-03-01", "2099-03-04")]);
  await runSync({ fetcher: async () => ics(["R1", "2099-03-01", "2099-03-04"]) });
  assert.deepEqual(feed20(db).conflicts, [{ room: "20", checkIn: "2099-03-01", checkOut: "2099-03-04" }]);
  await pausa();
  await lerLink(UA_BOOKING); // o Booking só leu depois
  _resetIcalStateForTests();  // servidor reiniciou: a primeira vista está no banco
  await pausa();
  const r = await runSync({ fetcher: async () => ics(["R1", "2099-03-01", "2099-03-04"]) });
  assert.equal(r.failed, 1);
  assert.deepEqual(feed20(db).conflicts, [{ room: "20", checkIn: "2099-03-01", checkOut: "2099-03-04" }]);
  assert.deepEqual(feed20(db).echoes, []);
  assert.equal(feed20(db).problem, "conflito com outra reserva");
}));

test("continua conflito: Booking nunca leu o link; ou o fechamento passa das noites enviadas", withApply(async () => {
  let db = banco([direta("2099-03-01", "2099-03-04")]);
  await runSync({ fetcher: async () => ics(["N1", "2099-03-01", "2099-03-04"]) });
  assert.equal(feed20(db).conflicts.length, 1, "nunca leu");

  db = banco([direta("2099-03-01", "2099-03-04")]);
  await lerLink(UA_BOOKING);
  await pausa();
  await runSync({ fetcher: async () => ics(["N2", "2099-02-28", "2099-03-04"]) });
  assert.deepEqual(feed20(db).conflicts, [{ room: "20", checkIn: "2099-02-28", checkOut: "2099-03-04" }], "noite 28/02 não foi enviada");
  assert.deepEqual(feed20(db).echoes, []);
}));

test("se não der para guardar a primeira vista do evento, vale como conflito", withApply(async () => {
  const db = banco([direta("2099-03-01", "2099-03-04")]);
  await lerLink(UA_BOOKING);
  await pausa();
  const from = db.from;
  db.from = (t) => { const q = from(t); const up = q.upsert;
    q.upsert = (p) => (String(p && p.key).startsWith("ical_first_seen:") ? { then: (ok) => ok({ data: null, error: { message: "falha simulada" } }) } : up(p)); return q; };
  await runSync({ fetcher: async () => ics(["F1", "2099-03-01", "2099-03-04"]) });
  assert.equal(feed20(db).conflicts.length, 1);
  assert.deepEqual(feed20(db).echoes, []);
}));

test("primeira vista: guarda só eventos que ainda estão no calendário da plataforma", withApply(async () => {
  const db = banco([direta("2099-03-01", "2099-03-04"), direta("2099-05-01", "2099-05-03", "dir20b")]);
  await runSync({ fetcher: async () => ics(["A", "2099-03-01", "2099-03-04"]) });
  await runSync({ fetcher: async () => ics(["B", "2099-05-01", "2099-05-03"]) });
  assert.deepEqual(Object.keys(setting(db, "ical_first_seen:booking:20")), ["B|2099-05-01|2099-05-03"]);
}));

// ── tela ─────────────────────────────────────────────────────────────────────
const { loadFrontend } = require("./helpers/frontend-harness");
test("tela: eco aparece em Sincronizar como informação, sem aviso no topo", async () => {
  const fe = loadFrontend({ routes: [{ method: "GET", path: "/sync/status", reply: () => ({ status: 200, json: { syncing: false,
    health: { ok: true, lastRunAt: new Date().toISOString(), failing: [], stale: [],
      echoes: [{ feed: "booking/20", room: "20", checkIn: "2030-12-24", checkOut: "2030-12-26" }] } } }) }] });
  await fe.run("refreshSyncStatus()");
  assert.equal(fe.run("syncWarning()"), null);
  const html = fe.run("renderSync()");
  assert.match(html, /devolveu fechadas depois de receber da PMS: Booking quarto 20, 24\/12\/2030 → 26\/12\/2030/);
  assert.match(html, /reserva de verdade no extranet, é overbooking/);
  assert.match(html, /todos os calendários em dia/);
});

test("tela: sem eco, nenhuma linha extra", async () => {
  const fe = loadFrontend({ routes: [{ method: "GET", path: "/sync/status", reply: () => ({ status: 200, json: { syncing: false,
    health: { ok: true, lastRunAt: new Date().toISOString(), failing: [], stale: [] } } }) }] });
  await fe.run("refreshSyncStatus()");
  assert.doesNotMatch(fe.run("renderSync()"), /devolveu fechadas/);
});
