// Mapa no celular: nome longo de hóspede não alarga a coluna nem faz a tela
// rolar para o lado. Conferido também renderizando em 390 e 320 px.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const css = fs.readFileSync(path.join(__dirname, "..", "build", "css", "app.css"), "utf8");
const mobile = css.slice(css.indexOf("/* Room grid: menor"));

test("grades do Mapa no celular encolhem (minmax(0,1fr))", () => {
  assert.match(mobile, /\.room-grid\{grid-template-columns:repeat\(3,minmax\(0,1fr\)\)/);
  assert.match(css, /\.kpi-grid\{grid-template-columns:repeat\(5,minmax\(0,1fr\)\)/);
  assert.doesNotMatch(css, /\.(room|kpi)-grid\{grid-template-columns:repeat\(\d,1fr\)/);
});

test("cartão de quarto e suíte não usam o nome inteiro como largura mínima", () => {
  assert.match(css, /\.room-card\{[^}]*min-width:0/);
  assert.match(css, /\.suite-rooms \.room-card\{[^}]*min-width:0/);
  assert.match(css, /\.suite-group\{[^}]*min-width:0/);
  assert.match(css, /\.rc-guest\{[^}]*text-overflow:ellipsis/);
});
