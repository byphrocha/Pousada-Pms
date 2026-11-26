// PMS-017: nomes de produto e faixas de datas num lugar só (01-base-estado-api.js).
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { loadFrontend } = require("./helpers/frontend-harness");
const fe = loadFrontend({});
const run = (code) => fe.run(code);

test("productName: as formas usadas nas telas", () => {
  assert.equal(run(`productName("CF")`), "Casa Fechada");
  assert.equal(run(`productName("11+12")`), "suíte 11+12");
  assert.equal(run(`productName("21")`), "quarto 21");
  assert.equal(run(`productName("11+12", { cap: true })`), "Suíte 11+12");
  assert.equal(run(`productName("21", { cap: true })`), "Quarto 21");
  assert.equal(run(`productName("CF", { article: true })`), "a Casa Fechada");
  assert.equal(run(`productName("11+12", { article: true })`), "a suíte 11+12");
  assert.equal(run(`productName("21", { article: true })`), "o quarto 21");
  assert.equal(run(`productName(20)`), "quarto 20");
});

test("fmtRange: entrada → saída no formato da tela; data vazia vira —", () => {
  assert.equal(run(`fmtRange("2030-12-24", "2030-12-26")`), run(`fmtDate("2030-12-24")`) + " → " + run(`fmtDate("2030-12-26")`));
  assert.match(run(`fmtRange("2030-12-24", "")`), / → —$/);
});

test("nenhuma tela monta mais o nome do produto ou a faixa de datas na mão", () => {
  const { fullPage } = require("./helpers/frontend-source");
  // A própria definição de fmtRange é o único lugar com o padrão.
  const page = fullPage().replace(/const fmtRange  = .*\n/, "");
  assert.doesNotMatch(page, /"suíte 11\+12" : "quarto " \+/);
  assert.doesNotMatch(page, /fmtDate\([^)]*\)\} → \$\{fmtDate/);
  assert.doesNotMatch(page, /fmtDate\([^)]*\)\+" → "\+fmtDate/);
});
