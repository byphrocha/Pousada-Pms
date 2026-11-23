// Contagem de reservas por hóspede. Dados fictícios.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { loadFrontend } = require("./helpers/frontend-harness");

const R = (id, o) => ({ id, roomId: "20", guestName: "Reserved", phone: "", status: "confirmed", notes: "", checkIn: "2030-01-01", checkOut: "2030-01-02", ...o });
function setup(res) {
  const fe = loadFrontend();
  fe.run(`reservations = ${JSON.stringify(res)};`);
  return fe;
}

test("hóspede sem telefone não herda as reservas importadas sem telefone", () => {
  const fe = setup([R("a"), R("b"), R("c"), R("d", { guestName: "Ana Teste" })]);
  assert.equal(fe.run(`guestStayCount({ name: "Ana Teste", phone: "" })`), 1);
});

test("casa por telefone (só dígitos, mínimo 8)", () => {
  const fe = setup([R("a", { guestName: "Outro Nome", phone: "(44) 99999-0000" }), R("b", { phone: "123" })]);
  assert.equal(fe.run(`guestStayCount({ name: "Ana Teste", phone: "44999990000" })`), 1);
  assert.equal(fe.run(`guestStayCount({ name: "Bia Teste", phone: "123" })`), 0, "telefone curto não casa");
});

test("nome com maiúsculas/espaços diferentes ainda casa", () => {
  const fe = setup([R("a", { guestName: "  ana   TESTE " })]);
  assert.equal(fe.run(`guestStayCount({ name: "Ana Teste", phone: "" })`), 1);
});

test("Casa Fechada (9 linhas) e 11+12 (2 linhas) contam como uma estadia cada", () => {
  const cf = ["10","11","12","20","21","22","23","24","25"].map((q, i) => R("cf" + i, { roomId: q, guestName: "Grupo Teste", notes: "x [Casa toda:g1]" }));
  const su = ["11","12"].map((q, i) => R("su" + i, { roomId: q, guestName: "Grupo Teste", notes: "[Suíte grupo:s1]" }));
  const fe = setup([...cf, ...su]);
  assert.equal(fe.run(`guestStayCount({ name: "Grupo Teste", phone: "" })`), 2);
});

test("canceladas não contam", () => {
  const fe = setup([R("a", { guestName: "Ana Teste", status: "cancelled" }), R("b", { guestName: "Ana Teste" })]);
  assert.equal(fe.run(`guestStayCount({ name: "Ana Teste", phone: "" })`), 1);
});
