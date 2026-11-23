// Decisões de 23/11/2026: "pending" não bloqueia datas; capacidade só avisa. Dados fictícios.
"use strict";
process.env.JWT_SECRET = "segredo-so-de-teste";
process.env.SUPABASE_URL = "http://127.0.0.1:9";
process.env.SUPABASE_KEY = "chave-falsa";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { app, _setSupabaseForTests } = require("../server");
const { createFakeSupabase } = require("./helpers/fake-supabase");
const { STAFF } = require("./helpers/auth");
const { loadFrontend } = require("./helpers/frontend-harness");

let server, base;
test.before(async () => { server = app.listen(0); await new Promise(r => server.once("listening", r)); base = `http://127.0.0.1:${server.address().port}`; });
test.after(() => server.close());
const quiet = (fn) => async () => { const o = [console.log, console.warn]; console.log = console.warn = () => {}; try { await fn(); } finally { [console.log, console.warn] = o; } };

const PEND = { id: "p1", room_id: "20", guest_name: "Pré Teste", check_in: "2099-03-10", check_out: "2099-03-12", status: "pending", source: "direto" };

test("servidor (enforce): reserva por cima de uma pending é aceita", quiet(async () => {
  const prev = process.env.AVAILABILITY_CHECK; process.env.AVAILABILITY_CHECK = "enforce";
  try {
    _setSupabaseForTests(createFakeSupabase({ reservations: [{ ...PEND }] }));
    const r = await fetch(base + "/reservations", { method: "POST", headers: { "Content-Type": "application/json", Authorization: STAFF() },
      body: JSON.stringify({ guestName: "Teste", roomId: "20", checkIn: "2099-03-10", checkOut: "2099-03-12" }) });
    assert.equal(r.status, 200);
  } finally { if (prev === undefined) delete process.env.AVAILABILITY_CHECK; else process.env.AVAILABILITY_CHECK = prev; }
}));

test("feed antigo não bloqueia datas de pending nas OTAs (só confirmadas)", quiet(async () => {
  _setSupabaseForTests(createFakeSupabase({ reservations: [{ ...PEND },
    { id: "c1", room_id: "20", guest_name: "X", check_in: "2099-04-01", check_out: "2099-04-02", status: "confirmed", source: "direto" }] }));
  const body = await (await fetch(base + "/calendar/20.ics")).text();
  assert.doesNotMatch(body, /20990310/);
  assert.match(body, /20990401/);
}));

test("migration da constraint ignora pending (mesma regra do servidor)", () => {
  const up = fs.readFileSync(path.join(__dirname, "..", "db", "migrations", "20261123_01_reservations_no_overlap.sql"), "utf8");
  assert.equal((up.match(/not in \('cancelled', 'pending'\)/g) || []).length, 3);
  assert.doesNotMatch(up, /<> 'cancelled'/);
});

test("tela: pending não aparece como conflito nem como overbooking", () => {
  const fe = loadFrontend({});
  fe.run(`reservations = [{ id: "p1", roomId: "20", checkIn: "2099-03-10", checkOut: "2099-03-12", status: "pending" }];`);
  assert.equal(fe.run(`localConflict(["20"], "2099-03-10", "2099-03-12", null)`), undefined);
  fe.run(`reservations.push({ id: "c1", roomId: "20", checkIn: "2099-03-11", checkOut: "2099-03-13", status: "confirmed" });`);
  assert.equal(fe.run(`reservations.filter(occupies).length`), 1);
});

// ── Capacidade ───────────────────────────────────────────────────────────────
function fe(fields, existing = "[]") {
  const f = loadFrontend({ fields, routes: [
    { method: "POST", path: "/reservations", reply: ({ body }) => ({ status: 200, json: { ok: true, reservation: { ...body } } }) },
    { method: "PUT", path: /^\/reservations\//, reply: () => ({ status: 200, json: { ok: true } }) },
  ] });
  f.run(`authRole = "staff"; reservations = ${existing}; transactions = [];
         var __asks = []; var __answer = false; confirm = (m) => { __asks.push(m); return __answer; };`);
  return f;
}
const FORM = (roomId, adults, children = 0) => ({ "f-roomId": roomId, "f-guestName": "Hóspede Teste", "f-checkIn": "2099-05-01", "f-checkOut": "2099-05-03",
  "f-source": "direto", "f-adults": String(adults), "f-children": String(children), "f-phone": "", "f-notes": "", "f-email": "" });

test("capacidade: acima do limite pergunta; 'não' cancela sem gravar", async () => {
  const f = fe(FORM("24", 2, 1));
  await f.run("submitForm(null)");
  assert.match(f.run("__asks[0]"), /3 hóspedes para o quarto 24, que comporta 2/);
  assert.equal(f.calls.filter(c => c.method === "POST").length, 0);
});

test("capacidade: 'sim' grava mesmo assim (só aviso, nunca bloqueio)", async () => {
  const f = fe(FORM("24", 3));
  f.run("__answer = true;");
  await f.run("submitForm(null)");
  assert.equal(f.calls.filter(c => c.method === "POST" && c.path === "/reservations").length, 1);
});

test("capacidade: dentro do limite não pergunta nada", async () => {
  const f = fe(FORM("20", 4));
  await f.run("submitForm(null)");
  assert.equal(f.run("__asks.length"), 0);
  assert.equal(f.calls.filter(c => c.method === "POST").length, 1);
});

test("capacidade: editar reserva que já tinha cama extra combinada não insiste", async () => {
  const existing = JSON.stringify([{ id: "e1", roomId: "24", guestName: "Hóspede Teste", checkIn: "2099-05-01", checkOut: "2099-05-03", status: "confirmed", adults: 3, children: 0 }]);
  const f = fe(FORM("24", 3), existing);
  await f.run(`submitForm("e1")`);
  assert.equal(f.run("__asks.length"), 0);
  const g = fe(FORM("24", 4), existing);
  await g.run(`submitForm("e1")`);
  assert.equal(g.run("__asks.length"), 1, "aumentou: pergunta de novo");
});

test("capacidade: 11+12 e Casa Fechada usam a soma dos quartos", () => {
  const f = loadFrontend({});
  assert.equal(f.run(`capacityOf("11+12")`), 6);
  assert.equal(f.run(`capacityOf("CF")`), 28);
});
