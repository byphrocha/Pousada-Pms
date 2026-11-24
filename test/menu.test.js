// Menu legível: nome em cada item, 3 grupos, e "Mais" no celular com o resto.
// Garante que nenhuma tela some do menu e que o funcionário não vê itens de admin.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { loadFrontend } = require("./helpers/frontend-harness");

const html = fs.readFileSync(path.join(__dirname, "../build/index.html"), "utf8");
const sidebar = html.slice(html.indexOf('<div id="sidebar">'), html.indexOf('<div id="main">'));
const buttons = [...sidebar.matchAll(/<button class="nav-btn([^"]*)"[^>]*data-view="([^"]+)"[^>]*>([\s\S]*?)<\/button>/g)]
  .map(m => ({ cls: m[1], view: m[2], lbl: (m[3].match(/class="lbl">([^<]+)</) || [])[1] }));

test("menu lateral: toda tela tem botão com nome visível", () => {
  const views = [...html.matchAll(/currentView==="([a-z]+)"\)\s+el\.innerHTML/g)].map(m => m[1]);
  assert.equal(views.length, 10, "achou as telas do render()");
  for (const v of views) {
    const b = buttons.find(x => x.view === v);
    assert.ok(b, `tela ${v} sem botão no menu`);
    assert.ok(b.lbl && b.lbl.trim().length > 2, `tela ${v} sem nome no botão`);
  }
});

test("menu lateral: grupos na ordem Dia a dia, Dinheiro, Canais", () => {
  const groups = [...sidebar.matchAll(/class="nav-group[^"]*">([^<]+)</g)].map(m => m[1]);
  assert.deepEqual(groups, ["Dia a dia", "Dinheiro", "Canais"]);
});

test("'Mais' (celular) tem exatamente os itens fora da barra, com os mesmos nomes", () => {
  const fe = loadFrontend({});
  const extra = JSON.parse(fe.run("JSON.stringify(NAV_EXTRA)"));
  const main = JSON.parse(fe.run("JSON.stringify(NAV_MAIN)"));
  assert.deepEqual(main, ["map", "reservas", "calendario", "hospedes"]);
  const sideExtra = buttons.filter(b => b.cls.includes("nav-extra"));
  assert.deepEqual(extra.map(e => [e.view, e.lbl]), sideExtra.map(b => [b.view, b.lbl]));
  for (const b of buttons) assert.ok(main.includes(b.view) || extra.some(e => e.view === b.view), `${b.view} inacessível no celular`);
  for (const b of sideExtra) assert.equal(b.cls.includes("admin-only"), extra.find(e => e.view === b.view).admin, b.view);
});

test("'Mais': admin vê Dinheiro e Canais; funcionário só Minha conta", () => {
  const fe = loadFrontend({});
  fe.run(`authRole = "admin"; currentView = "sync"; navAlertCount = 2;`);
  const a = fe.run("moreMenuHtml()");
  assert.match(a, /Dinheiro[\s\S]*Financeiro[\s\S]*Relatórios[\s\S]*Canais[\s\S]*Alertas/);
  assert.match(a, /more-item active"[^>]*showView\('sync'\)/);
  assert.match(a, /more-item has-alert"[^>]*showView\('alertas'\)/);
  fe.run(`authRole = "staff"; currentView = "map";`);
  const s = fe.run("moreMenuHtml()");
  assert.doesNotMatch(s, /Financeiro|Relatórios|Alertas|Sincronizar/);
  assert.match(s, /Minha conta/);
});

test("alerta de overbooking marca o botão sem apagar o nome", () => {
  assert.doesNotMatch(html, /alertBtn\.innerHTML/);
  assert.match(html, /classList\.toggle\("has-alert", alertCount > 0\)/);
});

test("visual: sem fonte monoespaçada no corpo e rótulos sem caixa alta no CSS base", () => {
  assert.match(html, /body\{[^}]*font-family:var\(--font\)/);
  assert.doesNotMatch(html, /font-family:'DM Mono',monospace/);
  assert.doesNotMatch(html.match(/\.field label\{[^}]*\}/)[0], /uppercase/);
});
