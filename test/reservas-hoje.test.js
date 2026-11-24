// Aba Reservas: contadores "Check-ins/Check-outs de hoje" com a mesma regra do
// Mapa (pendente não conta; CF e 11+12 contam uma vez) e Casa Fechada
// reconhecida pela coluna de grupo. Dados fictícios; datas relativas a hoje.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { loadFrontend } = require("./helpers/frontend-harness");

const ALL = ["10", "11", "12", "20", "21", "22", "23", "24", "25"];
function cenario(rows) {
  const fe = loadFrontend({});
  const t = fe.run("todayStr()");
  const d = (n) => fe.run(`(() => { const x = new Date(${JSON.stringify(t)} + "T12:00:00Z"); x.setUTCDate(x.getUTCDate() + ${n}); return x.toISOString().slice(0, 10); })()`);
  const list = rows(d).map((r, i) => ({ id: "r" + i, adults: 2, children: 0, source: "direto", status: "confirmed", notes: "", ...r }));
  fe.run(`reservations = ${JSON.stringify(list)}.map(normalizeRes); filterTab = "checkins"; searchQ = ""; dateFrom = ""; dateTo = "";`);
  return fe;
}
const badge = (html, tab) => { const m = html.match(new RegExp(`${tab}<span[^>]*>(\\d+)</span>`)) ||
  html.match(new RegExp(`${tab} <span[^>]*>(\\d+)</span>`)); return m ? Number(m[1]) : 0; };

test("contadores de hoje: suíte conta 1, CF conta 1, pendente não conta", () => {
  const fe = cenario(d => [
    ...["11", "12"].map(room => ({ roomId: room, guestName: "Suíte Teste", checkIn: d(0), checkOut: d(2), groupId: "suite:a" })),
    { roomId: "23", guestName: "Pendente Teste", checkIn: d(0), checkOut: d(1), status: "pending" },
    { roomId: "24", guestName: "Pendente Sai", checkIn: d(-3), checkOut: d(0), status: "pending" },
    ...ALL.map(room => ({ roomId: room, guestName: "Casa Teste", checkIn: d(-2), checkOut: d(0), groupId: "cf:b" })),
  ]);
  const html = fe.run("renderReservas()");
  assert.equal(badge(html, "✈ Check-ins"), 1);
  assert.equal(badge(html, "🧹 Check-outs"), 1);
});

test("sem chegada confirmada hoje: aviso 'Nenhum check-in hoje' mesmo com pendente", () => {
  const fe = cenario(d => [{ roomId: "23", guestName: "Pendente Teste", checkIn: d(0), checkOut: d(1), status: "pending" }]);
  assert.match(fe.run("renderReservas()"), /Nenhum check-in hoje/);
});

test("lista: Casa Fechada marcada só pela coluna de grupo vira uma linha 'CF'", () => {
  const fe = cenario(d => ALL.map(room => ({ roomId: room, guestName: "Casa Teste", checkIn: d(0), checkOut: d(2), groupId: "cf:c" })));
  const out = fe.run(`JSON.stringify(groupSuiteReservations(groupCasaFechada(reservations)).map(r => r.roomId))`);
  assert.equal(out, '["CF"]');
});

test("lista: duas Casas Fechadas diferentes com mesmo nome e datas não se fundem quando têm grupo", () => {
  const fe = cenario(d => [...ALL.map(room => ({ roomId: room, guestName: "Reserved", checkIn: d(5), checkOut: d(6), groupId: "cf:x", status: "cancelled" })),
                           ...ALL.map(room => ({ roomId: room, guestName: "Reserved", checkIn: d(5), checkOut: d(6), groupId: "cf:y" }))]);
  assert.equal(fe.run(`groupCasaFechada(reservations).length`), 2);
});

// ── Outras telas com a mesma regra ───────────────────────────────────────────
test("calendário: CF e 11+12 marcadas só pela coluna de grupo viram uma barra cada", () => {
  const fe = loadFrontend({});
  const r = (id, roomId, groupId) => ({ id, roomId, guestName: "Teste", checkIn: "2030-03-03", checkOut: "2030-03-05", source: "direto", status: "confirmed", notes: "", groupId });
  const list = [...ALL.map(room => r("cf" + room, room, "cf:g1")),
    { ...r("s11", "11", "suite:g2"), checkIn: "2030-03-07", checkOut: "2030-03-08" }, { ...r("s12", "12", "suite:g2"), checkIn: "2030-03-07", checkOut: "2030-03-08" }];
  const L = JSON.parse(fe.run(`JSON.stringify(calendarLayout(${JSON.stringify(list)}, "2030-03-01", 14))`));
  assert.deepEqual(L.bars.map(b => b.kind).sort(), ["cf", "suite"]);
});

test("desfazer marcação: pendente com chegada hoje não deixa 'desfazer check-in'", () => {
  const fe = cenario(d => [{ roomId: "23", guestName: "Pendente Teste", checkIn: d(0), checkOut: d(1), status: "pending" }]);
  fe.run(`checkedInRooms = new Set(["23"])`);
  assert.equal(fe.run(`undoableMark("23")`), null);
  fe.run(`reservations[0].status = "confirmed"`);
  assert.equal(fe.run(`undoableMark("23")`), "checkedIn");
});

test("pré-reserva: conflito só com reserva que ocupa (pendente não conta)", () => {
  const fe = cenario(d => [{ roomId: "21", guestName: "Pendente Teste", checkIn: d(3), checkOut: d(5), status: "pending" }]);
  const pre = (fe2) => fe2.run(`prereservations = [{ id: "p1", room_id: "21", guest_name: "Pré Teste", check_in: reservations[0].checkIn, check_out: reservations[0].checkOut, status: "aguardando" }]; renderPreReservas()`);
  assert.doesNotMatch(pre(fe), /#ef444466/);
  fe.run(`reservations[0].status = "confirmed"`);
  assert.match(pre(fe), /#ef444466/);
});
