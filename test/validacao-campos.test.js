// PMS-004 (P1.2): campo inválido é recusado com 400, nunca trocado em silêncio.
// E editar pelo formulário não mexe mais no status. Dados fictícios.
"use strict";
process.env.JWT_SECRET = "segredo-so-de-teste";
process.env.SUPABASE_URL = "http://127.0.0.1:9";
process.env.SUPABASE_KEY = "chave-falsa";

const test = require("node:test");
const assert = require("node:assert/strict");
const { checkReservationInput } = require("../lib/reservation-input");
const { app, _setSupabaseForTests } = require("../server");
const { createFakeSupabase } = require("./helpers/fake-supabase");
const { ADMIN, STAFF } = require("./helpers/auth");
const { loadFrontend } = require("./helpers/frontend-harness");

let server, base;
test.before(async () => { server = app.listen(0); await new Promise(r => server.once("listening", r)); base = `http://127.0.0.1:${server.address().port}`; });
test.after(() => server.close());
const call = (method, p, auth, body) => fetch(base + p, { method, headers: { "Content-Type": "application/json", Authorization: auth },
  body: body ? JSON.stringify(body) : undefined }).then(async r => ({ status: r.status, body: await r.json().catch(() => null) }));
const quiet = (fn) => async () => { const o = [console.warn, console.error]; console.warn = console.error = () => {};
  try { await fn(); } finally { [console.warn, console.error] = o; } };

const cancelled = () => ({ id: "r1", room_id: "20", guest_name: "Hóspede Teste", check_in: "2030-05-10", check_out: "2030-05-12",
  status: "cancelled", source: "airbnb", amount: 750, payment: "pix", adults: 2, children: 0 });
const seed = (rows) => { const db = createFakeSupabase({ reservations: rows }); _setSupabaseForTests(db); return db; };
const NEW = { roomId: "21", guestName: "Hóspede Teste", checkIn: "2030-06-01", checkOut: "2030-06-03" };

test("regras: o que vale e o que não vale", () => {
  assert.equal(checkReservationInput({ status: "confirmed", source: "booking", payment: "cartao", adults: 3, children: 0, amount: 0 }), null);
  assert.equal(checkReservationInput({ adults: "", amount: "", payment: "", status: null }), null, "vazio = não informado");
  assert.equal(checkReservationInput({ adults: 0 }), null, "CF dividida pode dar 0 adulto por quarto");
  assert.match(checkReservationInput({ status: "canceled" }), /Status inválido/);
  assert.match(checkReservationInput({ source: "expedia" }), /Canal inválido/);
  assert.match(checkReservationInput({ payment: "cheque" }), /Forma de pagamento inválida/);
  assert.match(checkReservationInput({ amount: "abc" }), /Valor inválido/);
  assert.match(checkReservationInput({ amount: -10 }), /Valor inválido/);
  assert.match(checkReservationInput({ adults: 2.5 }), /adultos inválido/);
  assert.match(checkReservationInput({ children: -1 }), /crianças inválido/);
  assert.match(checkReservationInput({ adults: 41 }), /adultos inválido/);
  assert.match(checkReservationInput({ guestName: "  " }, { partial: true }), /não pode ficar vazio/);
  assert.match(checkReservationInput({ notes: "x".repeat(2001) }), /2000 caracteres/);
});

test("PUT com status digitado errado: 400 e a reserva cancelada continua cancelada", quiet(async () => {
  const db = seed([cancelled()]);
  const r = await call("PUT", "/reservations/r1", ADMIN(), { status: "canceled" });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /Status inválido/);
  assert.equal(db.tables.reservations[0].status, "cancelled", "antes virava confirmed (reativava)");
}));

test("PUT com valor inválido: 400 e o valor contratado não é apagado", quiet(async () => {
  const db = seed([cancelled()]);
  const r = await call("PUT", "/reservations/r1", ADMIN(), { amount: "abc" });
  assert.equal(r.status, 400);
  assert.equal(db.tables.reservations[0].amount, 750, "antes virava 0");
}));

test("PUT com canal inválido: 400 e a reserva continua do Airbnb", quiet(async () => {
  const db = seed([cancelled()]);
  assert.equal((await call("PUT", "/reservations/r1", STAFF(), { source: "expedia" })).status, 400);
  assert.equal(db.tables.reservations[0].source, "airbnb");
}));

test("PUT válido continua funcionando; nome vazio é recusado", quiet(async () => {
  const db = seed([cancelled()]);
  assert.equal((await call("PUT", "/reservations/r1", ADMIN(), { phone: "0000", amount: 800 })).status, 200);
  assert.equal(db.tables.reservations[0].amount, 800);
  assert.equal((await call("PUT", "/reservations/r1", STAFF(), { guestName: "" })).status, 400);
  assert.equal(db.tables.reservations[0].guest_name, "Hóspede Teste");
}));

test("POST e POST de grupo recusam campo inválido sem gravar nada", quiet(async () => {
  const db = seed([]);
  assert.equal((await call("POST", "/reservations", ADMIN(), { ...NEW, payment: "cheque" })).status, 400);
  const g = await call("POST", "/reservations/group", STAFF(), { rows: ["11", "12"].map((roomId, i) =>
    ({ ...NEW, id: "g" + i, roomId, children: i ? -1 : 0, notes: "[Suíte grupo:k]" })) });
  assert.equal(g.status, 400);
  assert.equal(db.tables.reservations.length, 0);
}));

test("POST de CF com 0 adulto por quarto continua aceito (grava 1)", quiet(async () => {
  const db = seed([]);
  const ALL = ["10", "11", "12", "20", "21", "22", "23", "24", "25"];
  const g = await call("POST", "/reservations/group", STAFF(), { rows: ALL.map((roomId, i) =>
    ({ ...NEW, id: "c" + i, roomId, adults: 0, children: 0, notes: "[Casa toda:z]" })) });
  assert.equal(g.status, 200, JSON.stringify(g.body));
  assert.ok(db.tables.reservations.every(r => r.adults === 1));
}));

test("tela: editar e salvar NÃO manda status (não reativa cancelada nem confirma pendente)", async () => {
  const fe = loadFrontend({ routes: [{ method: "PUT", path: "/reservations/r1", reply: () => ({ status: 200, json: { ok: true } }) }] });
  const fields = { "f-roomId": "20", "f-guestName": "Hóspede Teste", "f-checkIn": "2030-05-10", "f-checkOut": "2030-05-12",
    "f-source": "airbnb", "f-adults": "2", "f-children": "0", "f-phone": "0000", "f-notes": "" };
  const orig = fe.context.document;
  fe.context.document = new Proxy({}, { get: (t, k) => k === "getElementById"
    ? (id) => ({ value: fields[id] ?? "", style: {}, innerHTML: "", disabled: false }) : orig[k] });
  fe.run(`authToken = "t"; authRole = "staff"; alert = () => {}; confirm = () => true; loadAll = async () => {}; closeModal = () => {};
    reservations = [{ id: "r1", roomId: "20", guestName: "Hóspede Teste", checkIn: "2030-05-10", checkOut: "2030-05-12", status: "cancelled", source: "airbnb" }];`);
  await fe.run(`submitForm("r1")`);
  const put = fe.calls.find(c => c.method === "PUT");
  assert.ok(put, "fez o PUT");
  assert.equal(put.body.status, undefined);
});
