// PMS-006 (coluna de grupo): Casa Fechada e 11+12 editados/cancelados como um
// todo, num único UPDATE. Antes da migration (sem a coluna), nada muda.
// Supabase simulado; dados fictícios.
"use strict";
process.env.JWT_SECRET = "segredo-so-de-teste";
process.env.SUPABASE_URL = "http://127.0.0.1:9";
process.env.SUPABASE_KEY = "chave-falsa";

const test = require("node:test");
const assert = require("node:assert/strict");
const groups = require("../lib/groups");
const { app, runSync, _setSupabaseForTests, _resetIcalStateForTests } = require("../server");
const { createFakeSupabase } = require("./helpers/fake-supabase");
const { ADMIN, STAFF } = require("./helpers/auth");

let server, base;
test.before(async () => { server = app.listen(0); await new Promise(r => server.once("listening", r)); base = `http://127.0.0.1:${server.address().port}`; });
test.after(() => server.close());
const call = (method, p, auth, body) => fetch(base + p, { method, headers: { "Content-Type": "application/json", Authorization: auth },
  body: body ? JSON.stringify(body) : undefined }).then(async r => ({ status: r.status, body: await r.json().catch(() => null) }));
const quiet = (fn) => async () => { const o = [console.log, console.warn, console.error];
  console.log = console.warn = console.error = () => {}; try { await fn(); } finally { [console.log, console.warn, console.error] = o; } };
const enforce = (fn) => quiet(async () => { const p = process.env.AVAILABILITY_CHECK; process.env.AVAILABILITY_CHECK = "enforce";
  try { await fn(); } finally { if (p === undefined) delete process.env.AVAILABILITY_CHECK; else process.env.AVAILABILITY_CHECK = p; } });

const ALL = ["10", "11", "12", "20", "21", "22", "23", "24", "25"];
const cfRows = (gid = "cf:g1", extra = {}) => ALL.map((room, i) => ({ id: `c${i}`, room_id: room, guest_name: "Grupo Teste",
  check_in: "2030-06-10", check_out: "2030-06-12", status: "confirmed", source: "direto", notes: "[Casa toda:g1]",
  adults: 2, amount: i === 0 ? 9000 : 0, group_id: gid, ...extra }));
function seed(rows, opts) { const db = createFakeSupabase({ reservations: rows }, opts); _setSupabaseForTests(db); return db; }
const res = (db) => db.tables.reservations;

// ── Regras puras ────────────────────────────────────────────────────────────
test("grupo a partir das marcas: CF tem prioridade sobre suíte; import usa origem+UID", () => {
  assert.equal(groups.groupIdFromNotes("x [Casa toda:abc] [Suíte grupo:zz]"), "cf:abc");
  assert.equal(groups.groupIdFromNotes("[Suíte grupo:zz]"), "suite:zz");
  assert.equal(groups.groupIdFromNotes("Importado via iCal"), null);
  assert.equal(groups.groupIdFromNotes(null), null);
  assert.equal(groups.groupIdForImport("airbnb", "CF", "U1"), "cf:cf-U1");
  assert.equal(groups.groupIdForImport("airbnb", "11+12", "U1"), "suite:ical-airbnb-U1");
  assert.equal(groups.groupIdForImport("airbnb", "21", "U1"), null);
  assert.deepEqual(groups.splitGroupUpdate({ check_in: "a", notes: "n", amount: 1, status: "x" }),
    { group: { check_in: "a", status: "x" }, own: { notes: "n", amount: 1 } });
});

// ── Edição atômica ──────────────────────────────────────────────────────────
test("mudar datas de UMA linha da CF muda as 9, num único UPDATE", quiet(async () => {
  const db = seed(cfRows());
  const r = await call("PUT", "/reservations/c4", STAFF(), { checkIn: "2030-07-01", checkOut: "2030-07-04", roomId: "21" });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.group.rooms.length, 9);
  assert.ok(res(db).every(x => x.check_in === "2030-07-01" && x.check_out === "2030-07-04"));
  const ups = db.log.filter(l => l.table === "reservations" && l.op === "update");
  assert.equal(ups.length, 1, "um UPDATE só");
  assert.deepEqual(ups[0].filters, ["group_id"]);
}));

test("cancelar uma linha cancela o grupo inteiro", quiet(async () => {
  const db = seed(cfRows());
  assert.equal((await call("PUT", "/reservations/c7", STAFF(), { status: "cancelled" })).status, 200);
  assert.ok(res(db).every(x => x.status === "cancelled"));
}));

test("campos da linha (adultos, observações, valor) não se espalham pelo grupo", quiet(async () => {
  const db = seed(cfRows());
  const r = await call("PUT", "/reservations/c0", ADMIN(), { adults: 3, notes: "obs [Casa toda:g1]", amount: 9500, guestName: "Grupo Teste Novo" });
  assert.equal(r.status, 200);
  assert.equal(res(db).find(x => x.id === "c0").amount, 9500);
  assert.ok(res(db).filter(x => x.id !== "c0").every(x => x.amount === 0 && x.adults === 2 && x.notes === "[Casa toda:g1]"));
  assert.ok(res(db).every(x => x.guest_name === "Grupo Teste Novo"), "nome vale para o grupo");
}));

test("funcionário: valor ignorado também no grupo", quiet(async () => {
  const db = seed(cfRows());
  await call("PUT", "/reservations/c0", STAFF(), { amount: 1, checkOut: "2030-06-13" });
  assert.equal(res(db).find(x => x.id === "c0").amount, 9000);
  assert.ok(res(db).every(x => x.check_out === "2030-06-13"));
}));

test("trocar o quarto de uma linha do grupo é recusado e nada muda", quiet(async () => {
  const db = seed(cfRows());
  const r = await call("PUT", "/reservations/c4", STAFF(), { roomId: "10", checkIn: "2030-08-01", checkOut: "2030-08-02" });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /Casa Fechada/);
  assert.ok(res(db).every(x => x.check_in === "2030-06-10" && x.room_id !== undefined));
  assert.equal(db.log.filter(l => l.op === "update").length, 0);
}));

test("datas novas em conflito com outro quarto: 409 sem dados do outro hóspede e nada muda", enforce(async () => {
  const other = { id: "o1", room_id: "24", guest_name: "Outro Hóspede", phone: "0000", check_in: "2030-07-02", check_out: "2030-07-05", status: "confirmed", source: "booking" };
  const db = seed([...cfRows(), other]);
  const r = await call("PUT", "/reservations/c0", STAFF(), { checkIn: "2030-07-01", checkOut: "2030-07-03" });
  assert.equal(r.status, 409);
  assert.doesNotMatch(JSON.stringify(r.body), /Outro Hóspede|0000/);
  assert.ok(res(db).filter(x => x.group_id).every(x => x.check_in === "2030-06-10"));
  assert.equal(db.log.filter(l => l.op === "update").length, 0);
}));

test("datas inválidas no grupo: 400 e nada muda", quiet(async () => {
  const db = seed(cfRows());
  assert.equal((await call("PUT", "/reservations/c0", STAFF(), { checkIn: "2030-07-05", checkOut: "2030-07-01" })).status, 400);
  assert.equal(db.log.filter(l => l.op === "update").length, 0);
}));

test("suíte 11+12: só as 2 linhas do grupo mudam; reserva solta continua solta", quiet(async () => {
  const db = seed([
    { id: "s1", room_id: "11", guest_name: "Suíte Teste", check_in: "2030-06-10", check_out: "2030-06-12", status: "confirmed", group_id: "suite:x" },
    { id: "s2", room_id: "12", guest_name: "Suíte Teste", check_in: "2030-06-10", check_out: "2030-06-12", status: "confirmed", group_id: "suite:x" },
    { id: "a1", room_id: "20", guest_name: "Avulso Teste", check_in: "2030-06-10", check_out: "2030-06-12", status: "confirmed", group_id: null },
  ]);
  await call("PUT", "/reservations/s1", STAFF(), { checkOut: "2030-06-14" });
  assert.deepEqual(res(db).map(x => x.check_out), ["2030-06-14", "2030-06-14", "2030-06-12"]);
  await call("PUT", "/reservations/a1", STAFF(), { checkOut: "2030-06-13" });
  assert.deepEqual(res(db).map(x => x.check_out), ["2030-06-14", "2030-06-14", "2030-06-13"]);
}));

// ── Antes da migration: comportamento antigo ────────────────────────────────
test("sem a coluna group_id: edição continua linha a linha e criação de grupo não quebra", quiet(async () => {
  const rows = cfRows().map(({ group_id, ...r }) => r);
  const db = seed(rows, { missingColumns: { reservations: ["group_id"] } });
  const r = await call("PUT", "/reservations/c4", STAFF(), { checkOut: "2030-06-13" });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(res(db).filter(x => x.check_out === "2030-06-13").length, 1);
  const db2 = seed([], { missingColumns: { reservations: ["group_id"] } });
  const g = await call("POST", "/reservations/group", STAFF(), { rows: ["11", "12"].map((roomId, i) => ({ id: "n" + i, roomId,
    guestName: "Suíte Teste", checkIn: "2030-09-01", checkOut: "2030-09-02", notes: "[Suíte grupo:k]" })) });
  assert.equal(g.status, 200, JSON.stringify(g.body));
  assert.ok(res(db2).every(x => x.group_id === undefined));
}));

test("criação de grupo grava o mesmo group_id da marca nas notas", quiet(async () => {
  const db = seed([]);
  const g = await call("POST", "/reservations/group", STAFF(), { rows: ALL.map((roomId, i) => ({ id: "n" + i, roomId,
    guestName: "Grupo Teste", checkIn: "2030-09-01", checkOut: "2030-09-03", notes: "obs [Casa toda:abc]" })) });
  assert.equal(g.status, 200);
  assert.ok(res(db).every(x => x.group_id === "cf:abc"));
}));

test("importação iCal grava group_id para CF e 11+12 (igual ao backfill)", quiet(async () => {
  _resetIcalStateForTests();
  const ics = (uid, d) => ["BEGIN:VCALENDAR", "BEGIN:VEVENT", `UID:${uid}`, `DTSTART;VALUE=DATE:2099${d}01`, `DTEND;VALUE=DATE:2099${d}03`,
    "SUMMARY:Reserved", "END:VEVENT", "END:VCALENDAR"].join("\n");
  const db = createFakeSupabase({ reservations: [], settings: [{ key: "ical_urls", value: { airbnb: {
    "CF": "https://www.airbnb.com/calendar/ical/fake-cf.ics", "11+12": "https://www.airbnb.com/calendar/ical/fake-s.ics" }, booking: {} } }] });
  _setSupabaseForTests(db);
  await runSync({ fetcher: async (url) => (url.includes("fake-cf") ? ics("EV1", "02") : ics("EV2", "05")) });
  const cf = res(db).filter(x => /Casa Fechada/.test(x.notes));
  const su = res(db).filter(x => /Suíte 11\+12/.test(x.notes));
  assert.equal(cf.length, 9);
  assert.ok(cf.every(x => x.group_id === "cf:cf-EV1"));
  assert.equal(su.length, 2);
  assert.ok(su.every(x => x.group_id === "suite:ical-airbnb-EV2"));
}));
