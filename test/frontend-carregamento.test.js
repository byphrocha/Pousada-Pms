// PMS-012: falha ao carregar não pode virar "lista vazia" (achados F4 / P1.3). Dados fictícios.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { loadFrontend } = require("./helpers/frontend-harness");

const R1 = { id: "r1", room_id: "20", guest_name: "Hóspede Teste", check_in: "2030-03-10", check_out: "2030-03-12", status: "confirmed", source: "direto" };
const ok = (json) => () => ({ status: 200, json });
const fail = () => ({ status: 500, json: { error: "falha simulada" } });

function setup(routes, role = "admin") {
  const fe = loadFrontend({ routes, keep: ["loadAll", "loadTransactions"] });
  fe.run(`authRole = ${JSON.stringify(role)};`);
  return fe;
}
const base = (over = {}) => [
  { method: "GET", path: "/reservations", reply: over.reservations || ok([R1]) },
  { method: "GET", path: "/guests", reply: over.guests || ok([]) },
  { method: "GET", path: "/room-states", reply: over.states || ok({ cleaned: ["20"], checkedIn: [] }) },
  { method: "GET", path: "/urls", reply: ok({ booking: {}, airbnb: {} }) },
  { method: "GET", path: /^\/transactions/, reply: over.txns || ok([{ id: "t1" }]) },
  { method: "GET", path: "/prereservations", reply: ok([]) },
];

test("carregamento normal: sem aviso", async () => {
  const fe = setup(base());
  await fe.run("loadAll()");
  assert.equal(fe.run("reservations.length"), 1);
  assert.equal(fe.run("loadError"), null);
});

test("HTTP 500 nas reservas mantém a lista anterior e mostra aviso", async () => {
  let n = 0;
  const fe = setup(base({ reservations: () => (++n === 1 ? { status: 200, json: [R1] } : fail()) }));
  await fe.run("loadAll()");
  await fe.run("loadAll()");
  assert.equal(fe.run("reservations.length"), 1, "não virou lista vazia");
  assert.match(fe.run("loadError"), /reservas/);
});

test("falha de rede na primeira carga: aviso de que nada foi carregado", async () => {
  const fe = setup(base({ reservations: () => ({ status: 200, json: { _networkError: true, error: "Erro de conexão" } }) }));
  await fe.run("loadAll()");
  assert.equal(fe.run("reservationsLoaded"), false);
  assert.match(fe.run("loadError"), /reservas/);
});

test("falha só no financeiro não apaga os lançamentos já carregados", async () => {
  let n = 0;
  const fe = setup(base({ txns: () => (++n === 1 ? { status: 200, json: [{ id: "t1" }] } : fail()) }));
  await fe.run("loadAll()");
  await fe.run("loadAll()");
  assert.equal(fe.run("transactions.length"), 1);
  assert.match(fe.run("loadError"), /financeiro/);
});

test("falha em limpeza/check-in não zera os quartos marcados", async () => {
  let n = 0;
  const fe = setup(base({ states: () => (++n === 1 ? { status: 200, json: { cleaned: ["20"], checkedIn: [] } } : fail()) }));
  await fe.run("loadAll()");
  await fe.run("loadAll()");
  assert.equal(fe.run("cleanedRooms.has('20')"), true);
});

test("depois de uma falha, um carregamento bom limpa o aviso", async () => {
  let n = 0;
  const fe = setup(base({ reservations: () => (++n === 1 ? fail() : { status: 200, json: [R1] }) }));
  await fe.run("loadAll()");
  assert.ok(fe.run("loadError"));
  await fe.run("loadAll()");
  assert.equal(fe.run("loadError"), null);
});

test("funcionário: não acusa falha em rotas que são só de admin", async () => {
  const fe = setup(base(), "staff");
  await fe.run("loadAll()");
  assert.equal(fe.run("loadError"), null);
  assert.equal(fe.calls.filter(c => c.path.startsWith("/transactions")).length, 0);
});

test("loadTransactions com erro mantém a lista e avisa", async () => {
  const fe = setup([{ method: "GET", path: /^\/transactions/, reply: fail }]);
  fe.run("transactions = [{ id: 't1' }];");
  await fe.run("loadTransactions('2030-03')");
  assert.equal(fe.run("transactions.length"), 1);
  assert.match(fe.run("loadError"), /financeiro/);
});
