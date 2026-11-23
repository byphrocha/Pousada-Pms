// Testes da reconciliação iCal (PMS-009: I1, I2, I3). Dados e calendários fictícios.
"use strict";
process.env.JWT_SECRET = "segredo-so-de-teste";
process.env.SUPABASE_URL = "http://127.0.0.1:9";
process.env.SUPABASE_KEY = "chave-falsa";

const test = require("node:test");
const assert = require("node:assert/strict");
const R = require("../lib/ical-reconcile");
const { runSync, _setSupabaseForTests, _resetIcalStateForTests } = require("../server");
const { createFakeSupabase } = require("./helpers/fake-supabase");

const TODAY = "2030-01-10";
const N_IND = "Importado via iCal";
const N_CF = (uid) => `Importado via iCal (Casa Fechada) [Casa toda:cf-${uid}]`;
const row = (id, room, uid, ci, co, notes = N_IND, source = "airbnb") =>
  ({ id, room_id: room, external_uid: `${source}-${room}-${uid}`, check_in: ci, check_out: co, notes, status: "confirmed", source });

// ── Unitários: planReconcile ────────────────────────────────────────────────
test("evento presente com as mesmas datas: nada a fazer", () => {
  const p = R.planReconcile({ source: "airbnb", feedRoomId: "21", today: TODAY,
    events: [{ uid: "u1", checkIn: "2030-02-01", checkOut: "2030-02-03" }],
    rows: [row("a", "21", "u1", "2030-02-01", "2030-02-03")] });
  assert.deepEqual([p.updates, p.cancels, p.pending], [[], [], []]);
});

test("I2: mesmo UID com datas novas → atualização proposta", () => {
  const p = R.planReconcile({ source: "airbnb", feedRoomId: "21", today: TODAY,
    events: [{ uid: "u1", checkIn: "2030-02-02", checkOut: "2030-02-05" }],
    rows: [row("a", "21", "u1", "2030-02-01", "2030-02-03")] });
  assert.deepEqual(p.updates, [{ id: "a", room_id: "21", from: ["2030-02-01", "2030-02-03"], to: ["2030-02-02", "2030-02-05"] }]);
});

test("I2: evento sumiu → só cancela na 2ª ausência seguida", () => {
  const args = { source: "airbnb", feedRoomId: "21", today: TODAY,
    events: [{ uid: "outro", checkIn: "2030-03-01", checkOut: "2030-03-02" }],
    rows: [row("a", "21", "u1", "2030-02-01", "2030-02-03")] };
  const p1 = R.planReconcile(args);
  assert.equal(p1.cancels.length, 0);
  assert.deepEqual(p1.pending, [{ id: "a", room_id: "21", ausencias: 1 }]);
  const p2 = R.planReconcile({ ...args, missingCounts: p1.nextCounts });
  assert.deepEqual(p2.cancels, [{ id: "a", room_id: "21" }]);
});

test("evento que volta zera a contagem de ausências", () => {
  const rows = [row("a", "21", "u1", "2030-02-01", "2030-02-03")];
  const p1 = R.planReconcile({ source: "airbnb", feedRoomId: "21", today: TODAY, rows, events: [{ uid: "x", checkIn: "2030-05-01", checkOut: "2030-05-02" }] });
  const p2 = R.planReconcile({ source: "airbnb", feedRoomId: "21", today: TODAY, rows, missingCounts: p1.nextCounts, events: [{ uid: "u1", checkIn: "2030-02-01", checkOut: "2030-02-03" }] });
  const p3 = R.planReconcile({ source: "airbnb", feedRoomId: "21", today: TODAY, rows, missingCounts: p2.nextCounts, events: [{ uid: "x", checkIn: "2030-05-01", checkOut: "2030-05-02" }] });
  assert.equal(p3.cancels.length, 0, "precisa de 2 ausências SEGUIDAS");
});

test("feed vazio nunca propõe cancelamento (falha do provedor)", () => {
  const p = R.planReconcile({ source: "airbnb", feedRoomId: "21", today: TODAY, events: [],
    rows: [row("a", "21", "u1", "2030-02-01", "2030-02-03")], missingCounts: new Map([["a", 5]]) });
  assert.equal(p.skipped, "feed sem eventos");
  assert.equal(p.cancels.length, 0);
});

test("I1: estadia já terminada nunca é cancelada por sumir do feed", () => {
  const p = R.planReconcile({ source: "airbnb", feedRoomId: "21", today: TODAY,
    events: [{ uid: "x", checkIn: "2030-05-01", checkOut: "2030-05-02" }],
    rows: [row("old", "21", "u0", "2030-01-01", "2030-01-05")], missingCounts: new Map([["old", 9]]) });
  assert.equal(p.cancels.length, 0);
});

test("check-out hoje ainda é reconciliado (hóspede saindo hoje)", () => {
  const p = R.planReconcile({ source: "airbnb", feedRoomId: "21", today: TODAY,
    events: [{ uid: "x", checkIn: "2030-05-01", checkOut: "2030-05-02" }],
    rows: [row("a", "21", "u1", "2030-01-08", TODAY)], missingCounts: new Map([["a", 1]]) });
  assert.equal(p.cancels.length, 1);
});

test("feed individual não mexe em linhas que vieram do feed da CF no mesmo quarto", () => {
  const p = R.planReconcile({ source: "airbnb", feedRoomId: "21", today: TODAY,
    events: [{ uid: "x", checkIn: "2030-05-01", checkOut: "2030-05-02" }],
    rows: [row("cf", "21", "c1", "2030-02-01", "2030-02-03", N_CF("c1"))], missingCounts: new Map([["cf", 3]]) });
  assert.equal(p.cancels.length, 0);
});

test("feed da CF reconcilia as 9 linhas do mesmo evento", () => {
  const rows = ["10","11","12","20","21","22","23","24","25"].map((q, i) => row("cf" + i, q, "c1", "2030-02-01", "2030-02-03", N_CF("c1")));
  const p = R.planReconcile({ source: "airbnb", feedRoomId: "CF", today: TODAY, rows,
    events: [{ uid: "c1", checkIn: "2030-02-01", checkOut: "2030-02-04" }] });
  assert.equal(p.updates.length, 9);
});

test("linha com observação editada à mão fica fora (lado seguro)", () => {
  const p = R.planReconcile({ source: "airbnb", feedRoomId: "21", today: TODAY,
    events: [{ uid: "x", checkIn: "2030-05-01", checkOut: "2030-05-02" }],
    rows: [row("m", "21", "u1", "2030-02-01", "2030-02-03", "Importado via iCal — hóspede pediu berço")], missingCounts: new Map([["m", 3]]) });
  assert.equal(p.cancels.length, 0);
});

test("Booking e Airbnb no mesmo quarto não se misturam", () => {
  const p = R.planReconcile({ source: "booking", feedRoomId: "22", today: TODAY,
    events: [{ uid: "b9", checkIn: "2030-05-01", checkOut: "2030-05-02" }],
    rows: [row("air", "22", "u1", "2030-02-01", "2030-02-03")], missingCounts: new Map([["air", 3]]) });
  assert.equal(p.cancels.length, 0);
});

// ── Integração: runSync com Supabase falso e calendário sintético ──────────
function ics(events) {
  return ["BEGIN:VCALENDAR", "VERSION:2.0",
    ...events.flatMap(e => ["BEGIN:VEVENT", `UID:${e.uid}`, `DTSTART;VALUE=DATE:${e.ci.replace(/-/g, "")}`,
      `DTEND;VALUE=DATE:${e.co.replace(/-/g, "")}`, `SUMMARY:${e.s || "Reserved"}`, "END:VEVENT"]),
    "END:VCALENDAR"].join("\n");
}
function setupDb(rows) {
  _resetIcalStateForTests();
  const db = createFakeSupabase({
    settings: [{ key: "ical_urls", value: { airbnb: { "21": "https://www.airbnb.com/fake.ics" }, booking: {} } }],
    reservations: rows,
  });
  _setSupabaseForTests(db);
  return db;
}
function withEnv(k, v, fn) {
  return async () => { const p = process.env[k]; process.env[k] = v;
    try { await fn(); } finally { if (p === undefined) delete process.env[k]; else process.env[k] = p; } };
}
const quiet = (fn) => async () => { const o = [console.log, console.warn, console.error];
  console.log = console.warn = console.error = () => {}; try { await fn(); } finally { [console.log, console.warn, console.error] = o; } };

const FUT = "2099-02-01", FUT2 = "2099-02-03";

test("I1: runSync não cancela mais reservas com check-out passado", quiet(withEnv("ICAL_RECONCILE", "apply", async () => {
  const db = setupDb([row("past", "21", "u0", "2020-01-01", "2020-01-03")]);
  await runSync({ fetcher: async () => ics([{ uid: "u9", ci: FUT, co: FUT2 }]) });
  await runSync({ fetcher: async () => ics([{ uid: "u9", ci: FUT, co: FUT2 }]) });
  assert.equal(db.tables.reservations.find(r => r.id === "past").status, "confirmed");
})));

test("I2 report (padrão): propõe mas não altera nada", quiet(withEnv("ICAL_RECONCILE", "report", async () => {
  const db = setupDb([row("a", "21", "u1", FUT, FUT2), row("b", "21", "u2", FUT, FUT2)]);
  const feed = async () => ics([{ uid: "u1", ci: FUT, co: "2099-02-05" }]);
  await runSync({ fetcher: feed });
  const r2 = await runSync({ fetcher: feed });
  const a = db.tables.reservations.find(r => r.id === "a"), b = db.tables.reservations.find(r => r.id === "b");
  assert.equal(a.check_out, FUT2, "data não mudou");
  assert.equal(b.status, "confirmed", "não cancelou");
  assert.match(r2.log.join("\n"), /Modo relatório: 1 alteração\(ões\) de data e 1 cancelamento/);
})));

test("I2 apply: atualiza datas na 1ª execução e cancela ausente na 2ª", quiet(withEnv("ICAL_RECONCILE", "apply", async () => {
  const db = setupDb([row("a", "21", "u1", FUT, FUT2), row("b", "21", "u2", FUT, FUT2)]);
  const feed = async () => ics([{ uid: "u1", ci: FUT, co: "2099-02-05" }]);
  const r1 = await runSync({ fetcher: feed });
  assert.equal(db.tables.reservations.find(r => r.id === "a").check_out, "2099-02-05");
  assert.equal(db.tables.reservations.find(r => r.id === "b").status, "confirmed", "1ª ausência só conta");
  assert.equal(r1.updated, 1);
  const r2 = await runSync({ fetcher: feed });
  assert.equal(db.tables.reservations.find(r => r.id === "b").status, "cancelled");
  assert.equal(r2.cancelled, 1);
})));

test("apply: feed vazio duas vezes não cancela nada", quiet(withEnv("ICAL_RECONCILE", "apply", async () => {
  const db = setupDb([row("a", "21", "u1", FUT, FUT2)]);
  const empty = async () => ics([]);
  await runSync({ fetcher: empty }); await runSync({ fetcher: empty });
  assert.equal(db.tables.reservations[0].status, "confirmed");
})));

test("apply: falha de rede não conta como ausência", quiet(withEnv("ICAL_RECONCILE", "apply", async () => {
  const db = setupDb([row("a", "21", "u1", FUT, FUT2)]);
  const boom = async () => { throw new Error("Timeout ao buscar iCal"); };
  await runSync({ fetcher: boom }); await runSync({ fetcher: boom });
  await runSync({ fetcher: async () => ics([{ uid: "x", ci: "2099-05-01", co: "2099-05-02" }]) });
  assert.equal(db.tables.reservations.find(r => r.id === "a").status, "confirmed", "1 ausência real só");
})));

test("I3: erro ao inserir aparece no resultado em vez de sumir", quiet(async () => {
  const db = setupDb([]);
  const origFrom = db.from;
  db.from = (t) => { const q = origFrom(t); if (t === "reservations") { const ins = q.insert;
    q.insert = (p) => { ins(p); return { then: (res) => res({ data: null, error: { code: "23P01" } }) }; }; } return q; };
  const r = await runSync({ fetcher: async () => ics([{ uid: "u1", ci: FUT, co: FUT2 }]) });
  assert.equal(r.failed, 1);
  assert.equal(r.added, 0);
  assert.match(r.log.join("\n"), /Não importado: Qto 21/);
}));

test("off: não reconcilia", quiet(withEnv("ICAL_RECONCILE", "off", async () => {
  const db = setupDb([row("b", "21", "u2", FUT, FUT2)]);
  const feed = async () => ics([{ uid: "u1", ci: FUT, co: FUT2 }]);
  await runSync({ fetcher: feed }); await runSync({ fetcher: feed });
  assert.equal(db.tables.reservations.find(r => r.id === "b").status, "confirmed");
})));

test("I7: logs do sync não trazem o SUMMARY do evento", async () => {
  setupDb([]);
  const lines = []; const o = [console.log, console.warn, console.error];
  console.log = console.warn = console.error = (m) => lines.push(String(m));
  try { await runSync({ fetcher: async () => ics([{ uid: "u1", ci: FUT, co: FUT2, s: "Nome Fictício Hóspede" }]) }); }
  finally { [console.log, console.warn, console.error] = o; }
  assert.doesNotMatch(lines.join("\n"), /Nome Fictício/);
});
