// Regressão dos achados F1/F2/F4 e D4/D5 da revisão (frontend).
// Dados 100% fictícios.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { loadFrontend } = require("./helpers/frontend-harness");

const FORM = {
  "f-roomId": "20", "f-guestName": "Hóspede Teste", "f-checkIn": "2030-03-10",
  "f-checkOut": "2030-03-12", "f-source": "direto", "f-adults": "2", "f-children": "0",
  "f-phone": "", "f-notes": "", "f-amount": "500", "f-payment": "pix", "f-email": "",
};

// Servidor falso: POST /reservations devolve a própria linha; regras extras por teste.
function okReservations(extra = []) {
  return [
    ...extra,
    { method: "POST", path: "/reservations", reply: ({ body }) => ({ status: 200, json: { ok: true, reservation: { ...body, room_id: body.roomId, check_in: body.checkIn, check_out: body.checkOut } } }) },
    { method: "POST", path: "/transactions", reply: ({ body }) => ({ status: 200, json: body }) },
    { method: "PUT", path: /^\/reservations\//, reply: () => ({ status: 200, json: { ok: true } }) },
    { method: "PUT", path: /^\/transactions\//, reply: ({ body }) => ({ status: 200, json: body }) },
  ];
}

function setup({ role = "admin", fields = FORM, routes = okReservations(), reservations = "[]" } = {}) {
  const fe = loadFrontend({ fields, routes });
  fe.run(`authRole = ${JSON.stringify(role)}; reservations = ${reservations}; transactions = [];`);
  return fe;
}

const posts = (calls, p) => calls.filter(c => c.method === "POST" && c.path === p);

test("F1: nova reserva direta — lançamento aponta para o id realmente gravado", async () => {
  const fe = setup();
  await fe.run(`submitForm(null)`);
  const [resv] = posts(fe.calls, "/reservations");
  const [tx] = posts(fe.calls, "/transactions");
  assert.ok(resv, "reserva enviada");
  assert.ok(tx, "lançamento enviado");
  assert.equal(tx.body.reservation_id, resv.body.id);
});

test("F1/F4: lançamento só é enviado depois da reserva", async () => {
  const fe = setup();
  await fe.run(`submitForm(null)`);
  const iRes = fe.calls.findIndex(c => c.method === "POST" && c.path === "/reservations");
  const iTx  = fe.calls.findIndex(c => c.method === "POST" && c.path === "/transactions");
  assert.ok(iRes >= 0 && iTx > iRes);
});

test("F4: se o servidor recusa a reserva, nenhum lançamento é criado e o usuário é avisado", async () => {
  const fe = setup({ routes: [
    { method: "POST", path: "/reservations", reply: () => ({ status: 409, json: { error: { code: "ROOM_CONFLICT", message: "x", rooms: ["20"] } } }) },
  ]});
  await fe.run(`submitForm(null)`);
  assert.equal(posts(fe.calls, "/transactions").length, 0);
  assert.match(fe.alerts.join("\n"), /indisponível/);
});

test("F2: edição sem lançamento vinculado NÃO cria lançamento novo", async () => {
  const existing = JSON.stringify([{ id: "abc123", roomId: "20", guestName: "Hóspede Teste", checkIn: "2030-03-10", checkOut: "2030-03-12", status: "confirmed", source: "direto" }]);
  const fe = setup({ reservations: existing, routes: okReservations([
    { method: "GET", path: "/transactions?reservation_id=abc123", reply: () => ({ status: 200, json: [] }) },
  ])});
  await fe.run(`submitForm("abc123")`);
  assert.equal(posts(fe.calls, "/transactions").length, 0);
  assert.match(fe.alerts.join("\n"), /Não há lançamento financeiro vinculado/);
});

test("F2: edição com lançamento vinculado atualiza o mesmo lançamento", async () => {
  const existing = JSON.stringify([{ id: "abc123", roomId: "20", guestName: "Hóspede Teste", checkIn: "2030-03-10", checkOut: "2030-03-12", status: "confirmed", source: "direto" }]);
  const fe = setup({ reservations: existing, routes: okReservations([
    { method: "GET", path: "/transactions?reservation_id=abc123", reply: () => ({ status: 200, json: [{ id: "tx1", reservation_id: "abc123", type: "income", amount: 300, date: "2030-03-10" }] }) },
  ])});
  await fe.run(`submitForm("abc123")`);
  assert.equal(posts(fe.calls, "/transactions").length, 0);
  const put = fe.calls.find(c => c.method === "PUT" && c.path === "/transactions/tx1");
  assert.ok(put);
  assert.equal(put.body.amount, 500);
});

test("Funcionário (staff): não tenta criar lançamento (rota é só de admin)", async () => {
  const fe = setup({ role: "staff" });
  await fe.run(`submitForm(null)`);
  assert.equal(posts(fe.calls, "/reservations").length, 1);
  assert.equal(posts(fe.calls, "/transactions").length, 0);
});

test("D4: CF com um quarto ocupado é barrada antes de gravar qualquer linha", async () => {
  const busy = JSON.stringify([{ id: "x1", roomId: "23", guestName: "Outro", checkIn: "2030-03-11", checkOut: "2030-03-13", status: "confirmed" }]);
  const fe = setup({ reservations: busy, fields: { ...FORM, "f-roomId": "CF" } });
  await fe.run(`submitForm(null)`);
  assert.equal(posts(fe.calls, "/reservations").length, 0);
  assert.match(fe.alerts.join("\n"), /Quarto 23/);
});

test("Datas adjacentes não são conflito (check-out = check-in)", async () => {
  const prev = JSON.stringify([{ id: "x1", roomId: "20", guestName: "Outro", checkIn: "2030-03-08", checkOut: "2030-03-10", status: "confirmed" }]);
  const fe = setup({ reservations: prev });
  await fe.run(`submitForm(null)`);
  assert.equal(posts(fe.calls, "/reservations").length, 1);
});

test("11+12: duas linhas e lançamento vinculado à primeira linha criada", async () => {
  const fe = setup({ fields: { ...FORM, "f-roomId": "11+12" } });
  await fe.run(`submitForm(null)`);
  const rs = posts(fe.calls, "/reservations");
  assert.deepEqual(rs.map(r => r.body.roomId), ["11", "12"]);
  const [tx] = posts(fe.calls, "/transactions");
  assert.equal(tx.body.reservation_id, rs[0].body.id);
});

test("D5/CF: falha no 5º quarto cancela os 4 já criados e não lança receita", async () => {
  let n = 0;
  const fe = setup({ fields: { ...FORM, "f-roomId": "CF" }, routes: okReservations([
    { method: "POST", path: "/reservations", reply: ({ body }) => (++n === 5
      ? { status: 409, json: { error: { code: "ROOM_CONFLICT", message: "x", rooms: [body.roomId] } } }
      : { status: 200, json: { ok: true, reservation: { ...body } } }) },
  ])});
  await fe.run(`submitForm(null)`);
  const created = posts(fe.calls, "/reservations").slice(0, 4).map(c => c.body.id);
  const cancelled = fe.calls.filter(c => c.method === "PUT" && c.body && c.body.status === "cancelled").map(c => c.path.split("/").pop());
  assert.deepEqual(cancelled.sort(), created.sort());
  assert.equal(posts(fe.calls, "/transactions").length, 0);
  assert.match(fe.alerts.join("\n"), /foram cancelados/);
});

test("Casa Fechada pelo botão próprio: conflito barra antes de gravar", async () => {
  const busy = JSON.stringify([{ id: "x1", roomId: "10", guestName: "Outro", checkIn: "2030-03-10", checkOut: "2030-03-11", status: "confirmed" }]);
  const fe = setup({ reservations: busy, fields: { "ct-guestName": "Grupo Teste", "ct-checkIn": "2030-03-10", "ct-checkOut": "2030-03-12", "ct-source": "direto", "ct-adults": "18", "ct-children": "0", "ct-phone": "", "ct-notes": "" } });
  await fe.run(`submitCasaToda()`);
  assert.equal(posts(fe.calls, "/reservations").length, 0);
});

test("F2: editar quarto não-principal de CF não mostra aviso de lançamento ausente", async () => {
  const existing = JSON.stringify([{ id: "cf2", roomId: "11", guestName: "Grupo Teste", checkIn: "2030-03-10", checkOut: "2030-03-12", status: "confirmed", source: "direto", notes: " [Casa toda:g1]" }]);
  const fe = setup({ reservations: existing, fields: { ...FORM, "f-roomId": "11", "f-notes": " [Casa toda:g1]" }, routes: okReservations([
    { method: "GET", path: "/transactions?reservation_id=cf2", reply: () => ({ status: 200, json: [] }) },
  ])});
  await fe.run(`submitForm("cf2")`);
  assert.equal(posts(fe.calls, "/transactions").length, 0);
  assert.doesNotMatch(fe.alerts.join("\n"), /Não há lançamento/);
});
