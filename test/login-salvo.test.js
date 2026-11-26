// Abrir o app com login salvo não pede usuário e senha de novo; sessão expirada
// (401) volta para o login. Dados fictícios.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { loadFrontend } = require("./helpers/frontend-harness");

const inicio = fs.readFileSync(path.join(__dirname, "..", "build", "js", "15-inicio.js"), "utf8");

test("com login salvo, a tela de login é escondida antes de carregar os dados", () => {
  const bloco = inicio.match(/if \(authToken\) \{([\s\S]*?)\n\}/);
  assert.ok(bloco, "bloco de início com login salvo");
  const corpo = bloco[1];
  assert.match(corpo, /hideLoginScreen\(\)/);
  assert.ok(corpo.indexOf("hideLoginScreen()") < corpo.indexOf("loadAll()"), "esconde antes de carregar (sem piscar)");
});

test("sessão expirada (401) limpa o login salvo e mostra a tela de login", async () => {
  const fe = loadFrontend({ routes: [{ method: "GET", path: "/reservations", reply: () => ({ status: 401, json: {} }) }] });
  fe.run(`authToken = "token-ficticio"; localStorage.setItem("pms_token", "token-ficticio");
    globalThis.__login = 0; showLoginScreen = () => { globalThis.__login++; };`);
  const res = await fe.run(`api("GET", "/reservations")`);
  assert.match(res.error, /sessão expirou/);
  assert.equal(fe.run(`globalThis.__login`), 1);
  assert.equal(fe.run(`authToken`), "");
  assert.equal(fe.run(`localStorage.getItem("pms_token")`), null);
});
