// Robustez: erro em rota não derruba o servidor; limite de login por conta. Dados fictícios.
"use strict";
process.env.JWT_SECRET = "segredo-so-de-teste";
process.env.SUPABASE_URL = "http://127.0.0.1:9";
process.env.SUPABASE_KEY = "chave-falsa";

const test = require("node:test");
const assert = require("node:assert/strict");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { app, _setSupabaseForTests } = require("../server");
const { createFakeSupabase } = require("./helpers/fake-supabase");

let server, base;
test.before(async () => { server = app.listen(0); await new Promise(r => server.once("listening", r)); base = `http://127.0.0.1:${server.address().port}`; });
test.after(() => server.close());

const HASH = bcrypt.hashSync("senha-certa", 4);
const users = () => [{ id: "u1", username: "admin", role: "admin", password_hash: HASH },
                     { id: "u2", username: "staff", role: "staff", password_hash: HASH }];
const quiet = async (fn) => { const o = console.error; console.error = () => {}; try { return await fn(); } finally { console.error = o; } };
let ipCounter = 0;
// IP diferente a cada chamada: isola o limite por IP para testar o limite por conta.
const login = (body, raw) => fetch(base + "/login", { method: "POST",
  headers: { "Content-Type": "application/json", "X-Forwarded-For": `10.0.${Math.floor(ipCounter / 250)}.${ipCounter++ % 250}` },
  body: raw ?? JSON.stringify(body) }).then(async r => ({ status: r.status, body: await r.json().catch(() => null) }));
const alive = async () => (await fetch(base + "/healthz")).status === 200;

test("login com usuário não-texto responde 400 e o servidor continua no ar", async () => {
  _setSupabaseForTests(createFakeSupabase({ users: users() }));
  for (const body of [{ username: 1, password: "x" }, { username: { a: 1 }, password: "x" }, { username: "admin", password: ["x"] }]) {
    assert.equal((await login(body)).status, 400, JSON.stringify(body));
  }
  assert.ok(await alive());
});

test("JSON malformado → 400, sem derrubar", async () => {
  _setSupabaseForTests(createFakeSupabase({ users: users() }));
  const r = await quiet(() => login(null, "{nao é json"));
  assert.equal(r.status, 400);
  assert.ok(await alive());
});

test("exceção dentro de rota async → 500 genérico e o servidor continua", async () => {
  const real = createFakeSupabase({});
  _setSupabaseForTests({ from(t) { if (t === "users") return real.from(t); throw new Error("detalhe interno do banco"); } });
  const auth = require("./helpers/auth").ADMIN();
  const r = await quiet(() => fetch(base + "/guests", { headers: { Authorization: auth } }).then(async x => ({ status: x.status, body: await x.text() })));
  assert.equal(r.status, 500);
  assert.doesNotMatch(r.body, /detalhe interno/);
  assert.ok(await alive());
});

test("login certo funciona e devolve token", async () => {
  _setSupabaseForTests(createFakeSupabase({ users: users() }));
  const r = await login({ username: "Admin ", password: "senha-certa" });
  assert.equal(r.status, 200);
  assert.ok(r.body.token);
});

test("20 senhas erradas para a mesma conta bloqueiam a conta, mesmo trocando de IP", async () => {
  _setSupabaseForTests(createFakeSupabase({ users: users() }));
  for (let i = 0; i < 20; i++) assert.equal((await login({ username: "staff", password: "errada" + i })).status, 401);
  assert.equal((await login({ username: "staff", password: "senha-certa" })).status, 429, "bloqueada até com a senha certa");
  assert.equal((await login({ username: "admin", password: "senha-certa" })).status, 200, "outra conta não é afetada");
});

test("acerto zera as falhas da conta", async () => {
  _setSupabaseForTests(createFakeSupabase({ users: [{ id: "u3", username: "outra", role: "staff", password_hash: HASH }] }));
  for (let i = 0; i < 19; i++) await login({ username: "outra", password: "x" });
  assert.equal((await login({ username: "outra", password: "senha-certa" })).status, 200);
  for (let i = 0; i < 19; i++) await login({ username: "outra", password: "x" });
  assert.equal((await login({ username: "outra", password: "senha-certa" })).status, 200);
});

test("usuário inexistente também conta (não revela se a conta existe)", async () => {
  _setSupabaseForTests(createFakeSupabase({ users: users() }));
  const r = await login({ username: "naoexiste", password: "x" });
  assert.equal(r.status, 401);
  assert.equal(r.body.error, "Credenciais inválidas");
});
