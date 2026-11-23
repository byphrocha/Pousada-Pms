// Testes unitários de lib/availability.js (PMS-004). Dados fictícios.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const A = require("../lib/availability");

test("datas: aceita datas reais", () => {
  for (const d of ["2026-01-01", "2028-02-29", "2026-12-31"]) assert.ok(A.isBusinessDate(d), d);
});

test("datas: rejeita datas inexistentes e formatos errados (D3)", () => {
  for (const d of ["2026-02-29", "2026-02-30", "2026-02-31", "2026-04-31", "2026-13-01",
                   "2026-00-10", "26-01-01", "2026-1-1", "2026-01-01T00:00", "", null, 20260101])
    assert.equal(A.isBusinessDate(d), false, String(d));
});

test("estadia: saída igual ou antes da entrada é inválida", () => {
  assert.match(A.validateStay("2026-03-10", "2026-03-10"), /após/);
  assert.match(A.validateStay("2026-03-10", "2026-03-09"), /após/);
  assert.equal(A.validateStay("2026-03-10", "2026-03-11"), null);
  assert.match(A.validateStay("2026-02-30", "2026-03-02"), /válidas/);
});

test("quartos: CF são os 9 físicos", () => {
  assert.deepEqual(A.resolveRooms("CF"), ["10","11","12","20","21","22","23","24","25"]);
});

test("quartos: 11+12 são dois físicos", () => {
  assert.deepEqual(A.resolveRooms("11+12"), ["11", "12"]);
});

test("quartos: físico resolve para ele mesmo; desconhecido é null", () => {
  assert.deepEqual(A.resolveRooms("24"), ["24"]);
  for (const x of ["13", "", null, "cf", "11 + 12", "10;20"]) assert.equal(A.resolveRooms(x), null, String(x));
});

test("resolveRooms devolve cópia (não deixa alterar a constante)", () => {
  const r = A.resolveRooms("CF"); r.push("99");
  assert.equal(A.resolveRooms("CF").length, 9);
});

test("sobreposição: intervalo [entrada, saída)", () => {
  assert.equal(A.overlaps("2026-02-18", "2026-02-21", "2026-02-21", "2026-02-24"), false, "adjacentes");
  assert.equal(A.overlaps("2026-02-18", "2026-02-21", "2026-02-20", "2026-02-22"), true, "1 noite em comum");
  assert.equal(A.overlaps("2026-02-18", "2026-02-25", "2026-02-20", "2026-02-21"), true, "contida");
  assert.equal(A.overlaps("2026-02-20", "2026-02-21", "2026-02-18", "2026-02-25"), true, "contém");
  assert.equal(A.overlaps("2026-02-10", "2026-02-12", "2026-02-20", "2026-02-22"), false, "longe");
});

const EXISTING = [
  { id: "a", room_id: "20", check_in: "2026-03-10", check_out: "2026-03-12", status: "confirmed" },
  { id: "b", room_id: "12", check_in: "2026-03-10", check_out: "2026-03-12", status: "pending" },
  { id: "c", room_id: "23", check_in: "2026-03-10", check_out: "2026-03-12", status: "cancelled" },
];

test("conflitos: quarto individual", () => {
  const c = A.findConflicts(EXISTING, { rooms: ["20"], checkIn: "2026-03-11", checkOut: "2026-03-13" });
  assert.deepEqual(c, [{ id: "a", room_id: "20" }]);
});

test("conflitos: cancelada não ocupa", () => {
  assert.deepEqual(A.findConflicts(EXISTING, { rooms: ["23"], checkIn: "2026-03-10", checkOut: "2026-03-12" }), []);
});

test("conflitos: pendente NÃO ocupa (decisão do Paulo, 23/11/2026)", () => {
  assert.equal(A.findConflicts(EXISTING, { rooms: ["12"], checkIn: "2026-03-11", checkOut: "2026-03-12" }).length, 0);
  assert.equal(A.isBlocking("pending"), false);
  assert.equal(A.isBlocking("confirmed"), true);
});

test("conflitos: 11+12 conflita se qualquer um dos dois estiver ocupado", () => {
  const rows = [...EXISTING, { id: "d", room_id: "12", check_in: "2026-03-12", check_out: "2026-03-13", status: "confirmed" }];
  const c = A.findConflicts(rows, { rooms: A.resolveRooms("11+12"), checkIn: "2026-03-11", checkOut: "2026-03-14" });
  assert.deepEqual(c.map(x => x.room_id), ["12"]);
  assert.deepEqual(c.map(x => x.id), ["d"], "a pendente do 12 não entra");
});

test("conflitos: CF lista todos os quartos ocupados (pendente não conta)", () => {
  const c = A.findConflicts(EXISTING, { rooms: A.resolveRooms("CF"), checkIn: "2026-03-09", checkOut: "2026-03-11" });
  assert.deepEqual(c.map(x => x.room_id).sort(), ["20"]);
});

test("conflitos: edição ignora a própria reserva", () => {
  assert.deepEqual(A.findConflicts(EXISTING, { rooms: ["20"], checkIn: "2026-03-10", checkOut: "2026-03-13", ignoreIds: ["a"] }), []);
});

test("conflitos: aceita colunas DATE/TIMESTAMP vindas como string longa", () => {
  const rows = [{ id: "z", room_id: 20, check_in: "2026-03-10T00:00:00", check_out: "2026-03-12T00:00:00", status: "confirmed" }];
  assert.equal(A.findConflicts(rows, { rooms: ["20"], checkIn: "2026-03-11", checkOut: "2026-03-12" }).length, 1);
});

test("409: corpo sem dados de outro hóspede, quartos ordenados e únicos", () => {
  assert.deepEqual(A.conflictError(["20", "12", "20"]),
    { error: { code: "ROOM_CONFLICT", message: "Quarto indisponível no período", rooms: ["12", "20"] } });
});

test("bloqueio do Airbnb ('Not available') não conta como ocupação (mesma regra da tela)", () => {
  const rows = [
    { id: "b1", room_id: "21", check_in: "2026-11-23", check_out: "2027-03-01", status: "confirmed", source: "airbnb", guest_name: "Airbnb (Not available)" },
    { id: "b2", room_id: "21", check_in: "2026-12-10", check_out: "2026-12-12", status: "confirmed", source: "airbnb", guest_name: "Reserved" },
    { id: "b3", room_id: "22", check_in: "2026-12-10", check_out: "2026-12-12", status: "confirmed", source: "booking", guest_name: "CLOSED - Not available" },
  ];
  assert.deepEqual(A.findConflicts(rows, { rooms: ["21"], checkIn: "2026-12-01", checkOut: "2026-12-03" }), [], "só bloqueio");
  assert.deepEqual(A.findConflicts(rows, { rooms: ["21"], checkIn: "2026-12-11", checkOut: "2026-12-13" }), [{ id: "b2", room_id: "21" }], "reserva real do Airbnb conta");
  assert.equal(A.findConflicts(rows, { rooms: ["22"], checkIn: "2026-12-11", checkOut: "2026-12-12" }).length, 1, "CLOSED do Booking continua contando");
});

test("resultado de conflito nunca carrega nome/summary", () => {
  const rows = [{ id: "x", room_id: "20", check_in: "2030-01-01", check_out: "2030-01-03", status: "confirmed", source: "direto", guest_name: "Nome Teste" }];
  assert.doesNotMatch(JSON.stringify(A.findConflicts(rows, { rooms: ["20"], checkIn: "2030-01-02", checkOut: "2030-01-04" })), /Nome Teste/);
});
