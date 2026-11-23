// CPF de hóspede: mascarado para funcionário (decisão de 23/11/2026). Dados fictícios.
"use strict";
process.env.JWT_SECRET = "segredo-so-de-teste";
process.env.SUPABASE_URL = "http://127.0.0.1:9";
process.env.SUPABASE_KEY = "chave-falsa";

const test = require("node:test");
const assert = require("node:assert/strict");
const jwt = require("jsonwebtoken");
const { app, _setSupabaseForTests } = require("../server");
const { createFakeSupabase } = require("./helpers/fake-supabase");

const tok = (role) => "Bearer " + jwt.sign({ userId: role, role, username: role }, process.env.JWT_SECRET, { algorithm: "HS256" });
const ADMIN = tok("admin"), STAFF = tok("staff");
let server, base;
test.before(async () => { server = app.listen(0); await new Promise(r => server.once("listening", r)); base = `http://127.0.0.1:${server.address().port}`; });
test.after(() => server.close());

const CPF = "111.222.333-96"; // fictício
const G = { id: "g1", name: "Hóspede Teste", phone: "44999990000", email: "", cpf: CPF, address: "", notes: "" };
function seed() { const db = createFakeSupabase({ guests: [{ ...G }] }); _setSupabaseForTests(db); return db; }
const call = (m, p, auth, body) => fetch(base + p, { method: m, headers: { "Content-Type": "application/json", Authorization: auth }, body: body ? JSON.stringify(body) : undefined })
  .then(async r => ({ status: r.status, body: await r.json() }));

test("admin vê o CPF completo", async () => {
  seed();
  assert.equal((await call("GET", "/guests", ADMIN)).body[0].cpf, CPF);
  assert.equal((await call("GET", "/guests/g1", ADMIN)).body.cpf, CPF);
});

test("funcionário vê só os 2 últimos dígitos, na lista e na ficha", async () => {
  seed();
  assert.equal((await call("GET", "/guests", STAFF)).body[0].cpf, "***.***.***-96");
  assert.equal((await call("GET", "/guests/g1", STAFF)).body.cpf, "***.***.***-96");
});

test("funcionário vê o telefone completo", async () => {
  seed();
  assert.equal((await call("GET", "/guests", STAFF)).body[0].phone, "44999990000");
});

test("funcionário editando (PUT) não apaga nem troca o CPF real", async () => {
  const db = seed();
  await call("PUT", "/guests/g1", STAFF, { ...G, cpf: "***.***.***-96", notes: "obs" });
  assert.equal(db.tables.guests[0].cpf, CPF);
  assert.equal(db.tables.guests[0].notes, "obs");
  await call("PUT", "/guests/g1", STAFF, { ...G, cpf: "" });
  assert.equal(db.tables.guests[0].cpf, CPF);
});

test("funcionário salvando pela ficha (POST com id existente) não troca o CPF", async () => {
  const db = seed();
  await call("POST", "/guests", STAFF, { ...G, cpf: "999.999.999-99" });
  assert.equal(db.tables.guests[0].cpf, CPF);
});

test("funcionário pode informar CPF ao cadastrar hóspede novo; resposta volta mascarada", async () => {
  const db = seed();
  const r = await call("POST", "/guests", STAFF, { id: "g2", name: "Novo Teste", cpf: "222.333.444-05" });
  assert.equal(db.tables.guests.find(x => x.id === "g2").cpf, "222.333.444-05");
  assert.equal(r.body.cpf, "***.***.***-05");
});

test("admin pode corrigir o CPF; valor mascarado nunca é gravado", async () => {
  const db = seed();
  await call("PUT", "/guests/g1", ADMIN, { ...G, cpf: "***.***.***-96" });
  assert.equal(db.tables.guests[0].cpf, CPF);
  await call("PUT", "/guests/g1", ADMIN, { ...G, cpf: "555.666.777-80" });
  assert.equal(db.tables.guests[0].cpf, "555.666.777-80");
});
