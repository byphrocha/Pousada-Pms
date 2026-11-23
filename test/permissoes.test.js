// PMS-015: matriz de permissões por rota e regras de sessão. Dados fictícios.
"use strict";
process.env.JWT_SECRET = "segredo-so-de-teste";
process.env.SUPABASE_URL = "http://127.0.0.1:9";
process.env.SUPABASE_KEY = "chave-falsa";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { app, _setSupabaseForTests, _resetSessionCacheForTests } = require("../server");
const { createFakeSupabase } = require("./helpers/fake-supabase");
const { TEST_USERS, tokenFor, ADMIN, STAFF } = require("./helpers/auth");

let server, base;
test.before(async () => { server = app.listen(0); await new Promise(r => server.once("listening", r)); base = `http://127.0.0.1:${server.address().port}`; });
test.after(() => server.close());

const quiet = (fn) => async () => { const o = [console.log, console.warn, console.error];
  console.log = console.warn = console.error = () => {}; try { await fn(); } finally { [console.log, console.warn, console.error] = o; } };
function call(method, p, auth, body) {
  return fetch(base + p, { method, headers: { "Content-Type": "application/json", ...(auth ? { Authorization: auth } : {}) },
    body: body ? JSON.stringify(body) : undefined })
    .then(async r => ({ status: r.status, body: await r.json().catch(() => null) }));
}
function seed(extra = {}) {
  const db = createFakeSupabase({
    reservations: [{ id: "r1", room_id: "20", guest_name: "Hóspede Teste", check_in: "2030-03-10", check_out: "2030-03-12", status: "confirmed", source: "direto" }],
    guests: [{ id: "g1", name: "Hóspede Teste", cpf: "111.222.333-96", phone: "", email: "" }],
    transactions: [{ id: "t1", type: "income", amount: 1, date: "2030-03-10", month: "2030-03" }],
    prereservations: [{ id: "p1", room_id: "20", guest_name: "Pré Teste", check_in: "2030-04-01", check_out: "2030-04-02" }],
    settings: [{ key: "ical_urls", value: { airbnb: {}, booking: {} } }],
    ...extra,
  });
  _setSupabaseForTests(db);
  return db;
}

// ── Matriz: quem pode chamar o quê ──────────────────────────────────────────
// "todos" = qualquer usuário logado; "admin" = só administrador; "publica" = sem login.
// Os corpos são mínimos: o teste só olha se a rota DEIXA PASSAR (não 401/403).
const ROTAS = [
  ["POST",   "/change-password",            "todos",  {}],
  ["GET",    "/guests",                     "todos"],
  ["GET",    "/guests/g1",                  "todos"],
  ["POST",   "/guests",                     "todos",  { name: "Hóspede Novo" }],
  ["PUT",    "/guests/g1",                  "todos",  { name: "Hóspede Teste" }],
  ["DELETE", "/guests/g1",                  "admin"],
  ["GET",    "/reservations",               "todos"],
  ["POST",   "/reservations",               "todos",  { guestName: "Teste", roomId: "21", checkIn: "2030-05-01", checkOut: "2030-05-02" }],
  ["POST",   "/reservations/group",         "todos",  { rows: [] }],
  ["PUT",    "/reservations/r1",            "todos",  { notes: "obs" }],
  ["DELETE", "/reservations/r1",            "admin"],
  ["GET",    "/urls",                       "admin"],
  ["POST",   "/urls",                       "admin",  { airbnb: {}, booking: {} }],
  ["GET",    "/sync/status",                "todos"],
  ["POST",   "/sync",                       "admin"],
  ["GET",    "/proxy-ical",                 "admin"],
  ["POST",   "/cleanup-blocked",            "admin"],
  ["GET",    "/room-states",                "todos"],
  ["POST",   "/room-states",                "todos",  { cleaned: [], checkedIn: [] }],
  ["POST",   "/room-states/20/cleaned",     "todos",  { value: true }],
  ["GET",    "/transactions",               "admin"],
  ["POST",   "/transactions",               "admin",  { type: "income", amount: 1, date: "2030-03-10" }],
  ["PUT",    "/transactions/t1",            "admin",  { amount: 2 }],
  ["DELETE", "/transactions/t1",            "admin"],
  ["GET",    "/prereservations",            "admin"],
  ["POST",   "/prereservations",            "admin",  { guestName: "Pré", roomId: "20", checkIn: "2030-06-01", checkOut: "2030-06-02" }],
  ["PUT",    "/prereservations/p1",         "admin",  { notes: "x" }],
  ["DELETE", "/prereservations/p1",         "admin"],
  ["GET",    "/calendar-urls",              "admin"],
  ["POST",   "/login",                      "publica"],
  ["GET",    "/healthz",                    "publica"],
  ["GET",    "/calendar/TOKEN/20.ics",      "publica"],
  ["GET",    "/calendar/20.ics",            "publica"],
  ["GET",    "*",                           "publica"],
];
// Caminho da rota no server.js correspondente a cada linha acima.
const DECLARADA = (p) => p
  .replace(/\/g1$/, "/:id").replace(/\/r1$/, "/:id").replace(/\/t1$/, "/:id").replace(/\/p1$/, "/:id")
  .replace("/room-states/20/cleaned", "/room-states/:roomId/:kind")
  .replace("/calendar/TOKEN/20.ics", "/calendar/:token/:roomId.ics")
  .replace("/calendar/20.ics", "/calendar/:roomId.ics");

test("toda rota do server.js está classificada na matriz (rota nova sem dono quebra este teste)", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  const declared = [...src.matchAll(/^app\.(get|post|put|delete|patch)\("([^"]+)"/gm)].map(m => `${m[1].toUpperCase()} ${m[2]}`).sort();
  const matrix = ROTAS.map(([m, p]) => `${m} ${DECLARADA(p)}`).sort();
  assert.deepEqual(matrix, declared);
});

for (const [method, p, quem, body] of ROTAS) {
  if (quem === "publica" || p === "*") continue;
  test(`${method} ${p} — sem login 401; token adulterado 401; staff ${quem === "admin" ? "403" : "passa"}; admin passa`, quiet(async () => {
    seed();
    assert.equal((await call(method, p, null, body)).status, 401, "sem login");
    const forged = "Bearer " + jwt.sign({ userId: "u1", role: "admin", username: "admin", pv: "x" }, "outro-segredo", { algorithm: "HS256" });
    assert.equal((await call(method, p, forged, body)).status, 401, "assinado com outro segredo");
    const st = (await call(method, p, STAFF(), body)).status;
    if (quem === "admin") assert.equal(st, 403, "staff barrado");
    else assert.ok(![401, 403].includes(st), `staff deveria passar, veio ${st}`);
    seed();
    const ad = (await call(method, p, ADMIN(), body)).status;
    assert.ok(![401, 403].includes(ad), `admin deveria passar, veio ${ad}`);
  }));
}

test("rotas públicas respondem sem login", quiet(async () => {
  seed();
  assert.equal((await call("GET", "/healthz")).status, 200);
  assert.notEqual((await call("POST", "/login", null, {})).status, 401, "login inválido é 400, não 401");
}));

// ── Sessão ───────────────────────────────────────────────────────────────────
test("token antigo (sem impressão da senha) não vale mais", async () => {
  seed();
  const old = "Bearer " + jwt.sign({ userId: "u1", role: "admin", username: "admin" }, process.env.JWT_SECRET, { algorithm: "HS256" });
  assert.equal((await call("GET", "/reservations", old)).status, 401);
});

test("token com alg none ou papel forjado não passa", async () => {
  seed();
  const none = "Bearer " + jwt.sign({ userId: "u2", role: "admin" }, null, { algorithm: "none" });
  assert.equal((await call("GET", "/urls", none)).status, 401);
  // Staff que edita o próprio token para "admin" precisaria re-assinar: sem o segredo, 401.
  const [h, , sig] = STAFF().slice(7).split(".");
  const payload = Buffer.from(JSON.stringify({ userId: "u2", role: "admin", username: "staff", pv: "x" })).toString("base64url");
  assert.equal((await call("GET", "/urls", `Bearer ${h}.${payload}.${sig}`)).status, 401);
});

test("papel vem do banco: admin rebaixado a staff perde acesso mesmo com token de admin", async () => {
  const db = seed();
  const tok = ADMIN();
  assert.equal((await call("GET", "/urls", tok)).status, 200);
  db.tables.users.find(u => u.id === "u1").role = "staff";
  _resetSessionCacheForTests(); // em produção: até 60 s de cache
  assert.equal((await call("GET", "/urls", tok)).status, 403);
});

test("usuário removido do banco: token deixa de valer", async () => {
  const db = seed();
  const tok = STAFF();
  db.tables.users = db.tables.users.filter(u => u.id !== "u2");
  _resetSessionCacheForTests();
  assert.equal((await call("GET", "/reservations", tok)).status, 401);
});

test("falha ao consultar usuários → 503 (não deixa passar, não 500)", quiet(async () => {
  const real = createFakeSupabase({});
  _setSupabaseForTests({ from(t) {
    if (t !== "users") return real.from(t);
    const q = real.from(t);
    q.maybeSingle = () => ({ then: (res) => Promise.resolve({ data: null, error: { message: "x" } }).then(res) });
    return q;
  } });
  const r = await call("GET", "/reservations", ADMIN());
  assert.equal(r.status, 503);
}));

// ── Troca de senha ───────────────────────────────────────────────────────────
const HASH = bcrypt.hashSync("senha-atual-1", 4);
const withRealPass = () => seed({ users: TEST_USERS.map(u => (u.id === "u2" ? { ...u, password_hash: HASH } : { ...u })) });
const staffTok = () => tokenFor({ ...TEST_USERS[1], password_hash: HASH });

test("trocar a senha derruba os tokens antigos e devolve um token novo que funciona", async () => {
  withRealPass();
  const old = staffTok();
  const r = await call("POST", "/change-password", old, { currentPassword: "senha-atual-1", newPassword: "senha-nova-2" });
  assert.equal(r.status, 200);
  assert.ok(r.body.token);
  assert.equal((await call("GET", "/reservations", old)).status, 401, "token antigo caiu");
  assert.equal((await call("GET", "/reservations", "Bearer " + r.body.token)).status, 200, "token novo vale");
});

test("senha atual errada → 400 (não 401, que deslogaria a tela) e conta no limite de tentativas", async () => {
  withRealPass();
  const tok = staffTok();
  for (let i = 0; i < 20; i++) {
    const r = await call("POST", "/change-password", tok, { currentPassword: "errada" + i, newPassword: "senha-nova-2" });
    assert.equal(r.status, 400, `tentativa ${i}`);
  }
  const blocked = await call("POST", "/change-password", tok, { currentPassword: "senha-atual-1", newPassword: "senha-nova-2" });
  assert.equal(blocked.status, 429, "bloqueado mesmo com a senha certa");
});

test("troca de senha valida tipos e tamanho (bcrypt ignora além de 72 bytes)", async () => {
  withRealPass();
  const tok = staffTok();
  for (const body of [{ currentPassword: ["x"], newPassword: "senha-nova-2" }, { currentPassword: "senha-atual-1", newPassword: 123456 },
                      { currentPassword: "senha-atual-1", newPassword: "12345" }, { currentPassword: "senha-atual-1", newPassword: "x".repeat(73) }]) {
    assert.equal((await call("POST", "/change-password", tok, body)).status, 400, JSON.stringify(body).slice(0, 60));
  }
});

// ── Tela ─────────────────────────────────────────────────────────────────────
test("tela: após trocar a senha guarda o token novo (este aparelho continua logado)", async () => {
  const { loadFrontend } = require("./helpers/frontend-harness");
  const fe = loadFrontend({
    fields: { "cp-cur": "senha-atual-1", "cp-new": "senha-nova-2", "cp-new2": "senha-nova-2" },
    routes: [{ method: "POST", path: "/change-password", reply: () => ({ status: 200, json: { ok: true, token: "tok-novo" } }) }],
  });
  fe.run(`setAuth("tok-velho", "staff", "staff");`);
  await fe.run("doChangePassword()");
  assert.equal(fe.run("authToken"), "tok-novo");
});
