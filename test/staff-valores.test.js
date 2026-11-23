// Funcionário faz reservas mas não vê nem altera valores (decisão de 23/11/2026). Dados fictícios.
"use strict";
process.env.JWT_SECRET = "segredo-so-de-teste";
process.env.SUPABASE_URL = "http://127.0.0.1:9";
process.env.SUPABASE_KEY = "chave-falsa";

const test = require("node:test");
const assert = require("node:assert/strict");
const { app, _setSupabaseForTests } = require("../server");
const { createFakeSupabase } = require("./helpers/fake-supabase");
const { ADMIN, STAFF } = require("./helpers/auth");
const { loadFrontend } = require("./helpers/frontend-harness");

let server, base;
test.before(async () => { server = app.listen(0); await new Promise(r => server.once("listening", r)); base = `http://127.0.0.1:${server.address().port}`; });
test.after(() => server.close());

const R1 = { id: "r1", room_id: "20", guest_name: "Hóspede Teste", check_in: "2030-03-10", check_out: "2030-03-12",
             status: "confirmed", source: "direto", amount: 800, payment: "cartao", notes: "" };
function seed() { const db = createFakeSupabase({ reservations: [{ ...R1 }] }); _setSupabaseForTests(db); return db; }
const call = (method, p, auth, body) => fetch(base + p, { method, headers: { "Content-Type": "application/json", Authorization: auth },
  body: body ? JSON.stringify(body) : undefined }).then(async r => ({ status: r.status, body: await r.json().catch(() => null) }));
const NEW = { guestName: "Hóspede Novo", roomId: "21", checkIn: "2030-05-01", checkOut: "2030-05-03", source: "direto", amount: 500, payment: "dinheiro" };

test("GET /reservations: funcionário não recebe valor nem forma de pagamento; admin recebe", async () => {
  seed();
  const st = (await call("GET", "/reservations", STAFF())).body[0];
  assert.equal("amount" in st, false);
  assert.equal("payment" in st, false);
  assert.equal(st.guest_name, "Hóspede Teste", "o resto continua");
  const ad = (await call("GET", "/reservations", ADMIN())).body[0];
  assert.equal(ad.amount, 800);
  assert.equal(ad.payment, "cartao");
});

test("funcionário cria reserva: entra sem valor (fica para o admin) e a resposta não traz valor", async () => {
  const db = seed();
  const r = await call("POST", "/reservations", STAFF(), NEW);
  assert.equal(r.status, 200);
  assert.equal("amount" in r.body.reservation, false);
  const saved = db.tables.reservations.find(x => x.guest_name === "Hóspede Novo");
  assert.equal(saved.amount, 0);
});

test("admin cria reserva com valor normalmente", async () => {
  const db = seed();
  await call("POST", "/reservations", ADMIN(), NEW);
  assert.equal(db.tables.reservations.find(x => x.guest_name === "Hóspede Novo").amount, 500);
});

test("funcionário edita reserva: datas/notas mudam, valor e pagamento ficam como estavam", async () => {
  const db = seed();
  const r = await call("PUT", "/reservations/r1", STAFF(), { notes: "chega tarde", amount: 1, payment: "pix" });
  assert.equal(r.status, 200);
  const row = db.tables.reservations.find(x => x.id === "r1");
  assert.equal(row.notes, "chega tarde");
  assert.equal(row.amount, 800);
  assert.equal(row.payment, "cartao");
});

test("formulário sem campo de valor (amount: 0) vindo do funcionário não apaga o valor", async () => {
  const db = seed();
  await call("PUT", "/reservations/r1", STAFF(), { guestName: "Hóspede Teste", amount: 0 });
  assert.equal(db.tables.reservations.find(x => x.id === "r1").amount, 800);
});

test("admin altera valor normalmente", async () => {
  const db = seed();
  await call("PUT", "/reservations/r1", ADMIN(), { amount: 900 });
  assert.equal(db.tables.reservations.find(x => x.id === "r1").amount, 900);
});

test("Casa Fechada/11+12 pelo funcionário: linhas sem valor e resposta sem valor", async () => {
  const db = seed();
  const rows = ["11", "12"].map((roomId, i) => ({ id: `s${i}`, roomId, guestName: "Grupo Teste", checkIn: "2030-07-01", checkOut: "2030-07-03", amount: 999, payment: "pix" }));
  const r = await call("POST", "/reservations/group", STAFF(), { rows });
  assert.equal(r.status, 200);
  assert.ok(r.body.reservations.every(x => !("amount" in x)));
  assert.ok(db.tables.reservations.filter(x => x.id.startsWith("s")).every(x => x.amount === 0));
});

test("funcionário continua sem acesso ao financeiro (403)", async () => {
  seed();
  assert.equal((await call("GET", "/transactions", STAFF())).status, 403);
});

// ── Tela ─────────────────────────────────────────────────────────────────────
function formHtml(role) {
  const fe = loadFrontend({});
  fe.run(`authRole = ${JSON.stringify(role)};`);
  return fe.run(`reservationForm({ roomId: "20", guestName: "", checkIn: "2030-03-10", checkOut: "2030-03-12", amount: 800, payment: "cartao" }, true)`);
}

test("tela: funcionário não vê os campos de valor e pagamento; admin vê", () => {
  const staff = formHtml("staff");
  assert.doesNotMatch(staff, /f-amount|f-payment|Valor Total/);
  assert.doesNotMatch(staff, /800/);
  assert.match(formHtml("admin"), /id="f-amount"[^>]*value="800"/);
});

test("tela: funcionário salvando reserva não envia valor nem pagamento", async () => {
  const fe = loadFrontend({
    fields: { "f-roomId": "20", "f-guestName": "Hóspede Teste", "f-checkIn": "2030-03-10", "f-checkOut": "2030-03-12", "f-source": "direto", "f-amount": "", "f-payment": "" },
    routes: [{ method: "POST", path: "/reservations", reply: ({ body }) => ({ status: 200, json: { ok: true, reservation: { ...body } } }) }],
  });
  fe.run(`authRole = "staff"; reservations = []; transactions = [];`);
  await fe.run("submitForm(null)");
  const post = fe.calls.find(c => c.method === "POST" && c.path === "/reservations");
  assert.ok(post);
  assert.equal("amount" in post.body, false);
  assert.equal("payment" in post.body, false);
  assert.equal(fe.calls.filter(c => c.path.startsWith("/transactions")).length, 0);
});
