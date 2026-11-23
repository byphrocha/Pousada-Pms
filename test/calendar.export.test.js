// Feeds de calendário exportados para as OTAs (achado I6). Dados fictícios.
"use strict";
process.env.JWT_SECRET = "segredo-so-de-teste";
process.env.SUPABASE_URL = "http://127.0.0.1:9";
process.env.SUPABASE_KEY = "chave-falsa";
process.env.CALENDAR_TOKEN = "token-de-teste-123";

const test = require("node:test");
const assert = require("node:assert/strict");
const { app, _setSupabaseForTests } = require("../server");
const { createFakeSupabase } = require("./helpers/fake-supabase");

let server, base;
test.before(async () => { server = app.listen(0); await new Promise(r => server.once("listening", r)); base = `http://127.0.0.1:${server.address().port}`; });
test.after(() => server.close());

const rows = [
  { id: "r1", room_id: "20", guest_name: "Fulana Sobrenome Teste", check_in: "2030-03-10", check_out: "2030-03-12", status: "confirmed", source: "direto", external_uid: null },
];

test("feed com token não traz nome do hóspede", async () => {
  _setSupabaseForTests(createFakeSupabase({ reservations: rows }));
  const r = await fetch(`${base}/calendar/token-de-teste-123/20.ics`);
  assert.equal(r.status, 200);
  const body = await r.text();
  assert.match(body, /SUMMARY:Reservado/);
  assert.doesNotMatch(body, /Fulana|Sobrenome/);
  assert.match(body, /DTSTART;VALUE=DATE:20300310/);
});

test("token errado ou de tamanho diferente → 403", async () => {
  _setSupabaseForTests(createFakeSupabase({ reservations: rows }));
  for (const t of ["token-de-teste-124", "x", "token-de-teste-123-mais"]) {
    assert.equal((await fetch(`${base}/calendar/${t}/20.ics`)).status, 403, t);
  }
});

test("erro interno não vaza a mensagem do banco", async () => {
  _setSupabaseForTests(createFakeSupabase({ reservations: rows }, { failSelect: true }));
  const o = console.error; console.error = () => {};
  try {
    const r = await fetch(`${base}/calendar/token-de-teste-123/20.ics`);
    assert.equal(r.status, 500);
    assert.doesNotMatch(await r.text(), /falha simulada/);
  } finally { console.error = o; }
});
