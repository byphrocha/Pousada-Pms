// PMS-012: gravação com erro não pode parecer sucesso. api() trata sessão
// expirada e resposta que não é JSON; apiWrite() mantém o formulário aberto e
// mostra o motivo. Dados fictícios.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { loadFrontend } = require("./helpers/frontend-harness");

function fe(routes, fields = {}) {
  const f = loadFrontend({ routes });
  const orig = f.context.document;
  // Formulário simulado: getElementById devolve os valores do teste; o resto
  // continua vindo do DOM simulado do harness.
  f.context.document = new Proxy({}, { get: (t, k) => k === "getElementById"
    ? (id) => ({ value: fields[id] ?? "", style: {}, innerHTML: "" }) : orig[k] });
  f.run(`authToken = "t"; var closed = 0, loginShown = 0, alerts2 = [];
    closeModal = () => { closed++; }; showLoginScreen = () => { loginShown++; }; alert = (m) => alerts2.push(m);
    confirm = () => true; loadAll = async () => {}; loadTransactions = async () => {};`);
  return f;
}
const routeOf = (method, path, reply) => ({ method, path, reply });

test("api(): resposta que não é JSON (502 do proxy) vira erro com mensagem, não exceção", async () => {
  const f = fe([routeOf("GET", "/x", () => ({ status: 502, text: "<html>Bad Gateway</html>" }))]);
  const r = JSON.parse(JSON.stringify(await f.run(`api("GET", "/x")`)));
  assert.match(r.error, /respondeu de forma inesperada \(HTTP 502\)/);
  assert.match(f.run(`apiErrorMessage(${JSON.stringify(r)})`), /HTTP 502/);
});

test("api(): sessão expirada (401) volta ao login e NÃO conta como sucesso", async () => {
  const f = fe([routeOf("POST", "/guests", () => ({ status: 401, json: { error: "Token inválido" } }))]);
  const r = JSON.parse(JSON.stringify(await f.run(`api("POST", "/guests", {})`)));
  assert.equal(f.run("loginShown"), 1);
  assert.notEqual(f.run(`apiErrorMessage(${JSON.stringify(r)})`), null, "antes {} era lido como sucesso");
});

test("api(): falha de rede continua com a mensagem de conexão", async () => {
  const f = fe([routeOf("GET", "/x", () => { throw new Error("rede"); })]);
  const r = await f.run(`api("GET", "/x")`);
  assert.match(f.run(`apiErrorMessage(${JSON.stringify(JSON.parse(JSON.stringify(r)))})`), /Erro de conexão/);
});

const TX = { "ft-type": "expense", "ft-cat": "manutencao", "ft-desc": "Conserto teste", "ft-amount": "85.5", "ft-date": "2030-03-07" };

test("Financeiro: erro ao salvar mantém o formulário aberto e mostra o motivo", async () => {
  const f = fe([routeOf("POST", "/transactions", () => ({ status: 500, json: { error: "Erro interno" } }))], TX);
  await f.run(`saveTransaction(null)`);
  assert.equal(f.run("closed"), 0, "não fecha o formulário");
  assert.match(f.run("alerts2.join('|')"), /Não foi possível salvar o lançamento: Erro interno/);
});

test("Financeiro: sucesso fecha o formulário; editar usa PUT", async () => {
  const f = fe([routeOf("PUT", "/transactions/t1", () => ({ status: 200, json: { ok: true } }))], TX);
  await f.run(`saveTransaction("t1")`);
  assert.equal(f.run("closed"), 1);
  assert.equal(f.run("alerts2.length"), 0);
});

test("Financeiro: excluir com erro não fecha nem finge que excluiu", async () => {
  const f = fe([routeOf("DELETE", "/transactions/t1", () => ({ status: 403, json: { error: "Apenas administradores" } }))]);
  await f.run(`deleteTransaction("t1")`);
  assert.equal(f.run("closed"), 0);
  assert.match(f.run("alerts2.join('|')"), /Não foi possível excluir o lançamento: Apenas administradores/);
});

test("Hóspedes: salvar e excluir com erro mantêm o formulário e avisam", async () => {
  const f = fe([routeOf("POST", "/guests", () => ({ status: 502, text: "<html>" })),
                routeOf("DELETE", "/guests/g1", () => ({ status: 500, json: { error: "Erro interno" } }))], { "g-name": "Hóspede Teste" });
  await f.run(`saveGuest(null)`);
  await f.run(`deleteGuest("g1")`);
  assert.equal(f.run("closed"), 0);
  const a = f.run("alerts2.join('|')");
  assert.match(a, /Não foi possível salvar o hóspede: O servidor respondeu de forma inesperada \(HTTP 502\)/);
  assert.match(a, /Não foi possível excluir o hóspede: Erro interno/);
});

test("Pré-reservas: salvar e excluir com erro mantêm o formulário e avisam; sucesso fecha", async () => {
  const f = fe([routeOf("POST", "/prereservations", () => ({ status: 500, json: { error: "Erro interno" } })),
                routeOf("PUT", "/prereservations/p1", () => ({ status: 200, json: { ok: true } })),
                routeOf("DELETE", "/prereservations/p1", () => { throw new Error("rede"); })], { "pr-name": "Pré Teste", "pr-room": "20" });
  await f.run(`savePreReserva(null)`);
  await f.run(`deletePreReserva("p1")`);
  assert.equal(f.run("closed"), 0);
  assert.match(f.run("alerts2.join('|')"), /salvar a pré-reserva: Erro interno.*excluir a pré-reserva: Erro de conexão/s);
  await f.run(`savePreReserva("p1")`);
  assert.equal(f.run("closed"), 1);
});
