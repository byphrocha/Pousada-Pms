// Mapa de quartos: nome do hóspede não pode virar HTML/código na tela. Dados fictícios.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { loadFrontend } = require("./helpers/frontend-harness");

const EVIL = '<img src=x onerror="alert(1)">Fulano Ficticio';

test("Mapa: nome com HTML aparece como texto em todos os quartos (inclusive fora da suíte)", () => {
  const fe = loadFrontend({});
  const t = fe.run("todayStr()");
  const tomorrow = fe.run(`(() => { const d = new Date(todayStr() + "T12:00:00"); d.setDate(d.getDate() + 1); return d.toISOString().slice(0, 10); })()`);
  fe.run(`reservations = ${JSON.stringify(["20", "11", "24"].map((roomId, i) => ({ id: "r" + i, roomId, guestName: EVIL, checkIn: t, checkOut: tomorrow, status: "confirmed", source: "direto", notes: "" })))};`);
  const html = fe.run("renderMap()");
  assert.doesNotMatch(html, /<img src=x/);
  assert.match(html, /&lt;img src=x/);
});
