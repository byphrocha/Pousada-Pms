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

test("blocos repetidos viraram classes CSS com as mesmas regras, e não voltam a ser escritos à mão", () => {
  const fs = require("fs"), path = require("path");
  const { BUILD, scripts } = require("./helpers/frontend-source");
  const css = fs.readFileSync(path.join(BUILD, "css/app.css"), "utf8");
  for (const [cls, rule] of [
    ["card-panel", "background:var(--bg1);border:1px solid var(--bd);border-radius:12px;padding:16px"],
    ["meta", "font-size:11px;color:var(--mu);margin-top:3px"],
    ["meta-tight", "font-size:11px;color:var(--mu);margin-top:2px"],
    ["stack", "display:flex;flex-direction:column;gap:6px"],
  ]) assert.ok(css.includes(`.${cls}{${rule}}`), cls);
  const js = scripts().map(s => s.code).join("\n");
  for (const inline of ['style="background:var(--bg1);border:1px solid var(--bd);border-radius:12px;padding:16px"',
    'style="font-size:11px;color:var(--mu);margin-top:3px"', 'style="font-size:11px;color:var(--mu);margin-top:2px"',
    'style="width:96px;font-size:12px;font-weight:700;color:var(--bl);flex-shrink:0"'])
    assert.ok(!js.includes(inline), inline);
});

test("linha de link (nome · link · Copiar): uma função só, com escape", () => {
  const h = run(`copyUrlRow("Quarto <b>", "https://x.test/a\\"b")`);
  assert.match(h, /class="url-row"/);
  assert.match(h, /class="url-label">Quarto &lt;b&gt;</);
  assert.doesNotMatch(h, /<b>/);
});
