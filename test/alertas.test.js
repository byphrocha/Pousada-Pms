// Alertas de overbooking: só o que ainda dá para resolver (última noite em comum
// hoje ou depois). Antes contava o histórico inteiro: 85 "conflitos", todos de
// estadias já terminadas (duplicatas antigas de importação). Dados fictícios.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { loadFrontend } = require("./helpers/frontend-harness");

const R = (id, roomId, checkIn, checkOut, extra = {}) =>
  ({ id, roomId, checkIn, checkOut, status: "confirmed", source: "airbnb", guestName: "Hóspede Teste", ...extra });
const found = (list, today) => {
  const fe = loadFrontend({});
  return JSON.parse(fe.run(`JSON.stringify(findOverbookings(${JSON.stringify(list)}, "${today}").map(c => c.key))`));
};
const T = "2030-06-10";

test("sobreposição que já terminou não é alerta (duplicata antiga de importação)", () => {
  assert.deepEqual(found([R("a", "20", "2030-05-01", "2030-05-03"), R("b", "20", "2030-05-01", "2030-05-03")], T), []);
});

test("sobreposição futura e em curso continuam alertando", () => {
  assert.deepEqual(found([R("a", "20", "2030-06-20", "2030-06-22"), R("b", "20", "2030-06-21", "2030-06-23", { source: "booking" })], T), ["a|b"]);
  assert.deepEqual(found([R("c", "21", "2030-06-08", "2030-06-12"), R("d", "21", "2030-06-09", "2030-06-11")], T), ["c|d"], "em curso");
});

test("última noite em comum foi ontem → não alerta; é hoje → alerta", () => {
  // noites em comum: 08 e 09; saída da 1ª em 10 (= hoje): já acabou
  assert.deepEqual(found([R("a", "22", "2030-06-07", "2030-06-10"), R("b", "22", "2030-06-08", "2030-06-12")], T), []);
  // noites em comum: 08, 09 e 10 (hoje)
  assert.deepEqual(found([R("a", "22", "2030-06-07", "2030-06-11"), R("b", "22", "2030-06-08", "2030-06-12")], T), ["a|b"]);
});

test("saída e entrada no mesmo dia, quartos diferentes, cancelada e pendente: não alertam", () => {
  assert.deepEqual(found([R("a", "23", "2030-06-20", "2030-06-22"), R("b", "23", "2030-06-22", "2030-06-24")], T), []);
  assert.deepEqual(found([R("a", "23", "2030-06-20", "2030-06-22"), R("b", "24", "2030-06-20", "2030-06-22")], T), []);
  assert.deepEqual(found([R("a", "25", "2030-06-20", "2030-06-22"), R("b", "25", "2030-06-20", "2030-06-22", { status: "cancelled" }),
    R("c", "25", "2030-06-20", "2030-06-22", { status: "pending" })], T), []);
});

test("sininho e tela usam a mesma conta; pré-reserva passada não alerta", () => {
  const fe = loadFrontend({});
  fe.run(`authRole = "admin"; currentView = "alertas";
    reservations = ${JSON.stringify([R("a", "20", "2000-01-01", "2000-01-03"), R("b", "20", "2000-01-01", "2000-01-03"),
      R("c", "21", "2099-01-01", "2099-01-03"), R("d", "21", "2099-01-02", "2099-01-04")])};
    prereservations = [{ room_id: "20", check_in: "2000-01-01", check_out: "2000-01-02", status: "aguardando" }];`);
  assert.equal(fe.run("findOverbookings().length"), 1);
  const src = require("fs").readFileSync(require("path").join(__dirname, "../build/index.html"), "utf8");
  assert.match(src, /const alertCount = findOverbookings\(\)\.length;/, "sininho usa a mesma conta da tela");
  const html = fe.run("renderAlertas()");
  assert.doesNotMatch(html, /Nenhum conflito detectado/);
  assert.equal((html.match(/Pré-reserva × confirmada/g) || []).length, 0);
});
