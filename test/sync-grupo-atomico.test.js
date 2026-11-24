// Regra 5 também na sincronização: Casa Fechada e 11+12 vindas do Airbnb entram
// (ou mudam de data) inteiras ou não entram. Com a constraint do banco ativa, um
// quarto ocupado não pode resultar em CF pela metade — e o conflito tem de aparecer.
// Supabase simulado com a mesma regra da constraint; dados fictícios.
"use strict";
process.env.JWT_SECRET = "segredo-so-de-teste";
process.env.SUPABASE_URL = "http://127.0.0.1:9";
process.env.SUPABASE_KEY = "chave-falsa";

const test = require("node:test");
const assert = require("node:assert/strict");
const { runSync, _setSupabaseForTests, _resetIcalStateForTests } = require("../server");
const { createFakeSupabase } = require("./helpers/fake-supabase");

const ALL = ["10", "11", "12", "20", "21", "22", "23", "24", "25"];
const URL_CF = "https://www.airbnb.com/calendar/ical/fake-cf.ics";
const URL_S = "https://www.airbnb.com/calendar/ical/fake-suite.ics";
const ics = (uid, ci, co, summary = "Reserved") => ["BEGIN:VCALENDAR", "BEGIN:VEVENT", `UID:${uid}`,
  `DTSTART;VALUE=DATE:${ci.replace(/-/g, "")}`, `DTEND;VALUE=DATE:${co.replace(/-/g, "")}`, `SUMMARY:${summary}`,
  "END:VEVENT", "END:VCALENDAR"].join("\n");
const settings = (urls) => [{ key: "ical_urls", value: { airbnb: urls, booking: {} } }];
const booking = (room, ci, co) => ({ id: "bk" + room, room_id: room, guest_name: "CLOSED - Not available", source: "booking",
  check_in: ci, check_out: co, status: "confirmed", external_uid: `booking-${room}-X${room}` });
const quiet = (fn) => async () => { const o = [console.log, console.error, console.warn];
  console.log = console.error = console.warn = () => {}; try { await fn(); } finally { [console.log, console.error, console.warn] = o; } };
const withMode = (fn) => quiet(async () => { const p = process.env.ICAL_RECONCILE; process.env.ICAL_RECONCILE = "apply";
  try { await fn(); } finally { if (p === undefined) delete process.env.ICAL_RECONCILE; else process.env.ICAL_RECONCILE = p; } });
const imported = (db, uid) => db.tables.reservations.filter(r => String(r.external_uid || "").endsWith("-" + uid));
const status = async (db) => (db.tables.settings.find(s => s.key === "ical_sync_status") || {}).value;

test("CF nova com um quarto ocupado: nenhum quarto entra e o conflito aparece no aviso", withMode(async () => {
  _resetIcalStateForTests();
  const db = createFakeSupabase({ reservations: [booking("24", "2099-02-01", "2099-02-03")], settings: settings({ CF: URL_CF }) }, { noOverlap: true });
  _setSupabaseForTests(db);
  await runSync({ fetcher: async () => ics("EV1", "2099-02-01", "2099-02-03") });
  assert.equal(imported(db, "EV1").length, 0, "nada de CF pela metade");
  const st = await status(db);
  const feed = st.feeds["airbnb/CF"];
  assert.deepEqual(feed.conflicts, [{ room: "CF", checkIn: "2099-02-01", checkOut: "2099-02-03" }]);
}));

test("CF nova sem conflito: os 9 quartos entram juntos (um INSERT)", withMode(async () => {
  _resetIcalStateForTests();
  const db = createFakeSupabase({ reservations: [], settings: settings({ CF: URL_CF }) }, { noOverlap: true });
  _setSupabaseForTests(db);
  await runSync({ fetcher: async () => ics("EV2", "2099-03-01", "2099-03-03") });
  assert.deepEqual(imported(db, "EV2").map(r => r.room_id).sort(), ALL);
  const inserts = db.log.filter(l => l.table === "reservations" && l.op === "insert");
  assert.equal(inserts.length, 1);
  assert.equal(inserts[0].payload.length, 9);
}));

test("CF de importação antiga incompleta: só os quartos que faltam entram, juntos", withMode(async () => {
  _resetIcalStateForTests();
  const already = ALL.slice(0, 7).map(room => ({ id: "old" + room, room_id: room, guest_name: "Reserved", source: "airbnb",
    check_in: "2099-04-01", check_out: "2099-04-03", status: "confirmed", external_uid: `airbnb-${room}-EV3`, notes: "Importado via iCal (Casa Fechada) [Casa toda:cf-EV3]" }));
  const db = createFakeSupabase({ reservations: already, settings: settings({ CF: URL_CF }) }, { noOverlap: true });
  _setSupabaseForTests(db);
  await runSync({ fetcher: async () => ics("EV3", "2099-04-01", "2099-04-03") });
  assert.deepEqual(imported(db, "EV3").map(r => r.room_id).sort(), ALL);
}));

test("Suíte 11+12 com o 12 ocupado: nenhum dos dois entra; conflito como 11+12", withMode(async () => {
  _resetIcalStateForTests();
  const db = createFakeSupabase({ reservations: [booking("12", "2099-05-02", "2099-05-04")], settings: settings({ "11+12": URL_S }) }, { noOverlap: true });
  _setSupabaseForTests(db);
  await runSync({ fetcher: async () => ics("EV4", "2099-05-01", "2099-05-03") });
  assert.equal(imported(db, "EV4").length, 0);
  assert.deepEqual((await status(db)).feeds["airbnb/11+12"].conflicts, [{ room: "11+12", checkIn: "2099-05-01", checkOut: "2099-05-03" }]);
}));

test("bloqueio 'Not available' da CF não conflita (a constraint ignora) e entra normalmente", withMode(async () => {
  _resetIcalStateForTests();
  const db = createFakeSupabase({ reservations: [booking("24", "2099-06-01", "2099-06-03")], settings: settings({ CF: URL_CF }) }, { noOverlap: true });
  _setSupabaseForTests(db);
  await runSync({ fetcher: async () => ics("EV5", "2099-06-01", "2099-06-03", "Airbnb (Not available)") });
  assert.equal(imported(db, "EV5").length, 9);
  assert.deepEqual((await status(db)).feeds["airbnb/CF"].conflicts, []);
}));

test("CF muda de data no Airbnb e um quarto está ocupado: nada muda e o conflito aparece", withMode(async () => {
  _resetIcalStateForTests();
  const cf = ALL.map(room => ({ id: "cf" + room, room_id: room, guest_name: "Reserved", source: "airbnb",
    check_in: "2099-07-01", check_out: "2099-07-03", status: "confirmed", external_uid: `airbnb-${room}-EV6`,
    notes: "Importado via iCal (Casa Fechada) [Casa toda:cf-EV6]", group_id: "cf:cf-EV6" }));
  const db = createFakeSupabase({ reservations: [...cf, booking("24", "2099-07-03", "2099-07-05")], settings: settings({ CF: URL_CF }) }, { noOverlap: true });
  _setSupabaseForTests(db);
  await runSync({ fetcher: async () => ics("EV6", "2099-07-02", "2099-07-04") });
  assert.ok(imported(db, "EV6").every(r => r.check_in === "2099-07-01" && r.check_out === "2099-07-03"), "nenhum quarto muda sozinho");
  assert.deepEqual((await status(db)).feeds["airbnb/CF"].conflicts, [{ room: "CF", checkIn: "2099-07-02", checkOut: "2099-07-04" }]);
}));

test("CF muda de data sem conflito: os 9 mudam num único UPDATE", withMode(async () => {
  _resetIcalStateForTests();
  const cf = ALL.map(room => ({ id: "cf" + room, room_id: room, guest_name: "Reserved", source: "airbnb",
    check_in: "2099-08-01", check_out: "2099-08-03", status: "confirmed", external_uid: `airbnb-${room}-EV7`,
    notes: "Importado via iCal (Casa Fechada) [Casa toda:cf-EV7]" }));
  const db = createFakeSupabase({ reservations: cf, settings: settings({ CF: URL_CF }) }, { noOverlap: true });
  _setSupabaseForTests(db);
  await runSync({ fetcher: async () => ics("EV7", "2099-08-02", "2099-08-05") });
  assert.ok(imported(db, "EV7").every(r => r.check_in === "2099-08-02" && r.check_out === "2099-08-05"));
  const ups = db.log.filter(l => l.table === "reservations" && l.op === "update" && l.payload && l.payload.check_in);
  assert.equal(ups.length, 1, "um UPDATE para o grupo");
}));

test("tela: aviso de overbooking nomeia Casa Fechada e suíte 11+12", async () => {
  const { loadFrontend } = require("./helpers/frontend-harness");
  const health = { ok: false, lastRunAt: new Date().toISOString(), stale: [], failing: [
    { feed: "airbnb/CF", problem: "conflito com outra reserva", conflicts: [{ room: "CF", checkIn: "2099-02-01", checkOut: "2099-02-03" }] },
    { feed: "airbnb/11+12", problem: "conflito com outra reserva", conflicts: [{ room: "11+12", checkIn: "2099-05-01", checkOut: "2099-05-03" }] },
    { feed: "booking/24", problem: "conflito com outra reserva", conflicts: [{ room: "24", checkIn: "2099-06-01", checkOut: "2099-06-02" }] }] };
  const fe = loadFrontend({ routes: [{ method: "GET", path: "/sync/status", reply: () => ({ status: 200, json: { health, syncing: false } }) }] });
  await fe.run("refreshSyncStatus()");
  const msg = fe.run("syncWarning()");
  assert.match(msg, /Casa Fechada, 01\/02\/2099/);
  assert.match(msg, /suíte 11\+12, 01\/05\/2099/);
  assert.match(msg, /quarto 24, 01\/06\/2099/);
  assert.match(msg, /mudança de datas/);
});
