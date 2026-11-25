// Reserva que some do calendário da plataforma por algumas leituras e depois
// volta (caso real de 25/11/2026, Booking quarto 20): a PMS cancelava e nunca
// mais reativava. Agora reativa SÓ o que a própria sincronização cancelou.
// Supabase simulado com a constraint; dados fictícios.
"use strict";
process.env.JWT_SECRET = "segredo-so-de-teste";
process.env.SUPABASE_URL = "http://127.0.0.1:9";
process.env.SUPABASE_KEY = "chave-falsa";

const test = require("node:test");
const assert = require("node:assert/strict");
const { runSync, _setSupabaseForTests, _resetIcalStateForTests } = require("../server");
const { createFakeSupabase } = require("./helpers/fake-supabase");

const URL_20 = "https://ical.booking.com/ficticio-20.ics";
const URL_CF = "https://www.airbnb.com.br/calendar/ical/ficticio-cf.ics";
const ALL = ["10", "11", "12", "20", "21", "22", "23", "24", "25"];
const ics = (...evs) => ["BEGIN:VCALENDAR", ...evs.flatMap(([uid, ci, co]) => ["BEGIN:VEVENT", `UID:${uid}`,
  `DTSTART;VALUE=DATE:${ci.replace(/-/g, "")}`, `DTEND;VALUE=DATE:${co.replace(/-/g, "")}`,
  "SUMMARY:CLOSED - Not available", "END:VEVENT"]), "END:VCALENDAR"].join("\n");
// Calendário sem a reserva, mas com outra (calendário vazio não cancela nada: proteção existente).
const VAZIO = ics(["OUTRA", "2099-06-01", "2099-06-02"]);
const quiet = (fn) => async () => { const o = [console.log, console.warn, console.error];
  console.log = console.warn = console.error = () => {};
  const p = process.env.ICAL_RECONCILE; process.env.ICAL_RECONCILE = "apply";
  try { _resetIcalStateForTests(); await fn(); }
  finally { [console.log, console.warn, console.error] = o; if (p === undefined) delete process.env.ICAL_RECONCILE; else process.env.ICAL_RECONCILE = p; } };
function banco(urls, reservations = []) {
  const db = createFakeSupabase({ reservations, audit_log: [], settings: [{ key: "ical_urls", value: urls }] }, { noOverlap: true });
  _setSupabaseForTests(db);
  return db;
}
const sync = (text) => runSync({ fetcher: async () => text });
const rows = (db, src) => db.tables.reservations.filter(r => r.source === src);
const acoes = (db, id) => db.tables.audit_log.filter(a => a.entity_id === id).map(a => a.action);

test("caso do quarto 20: some por 2 leituras (cancela e registra), volta → reativada e registrada", quiet(async () => {
  const db = banco({ airbnb: {}, booking: { "20": URL_20 } });
  await sync(ics(["B1", "2099-11-25", "2099-11-26"]));
  const r = rows(db, "booking").find(x => x.check_in === "2099-11-25");
  assert.equal(r.status, "confirmed");
  await sync(VAZIO); await sync(VAZIO);
  assert.equal(r.status, "cancelled");
  assert.deepEqual(acoes(db, r.id), ["ical.cancelar"]);
  const out = await sync(ics(["B1", "2099-11-25", "2099-11-26"]));
  assert.equal(r.status, "confirmed");
  assert.equal(rows(db, "booking").filter(x => x.check_in === "2099-11-25").length, 1, "não duplica");
  assert.deepEqual(acoes(db, r.id), ["ical.cancelar", "ical.reativar"]);
  assert.equal(out.failed, 0);
  assert.equal(db.tables.audit_log.find(a => a.action === "ical.reativar").username, "sincronização");
}));

test("cancelada por pessoa depois da sincronização, ou sem registro: não reativa", quiet(async () => {
  let db = banco({ airbnb: {}, booking: { "20": URL_20 } });
  await sync(ics(["B2", "2099-11-25", "2099-11-26"]));
  await sync(VAZIO); await sync(VAZIO);
  const r = rows(db, "booking").find(x => x.check_in === "2099-11-25");
  db.tables.audit_log.push({ id: 99, at: new Date(Date.now() + 1000).toISOString(), entity: "reservation", entity_id: r.id, action: "reserva.cancelar" });
  await sync(ics(["B2", "2099-11-25", "2099-11-26"]));
  assert.equal(r.status, "cancelled", "a pessoa decidiu cancelar");

  db = banco({ airbnb: {}, booking: { "20": URL_20 } }, [{ id: "antiga", room_id: "20", source: "booking", status: "cancelled",
    external_uid: "booking-20-B3", guest_name: "CLOSED - Not available", check_in: "2099-11-25", check_out: "2099-11-26" }]);
  await sync(ics(["B3", "2099-11-25", "2099-11-26"]));
  assert.equal(db.tables.reservations[0].status, "cancelled", "cancelamento antigo, sem auditoria: fica como está");
}));

test("estadia já terminada não é reativada", quiet(async () => {
  const db = banco({ airbnb: {}, booking: { "20": URL_20 } }, [{ id: "p1", room_id: "20", source: "booking", status: "cancelled",
    external_uid: "booking-20-B4", guest_name: "x", check_in: "2020-01-01", check_out: "2020-01-02" }]);
  db.tables.audit_log.push({ id: 1, at: "2020-01-01T00:00:00Z", entity: "reservation", entity_id: "p1", action: "ical.cancelar" });
  await sync(ics(["B4", "2020-01-01", "2020-01-02"]));
  assert.equal(db.tables.reservations[0].status, "cancelled");
}));

test("voltou mas as datas já foram ocupadas por outra reserva: fica cancelada e vira conflito", quiet(async () => {
  const db = banco({ airbnb: {}, booking: { "20": URL_20 } });
  await sync(ics(["B5", "2099-11-25", "2099-11-27"]));
  await sync(VAZIO); await sync(VAZIO);
  db.tables.reservations.push({ id: "dir", room_id: "20", source: "direto", status: "confirmed", guest_name: "Hóspede Teste", check_in: "2099-11-26", check_out: "2099-11-28" });
  const out = await sync(ics(["B5", "2099-11-25", "2099-11-27"]));
  assert.equal(rows(db, "booking").find(x => x.check_in === "2099-11-25").status, "cancelled");
  assert.equal(out.failed, 1);
  const st = db.tables.settings.find(s => s.key === "ical_sync_status").value.feeds["booking/20"];
  assert.deepEqual(st.conflicts, [{ room: "20", checkIn: "2099-11-25", checkOut: "2099-11-27" }]);
}));

test("Casa Fechada: os 9 quartos voltam juntos; se um foi cancelado por pessoa, nenhum volta", quiet(async () => {
  let db = banco({ airbnb: { CF: URL_CF }, booking: {} });
  const cf = ics(["C1", "2099-12-04", "2099-12-06"]).replace("CLOSED - Not available", "Reserved");
  const semCf = ics(["OUTRA", "2099-06-01", "2099-06-02"]).replace("CLOSED - Not available", "Reserved");
  await sync(cf); await sync(semCf); await sync(semCf);
  const doCf = () => rows(db, "airbnb").filter(r => r.check_in === "2099-12-04");
  assert.ok(doCf().length === 9 && doCf().every(r => r.status === "cancelled"));
  await sync(cf);
  assert.equal(doCf().filter(r => r.status === "confirmed").length, 9);

  db = banco({ airbnb: { CF: URL_CF }, booking: {} });
  await sync(cf); await sync(semCf); await sync(semCf);
  const doCf2 = () => rows(db, "airbnb").filter(r => r.check_in === "2099-12-04");
  const lead = doCf2().find(r => r.room_id === "20");
  db.tables.audit_log.push({ id: 500, at: new Date(Date.now() + 1000).toISOString(), entity: "reservation", entity_id: lead.id, action: "reserva.cancelar" });
  await sync(cf);
  assert.equal(doCf2().filter(r => r.status === "confirmed").length, 0, "tudo ou nada");
}));

test("datas mudaram enquanto estava fora: reativa com as datas do calendário", quiet(async () => {
  const db = banco({ airbnb: {}, booking: { "20": URL_20 } });
  await sync(ics(["B6", "2099-11-25", "2099-11-26"]));
  await sync(VAZIO); await sync(VAZIO);
  await sync(ics(["B6", "2099-11-25", "2099-11-28"]));
  const r = rows(db, "booking").find(x => x.external_uid === "booking-20-B6");
  assert.deepEqual([r.status, r.check_in, r.check_out], ["confirmed", "2099-11-25", "2099-11-28"]);
}));

test("sem conseguir ler a auditoria: não reativa (e não quebra a sincronização)", quiet(async () => {
  const db = banco({ airbnb: {}, booking: { "20": URL_20 } });
  await sync(ics(["B7", "2099-11-25", "2099-11-26"]));
  await sync(VAZIO); await sync(VAZIO);
  const from = db.from;
  db.from = (t) => { const q = from(t); if (t !== "audit_log") return q;
    const sel = q.select; q.select = (...a) => { const r = sel(...a); r.eq = () => r; r.in = () => r; r.order = async () => ({ data: null, error: { code: "XX000" } }); return r; }; return q; };
  const out = await sync(ics(["B7", "2099-11-25", "2099-11-26"]));
  assert.equal(rows(db, "booking").find(x => x.external_uid === "booking-20-B7").status, "cancelled");
  assert.ok(out);
}));
