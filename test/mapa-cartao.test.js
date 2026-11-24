// Cartão de quarto do Mapa (visual novo): estado escrito (não só cor), hóspede
// escapado, data de saída e botões só no estado certo. Dados fictícios.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { loadFrontend } = require("./helpers/frontend-harness");

const fe = loadFrontend({});
const card = (st, res, cf = false) =>
  fe.run(`roomCardHtml(ROOMS.find(r => r.id === "23"), ${JSON.stringify(st)}, ${JSON.stringify(res)}, ${cf})`);
const res = { guestName: "Hóspede Teste", checkIn: "2030-03-02", checkOut: "2030-03-05" };

test("estado aparece escrito em todos os casos", () => {
  for (const [st, lbl] of [["free", "Livre"], ["occupied", "Ocupado"], ["checkin", "Check-in"], ["checkout", "Check-out"], ["cleaning", "Limpeza"]])
    assert.match(card(st, null), new RegExp(`class="rc-chip">[^<]*${lbl}<`), st);
});

test("ocupado mostra hóspede e data de saída; livre não mostra hóspede", () => {
  const h = card("occupied", res);
  assert.match(h, /class="rc-guest">Hóspede Teste</);
  assert.match(h, /sai 05\/03/);
  assert.doesNotMatch(card("free", null), /rc-guest|sai /);
});

test("nome do hóspede escapado no cartão e no title", () => {
  const h = card("occupied", { ...res, guestName: `<img src=x onerror=alert(1)>"` });
  assert.doesNotMatch(h, /<img src=x/);
  assert.match(h, /&lt;img/);
});

test("botão de check-in só em check-in; de limpeza só em limpeza; nenhum na Casa Fechada", () => {
  assert.match(card("checkin", res), /markCheckedIn\('23'/);
  assert.doesNotMatch(card("checkin", res), /markClean/);
  assert.match(card("cleaning", null), /markClean\('23'/);
  assert.doesNotMatch(card("occupied", res), /markCheckedIn|markClean/);
  assert.doesNotMatch(card("checkin", res, true), /markCheckedIn/);
  assert.doesNotMatch(card("cleaning", null, true), /markClean/);
});

test("quartos 11 e 12 mostram a climatização real (antes era 'Vent.' fixo)", () => {
  const h = fe.run(`roomCardHtml({ id: "11", type: "Triplo", climate: "AC" }, "free", null, false)`);
  assert.match(h, /❄ AC/);
});

test("nome genérico do iCal vira canal + 'sem nome'; bloqueio do Airbnb identificado", () => {
  const g = (r) => JSON.parse(fe.run(`JSON.stringify(guestDisplay(${JSON.stringify(r)}))`));
  assert.deepEqual(g({ guestName: "Reserved", source: "airbnb" }), { text: "Airbnb · sem nome", generic: true });
  assert.deepEqual(g({ guestName: "CLOSED - Not available", source: "booking" }), { text: "Booking · sem nome", generic: true });
  assert.deepEqual(g({ guestName: "Airbnb (Not available)", source: "airbnb" }), { text: "Bloqueio Airbnb", generic: true });
  assert.deepEqual(g({ guestName: "", source: "direto" }), { text: "Direto · sem nome", generic: true });
  assert.deepEqual(g({ guestName: "Hóspede Teste", source: "booking" }), { text: "Hóspede Teste", generic: false });
  const h = card("occupied", { ...res, guestName: "Reserved", source: "airbnb" });
  assert.match(h, /rc-guest rc-empty">Airbnb · sem nome</);
  assert.doesNotMatch(h, /Reserved/);
  assert.match(card("occupied", { ...res, source: "booking" }), /sai 05\/03 · Booking/);
});

test("climatização não quebra no meio ('💨 Vent.' junto)", () => {
  const h = fe.run(`roomCardHtml(ROOMS.find(r => r.id === "11"), "free", null, false)`);
  assert.match(h, /<span class="nw">💨 Vent\.<\/span>/);
});
