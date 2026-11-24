// PMS-019: calendário de ocupação. Critério de aceite: CF e 11+12 exibidos
// corretamente (uma barra só), intervalo [check_in, check_out) e conflitos visíveis.
// Dados fictícios.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { loadFrontend } = require("./helpers/frontend-harness");

const ROOMS = ["10", "11", "12", "20", "21", "22", "23", "24", "25"];
const res = (id, roomId, checkIn, checkOut, extra = {}) =>
  ({ id, roomId, guestName: "Hóspede Teste " + id, checkIn, checkOut, source: "direto", status: "confirmed", notes: "", ...extra });

function layout(list, start = "2030-03-01", days = 14) {
  const fe = loadFrontend({});
  return JSON.parse(fe.run(`JSON.stringify(calendarLayout(${JSON.stringify(list)}, "${start}", ${days}))`));
}

test("datas: soma de dias atravessa mês/ano e horário de verão sem erro", () => {
  const fe = loadFrontend({});
  assert.equal(fe.run(`calAddDays("2030-02-27", 3)`), "2030-03-02");
  assert.equal(fe.run(`calAddDays("2030-12-30", 3)`), "2031-01-02");
  assert.equal(fe.run(`calAddDays("2030-03-01", -1)`), "2030-02-28");
  assert.equal(fe.run(`calDiff("2030-10-01", "2030-11-01")`), 31);
});

test("reserva comum: coluna = noite; check-out não ocupa a coluna do dia de saída", () => {
  const L = layout([res("a", "20", "2030-03-03", "2030-03-06")]);
  assert.equal(L.bars.length, 1);
  const b = L.bars[0];
  assert.deepEqual([b.row, b.rowSpan, b.col, b.span, b.kind], [3, 1, 2, 3, "room"]);
});

test("saída e entrada no mesmo dia não são conflito e ficam na mesma faixa", () => {
  const L = layout([res("a", "21", "2030-03-02", "2030-03-05"), res("b", "21", "2030-03-05", "2030-03-08", { source: "airbnb" })]);
  assert.equal(L.conflicts.length, 0);
  assert.ok(L.bars.every(b => b.lane === 0 && b.lanes === 1 && !b.conflict));
});

test("CF completa vira UMA barra nas 9 linhas", () => {
  const cf = ROOMS.map((r, i) => res("cf" + i, r, "2030-03-04", "2030-03-07",
    { notes: ` [Casa toda:g1]${r === "11" || r === "12" ? " [Suíte grupo:s1]" : ""}`, amount: i === 4 ? 9000 : 0 }));
  const L = layout(cf);
  assert.equal(L.bars.length, 1);
  const b = L.bars[0];
  assert.deepEqual([b.kind, b.row, b.rowSpan, b.col, b.span], ["cf", 0, 9, 3, 3]);
  assert.equal(b.id, "cf4", "abre a linha dona do contrato (maior valor)");
  assert.equal(b.ids.length, 9);
});

test("11+12 vira UMA barra nas linhas 11 e 12", () => {
  const L = layout([res("s11", "11", "2030-03-01", "2030-03-03", { notes: "[Suíte grupo:s9]" }),
                    res("s12", "12", "2030-03-01", "2030-03-03", { notes: "[Suíte grupo:s9]" })]);
  assert.equal(L.bars.length, 1);
  assert.deepEqual([L.bars[0].kind, L.bars[0].row, L.bars[0].rowSpan], ["suite", 1, 2]);
});

test("grupo quebrado (uma linha cancelada ou datas diferentes) aparece como barras soltas", () => {
  const cf = ROOMS.map((r, i) => res("cf" + i, r, "2030-03-04", "2030-03-07", { notes: "[Casa toda:g2]" }));
  cf[2].status = "cancelled";
  assert.equal(layout(cf).bars.length, 8);
  const suite = [res("s11", "11", "2030-03-01", "2030-03-03", { notes: "[Suíte grupo:s8]" }),
                 res("s12", "12", "2030-03-01", "2030-03-04", { notes: "[Suíte grupo:s8]" })];
  assert.ok(layout(suite).bars.every(b => b.kind === "room"));
});

test("conflito real: noites marcadas, barras empilhadas (nenhuma escondida)", () => {
  const L = layout([res("a", "23", "2030-03-02", "2030-03-06", { source: "airbnb" }),
                    res("b", "23", "2030-03-04", "2030-03-08", { source: "booking" })]);
  assert.deepEqual(L.conflicts.map(c => [c.roomId, c.date]), [["23", "2030-03-04"], ["23", "2030-03-05"]]);
  assert.ok(L.bars.every(b => b.conflict && b.lanes === 2));
  assert.deepEqual(L.bars.map(b => b.lane).sort(), [0, 1]);
});

test("CF sobre reserva de um quarto: conflito só nesse quarto", () => {
  const cf = ROOMS.map((r, i) => res("cf" + i, r, "2030-03-04", "2030-03-06", { notes: "[Casa toda:g3]" }));
  const L = layout([...cf, res("x", "24", "2030-03-05", "2030-03-07", { source: "booking" })]);
  assert.deepEqual(L.conflicts.map(c => c.roomId + "@" + c.date), ["24@2030-03-05"]);
  assert.equal(L.bars.find(b => b.kind === "cf").lanes, 2);
});

test("pending aparece mas não gera conflito (decisão 23/11); cancelada some", () => {
  const L = layout([res("a", "25", "2030-03-02", "2030-03-05"),
                    res("p", "25", "2030-03-03", "2030-03-04", { status: "pending" }),
                    res("c", "25", "2030-03-02", "2030-03-05", { status: "cancelled" })]);
  assert.equal(L.conflicts.length, 0);
  assert.deepEqual(L.bars.map(b => b.id).sort(), ["a", "p"]);
  assert.ok(L.bars.find(b => b.id === "p").pending);
});

test("recorte na janela: reserva que começa antes/termina depois fica cortada e marcada", () => {
  const L = layout([res("a", "10", "2030-02-25", "2030-03-20")], "2030-03-01", 14);
  const b = L.bars[0];
  assert.deepEqual([b.col, b.span, b.clipLeft, b.clipRight], [0, 14, true, true]);
  assert.equal(layout([res("z", "10", "2030-02-20", "2030-03-01")]).bars.length, 0, "saiu no dia 1: não aparece");
});

test("bloqueio do Airbnb aparece sem nome; dados ruins não quebram a tela", () => {
  const L = layout([res("b", "22", "2030-03-02", "2030-03-04", { source: "airbnb", guestName: "Airbnb (Not available)" }),
                    res("x", "99", "2030-03-02", "2030-03-04"), res("y", "22", "2030-03-05", "2030-03-05"), null]);
  assert.equal(L.bars.length, 1);
  assert.ok(L.bars[0].block);
  const fe = loadFrontend({});
  fe.run(`reservations = ${JSON.stringify([res("b", "22", "2030-03-02", "2030-03-04", { source: "airbnb", guestName: "Airbnb (Not available)" })])}; calStart = "2030-03-01";`);
  const html = fe.run("renderCalendario()");
  assert.match(html, /Bloqueio/);
  assert.doesNotMatch(html, /Not available/);
});

test("tela: escapa nome do hóspede (XSS) e abre a reserva ao clicar", () => {
  const fe = loadFrontend({});
  fe.run(`reservations = ${JSON.stringify([res("r1", "20", "2030-03-02", "2030-03-04", { guestName: "<img src=x onerror=alert(1)>" })])}; calStart = "2030-03-01";`);
  const html = fe.run("renderCalendario()");
  assert.doesNotMatch(html, /<img src=x/);
  assert.match(html, /&lt;img/);
  assert.match(html, /onclick="openEditModal\('r1'\)"/);
});

test("tela: navegação de 7 em 7 dias, 'Hoje' e 14/31 noites", () => {
  const fe = loadFrontend({});
  fe.run(`calStart = "2030-03-10"; calNav(7);`);
  assert.equal(fe.run("calStart"), "2030-03-17");
  fe.run(`calNav(-14);`);
  assert.equal(fe.run("calStart"), "2030-03-03");
  fe.run(`calNav(0);`);
  assert.equal(fe.run("calStart"), fe.run(`calAddDays(todayStr(), -1)`));
  fe.run(`calSetDays(31);`); assert.equal(fe.run("calDays"), 31);
  fe.run(`calSetDays(999);`); assert.equal(fe.run("calDays"), 14);
});

test("tela: funcionário também acessa o calendário (só leitura de datas e nomes)", () => {
  const fe = loadFrontend({});
  fe.run(`authRole = "staff"; currentView = "calendario"; applyRole();`);
  assert.equal(fe.run("currentView"), "calendario");
  fe.run(`reservations = ${JSON.stringify([res("r1", "20", "2030-03-02", "2030-03-04", { amount: 98765.43 })])}; calStart = "2030-03-01";`);
  assert.doesNotMatch(fe.run("renderCalendario()"), /98765|98\.765/);
});

test("tela: conflito marcado com ⚠️ no nome (não só pela cor, que o Airbnb também usa)", () => {
  const fe = loadFrontend({});
  fe.run(`reservations = ${JSON.stringify([res("a", "23", "2030-03-02", "2030-03-06", { source: "airbnb" }), res("b", "23", "2030-03-04", "2030-03-08", { source: "booking" }), res("c", "24", "2030-03-02", "2030-03-04", { source: "airbnb" })])}; calStart = "2030-03-01";`);
  const html = fe.run("renderCalendario()");
  assert.equal((html.match(/⚠️ Hóspede Teste/g) || []).length, 2);
  assert.doesNotMatch(html, /⚠️ Hóspede Teste c/);
});

test("tela: barra de reserva sem nome mostra o canal, não 'Reserved'", () => {
  const fe = loadFrontend({});
  fe.run(`reservations = ${JSON.stringify([res("r1", "20", "2030-03-02", "2030-03-04", { source: "airbnb", guestName: "Reserved" })])}; calStart = "2030-03-01";`);
  const html = fe.run("renderCalendario()");
  assert.match(html, /Airbnb · sem nome/);
  assert.doesNotMatch(html, />Reserved</);
});
