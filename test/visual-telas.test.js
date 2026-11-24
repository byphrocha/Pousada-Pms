// Padrão visual das telas: títulos em letra normal (sem MAIÚSCULAS espaçadas) e
// correções de leitura no Financeiro (lista empilhada no celular, data dd/mm/aaaa).
// Dados fictícios.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { loadFrontend } = require("./helpers/frontend-harness");

const html = fs.readFileSync(path.join(__dirname, "../build/index.html"), "utf8");

test("nenhum rótulo com espaçamento de caixa alta nos estilos inline", () => {
  const inline = [...html.matchAll(/style="[^"]*letter-spacing:\.(0[5-9]|1)\d*em/g)];
  assert.equal(inline.length, 0);
});

test("títulos de seção que eram MAIÚSCULOS agora em letra normal", () => {
  for (const old of ["ALTERAR SENHA", "DISTRIBUIÇÃO DO MÊS", "URLS POR QUARTO", "QUARTOS INDIVIDUAIS",
    "FLUXO COMPLETO ANTI-OVERBOOKING", "🕘 HISTÓRICO", "💳 PAGAMENTOS", "\"ENTRADAS\"", "\"SAÍDAS\"", "AGENDA HOJE"])
    assert.ok(!html.includes(old), old);
});

test("Financeiro: lista com data em dd/mm/aaaa e empilhada no celular", () => {
  const fe = loadFrontend({});
  const h = fe.run(`renderFinList("expense", [{ id: "t1", type: "expense", category: "manutencao", description: "Conserto <b>x</b>", amount: 85.5, date: "2030-03-07" }])`);
  assert.match(h, /07\/03\/2030/);
  assert.doesNotMatch(h, /2030-03-07/);
  assert.match(h, />Saídas</);
  assert.doesNotMatch(h, /<b>x<\/b>/);
  assert.match(html, /class="fin-lists"/);
  assert.match(html, /\.fin-lists\{grid-template-columns:1fr !important\}/);
});

test("Financeiro: valores do topo não quebram linha", () => {
  assert.match(html, /\.fin-kpi\{[^}]*white-space:nowrap/);
  assert.equal((html.match(/class="fin-kpi"/g) || []).length, 3);
});
