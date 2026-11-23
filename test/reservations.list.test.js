// GET /reservations com mais de 1.000 linhas (limite do Supabase). Dados fictícios.
"use strict";
process.env.JWT_SECRET = "segredo-so-de-teste";
process.env.SUPABASE_URL = "http://127.0.0.1:9";
process.env.SUPABASE_KEY = "chave-falsa";

const test = require("node:test");
const assert = require("node:assert/strict");
const jwt = require("jsonwebtoken");
const { app, _setSupabaseForTests } = require("../server");
const { createFakeSupabase } = require("./helpers/fake-supabase");

const AUTH = require("./helpers/auth").STAFF();
let server, base;
test.before(async () => { server = app.listen(0); await new Promise(r => server.once("listening", r)); base = `http://127.0.0.1:${server.address().port}`; });
test.after(() => server.close());

function rowsFixture() {
  const rows = [];
  for (let i = 0; i < 2300; i++)   // histórico antigo: ocupa as primeiras páginas
    rows.push({ id: `old${String(i).padStart(4, "0")}`, room_id: "10", guest_name: "Reserved", source: "airbnb", status: "cancelled", check_in: "2026-01-01", check_out: "2026-01-02" });
  rows.push({ id: "fut1", room_id: "24", guest_name: "Reserved", source: "airbnb", status: "confirmed", check_in: "2030-11-23", check_out: "2030-11-26" });
  rows.push({ id: "fut2", room_id: "20", guest_name: "Hóspede Teste", source: "direto", status: "confirmed", check_in: "2030-12-01", check_out: "2030-12-03" });
  rows.push({ id: "blk1", room_id: "21", guest_name: "Airbnb (Not available)", source: "airbnb", status: "confirmed", check_in: "2030-12-24", check_out: "2031-03-01" });
  rows.push({ id: "bkg1", room_id: "22", guest_name: "CLOSED - Not available", source: "booking", status: "confirmed", check_in: "2030-12-04", check_out: "2030-12-06" });
  return rows;
}

test("com mais de 1.000 linhas, as reservas futuras chegam à tela", async () => {
  _setSupabaseForTests(createFakeSupabase({ reservations: rowsFixture() }));
  const r = await fetch(base + "/reservations", { headers: { Authorization: AUTH } });
  assert.equal(r.status, 200);
  const ids = (await r.json()).map(x => x.id);
  assert.ok(ids.includes("fut1"), "reserva do Airbnb de hoje");
  assert.ok(ids.includes("fut2"), "reserva direta futura");
  assert.equal(ids.filter(id => id.startsWith("old")).length, 2300, "nenhuma linha perdida");
});

test("bloqueio 'Not available' do Airbnb não é enviado; 'CLOSED' do Booking continua", async () => {
  _setSupabaseForTests(createFakeSupabase({ reservations: rowsFixture() }));
  const ids = (await (await fetch(base + "/reservations", { headers: { Authorization: AUTH } })).json()).map(x => x.id);
  assert.ok(!ids.includes("blk1"));
  assert.ok(ids.includes("bkg1"));
});

test("erro do banco em qualquer página → 500 (não devolve lista parcial)", async () => {
  _setSupabaseForTests(createFakeSupabase({ reservations: rowsFixture() }, { failSelect: true }));
  const r = await fetch(base + "/reservations", { headers: { Authorization: AUTH } });
  assert.equal(r.status, 500);
});
