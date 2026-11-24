// Tela inicial (Mapa): números e listas de hoje. Pendente não ocupa (decisão de
// 23/11/2026: "pending não bloqueia") e aparece à parte, "a confirmar".
// Suíte 11+12 e Casa Fechada contam como UMA chegada/saída. Quarto com duas
// linhas (ex.: reserva do Airbnb + data fechada no Booking) conta uma vez.
// Dados fictícios; datas relativas a hoje.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { loadFrontend } = require("./helpers/frontend-harness");

function cenario(rows) {
  const fe = loadFrontend({});
  const t = fe.run("todayStr()");
  const d = (n) => fe.run(`(() => { const x = new Date(${JSON.stringify(t)} + "T12:00:00Z"); x.setUTCDate(x.getUTCDate() + ${n}); return x.toISOString().slice(0, 10); })()`);
  const list = rows(d).map((r, i) => ({ id: "r" + i, adults: 2, children: 0, source: "direto", status: "confirmed", notes: "", ...r }));
  fe.run(`reservations = ${JSON.stringify(list)}.map(normalizeRes); cleanedRooms = new Set(); checkedInRooms = new Set();`);
  return fe;
}
// Valor de cada KPI pelo rótulo.
const kpis = (html) => Object.fromEntries([...html.matchAll(/class="val">(\d+)<\/div><div class="lbl">.*?<\/span>([^<]+)<\/div>/g)].map(m => [m[2], Number(m[1])]));
const agenda = (html) => html.slice(html.indexOf('class="agenda"'));

test("pendente não ocupa o quarto nem conta como chegada; aparece como 'a confirmar'", () => {
  const fe = cenario(d => [
    { roomId: "23", guestName: "Pendente Teste", checkIn: d(0), checkOut: d(2), status: "pending" },
    { roomId: "24", guestName: "Hospedado Teste", checkIn: d(-1), checkOut: d(1), status: "pending" },
  ]);
  assert.equal(fe.run(`getRoomStatus("23")`), "free");
  assert.equal(fe.run(`getRoomStatus("24")`), "free");
  assert.equal(fe.run(`getRoomRes("24")`), undefined);
  const html = fe.run("renderMap()");
  const k = kpis(html);
  assert.equal(k["Ocupados"], 0);
  assert.equal(k["Check-ins"], 0);
  assert.equal(k["Disponíveis"], 9);
  assert.match(agenda(html), /A confirmar[\s\S]*23[\s\S]*Pendente Teste/);
  assert.doesNotMatch(agenda(html), /Hospedado Teste/, "a confirmar mostra só quem chega hoje");
  assert.match(agenda(html), /onclick="openEditModal\('r0'\)"/, "toque abre a reserva pendente, não 'nova reserva'");
});

test("pendente com saída hoje não manda o quarto para limpeza", () => {
  const fe = cenario(d => [{ roomId: "21", guestName: "Pendente Teste", checkIn: d(-2), checkOut: d(0), status: "pending" }]);
  assert.equal(fe.run(`getRoomStatus("21")`), "free");
});

test("Suíte 11+12 conta como uma chegada e aparece como 11+12", () => {
  const fe = cenario(d => ["11", "12"].map(room => ({ roomId: room, guestName: "Suíte Teste", checkIn: d(0), checkOut: d(2),
    groupId: "suite:g1", notes: "[Suíte grupo:g1]" })));
  const html = fe.run("renderMap()");
  assert.equal(kpis(html)["Check-ins"], 1);
  assert.equal(kpis(html)["Ocupados"], 2, "ocupação continua por quarto físico");
  assert.equal((agenda(html).match(/Suíte Teste/g) || []).length, 1);
  assert.match(agenda(html), /agenda-room"[^>]*>11\+12</);
});

test("Casa Fechada pelo group_id (sem a nota antiga) também vira uma chegada só", () => {
  const ALL = ["10", "11", "12", "20", "21", "22", "23", "24", "25"];
  const fe = cenario(d => ALL.map(room => ({ roomId: room, guestName: "Casa Teste", checkIn: d(0), checkOut: d(3), groupId: "cf:g2" })));
  const html = fe.run("renderMap()");
  assert.equal(kpis(html)["Check-ins"], 1);
  assert.equal((agenda(html).match(/Casa Teste/g) || []).length, 1);
  assert.match(agenda(html), /agenda-room"[^>]*>CF</);
  assert.doesNotMatch(agenda(html), /handleRoomClick\('CF'\)/, "antes abria 'nova reserva' para o quarto CF");
});

test("quarto com duas linhas ativas (Airbnb + data fechada no Booking) conta uma vez", () => {
  const fe = cenario(d => [
    { roomId: "22", guestName: "Reserved", source: "airbnb", checkIn: d(-1), checkOut: d(2) },
    { roomId: "22", guestName: "CLOSED - Not available", source: "booking", checkIn: d(-1), checkOut: d(2) },
  ]);
  const k = kpis(fe.run("renderMap()"));
  assert.equal(k["Ocupados"], 1);
  assert.equal(k["Disponíveis"], 8);
});

test("pendente de Casa Fechada não fecha a pousada no mapa", () => {
  const ALL = ["10", "11", "12", "20", "21", "22", "23", "24", "25"];
  const fe = cenario(d => ALL.map(room => ({ roomId: room, guestName: "Casa Pendente", checkIn: d(-1), checkOut: d(1),
    groupId: "cf:g3", notes: "[Casa toda:g3]", status: "pending" })));
  assert.equal(fe.run("getCasaFechadaToday()"), null);
  assert.doesNotMatch(fe.run("renderMap()"), /Casa Fechada<\/div>/);
});

test("nome em 'a confirmar' é escapado", () => {
  const fe = cenario(d => [{ roomId: "25", guestName: "<img src=x onerror=alert(1)>", checkIn: d(0), checkOut: d(1), status: "pending" }]);
  const a = agenda(fe.run("renderMap()"));
  assert.doesNotMatch(a, /<img src=x/);
  assert.match(a, /&lt;img/);
});

test("suíte marcada só pelo group_id (sem nota) também é uma chegada '11+12'", () => {
  const fe = cenario(d => ["11", "12"].map(room => ({ roomId: room, guestName: "Suíte Nova", checkIn: d(0), checkOut: d(1), groupId: "suite:g9" })));
  const html = fe.run("renderMap()");
  assert.equal(kpis(html)["Check-ins"], 1);
  assert.match(agenda(html), /agenda-room"[^>]*>11\+12</);
});

test("quarto vindo do banco é escapado na agenda", () => {
  const fe = cenario(d => [{ roomId: "<b>x</b>", guestName: "Teste", checkIn: d(0), checkOut: d(1) }]);
  const a = agenda(fe.run("renderMap()"));
  assert.doesNotMatch(a, /<b>x<\/b>/);
  assert.match(a, /&lt;b&gt;x/);
});
