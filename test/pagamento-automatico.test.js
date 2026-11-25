// Pagamento automático (decisão do Paulo, 25/11/2026): reserva direta que não é
// Casa Fechada é considerada paga — a PMS registra um pagamento integral ao
// salvar. Casa Fechada direta continua com sinal/parcelas à mão. Supabase
// simulado; dados fictícios.
"use strict";
process.env.JWT_SECRET = "segredo-so-de-teste";
process.env.SUPABASE_URL = "http://127.0.0.1:9";
process.env.SUPABASE_KEY = "chave-falsa";

const test = require("node:test");
const assert = require("node:assert/strict");
const { app, _setSupabaseForTests } = require("../server");
const { createFakeSupabase } = require("./helpers/fake-supabase");
const { TEST_USERS, ADMIN, STAFF } = require("./helpers/auth");

let server, base;
test.before(async () => { server = app.listen(0); await new Promise(r => server.once("listening", r)); base = `http://127.0.0.1:${server.address().port}`; });
test.after(() => server.close());
const call = (method, p, body, auth = ADMIN()) => fetch(base + p, { method, headers: { "Content-Type": "application/json", Authorization: auth },
  body: body ? JSON.stringify(body) : undefined }).then(async r => ({ status: r.status, body: await r.json().catch(() => null) }));
function banco(reservations = [], pays = []) {
  const db = createFakeSupabase({ users: TEST_USERS.map(u => ({ ...u })), reservations, payments: pays, audit_log: [], settings: [] }, { noOverlap: true });
  _setSupabaseForTests(db);
  return db;
}
const NOVA = { guestName: "Hóspede Teste", roomId: "21", checkIn: "2099-03-10", checkOut: "2099-03-12", source: "direto", amount: 450, payment: "cartao" };
const pagos = (db, id) => db.tables.payments.filter(p => p.reservation_id === id);
const today = () => new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 10);

test("reserva direta comum com valor: pagamento integral automático (no Financeiro, com auditoria)", async () => {
  const db = banco();
  const r = await call("POST", "/reservations", { ...NOVA, id: "n1" });
  assert.equal(r.status, 200);
  assert.equal(r.body.warning, undefined);
  const [p] = pagos(db, "n1");
  assert.deepEqual([p.kind, Number(p.amount), p.method, p.paid_at, p.created_by], ["pagamento", 450, "cartao", today(), "automático"]);
  assert.ok(db.tables.audit_log.some(a => a.action === "pagamento.registrar" && a.changes.automatico === true));
});

test("sem pagamento automático: Airbnb/Booking, sem valor, pré-reserva (pendente) e criada por funcionário", async () => {
  const db = banco();
  await call("POST", "/reservations", { ...NOVA, id: "a1", source: "airbnb" });
  await call("POST", "/reservations", { ...NOVA, id: "a2", roomId: "22", amount: 0 });
  await call("POST", "/reservations", { ...NOVA, id: "a3", roomId: "23", status: "pending" });
  await call("POST", "/reservations", { ...NOVA, id: "a4", roomId: "24" }, STAFF());
  assert.equal(db.tables.payments.length, 0);
});

test("Casa Fechada direta: nada automático (sinal/parcelas à mão); Suíte 11+12 direta: um pagamento na linha do contrato", async () => {
  const ALL = ["10", "11", "12", "20", "21", "22", "23", "24", "25"];
  const db = banco();
  const cf = await call("POST", "/reservations/group", { rows: ALL.map((room, i) => ({ ...NOVA, id: "cf" + room, roomId: room, amount: 3000,
    notes: "[Casa toda:t1]" })) });
  assert.equal(cf.status, 200);
  assert.equal(db.tables.payments.length, 0);
  const su = await call("POST", "/reservations/group", { rows: ["11", "12"].map(room => ({ ...NOVA, id: "s" + room, roomId: room,
    checkIn: "2099-05-01", checkOut: "2099-05-03", amount: 700, notes: "[Suíte grupo:t2]" })) });
  assert.equal(su.status, 200);
  assert.deepEqual(db.tables.payments.map(p => [p.reservation_id, Number(p.amount)]), [["s11", 700]]);
});

test("mudar o valor ajusta o pagamento automático; zerar remove; cancelar mantém", async () => {
  const db = banco();
  await call("POST", "/reservations", { ...NOVA, id: "v1" });
  await call("PUT", "/reservations/v1", { amount: 520 });
  assert.deepEqual(pagos(db, "v1").map(p => Number(p.amount)), [520]);
  await call("PUT", "/reservations/v1", { status: "cancelled" });
  assert.equal(pagos(db, "v1").length, 1, "cancelada: pode ter havido recebimento (estorno é à mão)");
  await call("PUT", "/reservations/v1", { status: "confirmed" });
  await call("PUT", "/reservations/v1", { amount: 0 });
  assert.equal(pagos(db, "v1").length, 0);
  await call("PUT", "/reservations/v1", { amount: 300 });
  assert.deepEqual(pagos(db, "v1").map(p => Number(p.amount)), [300], "valor informado depois: registra");
});

test("pagamento registrado à mão: a PMS não mexe em nada", async () => {
  const db = banco([{ id: "m1", room_id: "21", source: "direto", status: "confirmed", guest_name: "T", amount: 450, check_in: "2099-04-01", check_out: "2099-04-02" }],
    [{ id: "pm", reservation_id: "m1", kind: "sinal", amount: 100, method: "pix", paid_at: "2099-03-01", created_by: "admin" }]);
  await call("PUT", "/reservations/m1", { amount: 600 });
  assert.deepEqual(pagos(db, "m1").map(p => [p.id, Number(p.amount)]), [["pm", 100]]);
});

test("se o pagamento automático falhar, a reserva fica salva e a resposta avisa", async () => {
  const db = banco();
  const from = db.from;
  db.from = (t) => { const q = from(t); if (t !== "payments") return q; const ins = q.insert; q.insert = () => ({ then: (ok) => ok({ data: null, error: { code: "XX000" } }) }); return q; };
  const r = await call("POST", "/reservations", { ...NOVA, id: "f1" });
  assert.equal(r.status, 200);
  assert.match(r.body.warning, /pagamento automático não foi registrado/);
  assert.ok(db.tables.reservations.some(x => x.id === "f1"));
});

// ── tela ─────────────────────────────────────────────────────────────────────
const { loadFrontend } = require("./helpers/frontend-harness");
function modal(r) {
  const fe = loadFrontend({});
  let html = "";
  const doc = fe.context.document;
  fe.context.document = new Proxy({}, { get: (_t, k) => k === "getElementById" ? (id) => (id === "modal-body" ? { set innerHTML(v) { html = v; } } : doc.getElementById(id)) : doc[k] });
  fe.run(`authRole = "admin"; paymentsEnabled = true; reservations = [${JSON.stringify(r)}].map(normalizeRes);
          loadPaymentsBox = () => {}; loadHistoryBox = () => {};`);
  fe.run(`openEditModal(${JSON.stringify(r.id)})`);
  return html;
}
test("tela: Casa Fechada direta mostra a caixa de pagamentos aberta; reserva comum, recolhida; Airbnb, nenhuma", () => {
  const base = { roomId: "21", guestName: "T", checkIn: "2099-01-01", checkOut: "2099-01-02", status: "confirmed", source: "direto", notes: "" };
  const cf = modal({ ...base, id: "c", roomId: "10", groupId: "cf:x" });
  assert.match(cf, /id="pay-box"/);
  assert.doesNotMatch(cf, /registrado automaticamente/);
  const comum = modal({ ...base, id: "d" });
  assert.match(comum, /<details[^>]*>\s*<summary[^>]*>💳 Pagamento \(registrado automaticamente\)<\/summary>\s*<div id="pay-box"/);
  assert.doesNotMatch(modal({ ...base, id: "e", source: "airbnb" }), /pay-box/);
});

test("tela: aviso do servidor aparece depois de salvar", async () => {
  const fe = loadFrontend({ routes: [{ method: "POST", path: "/reservations", reply: ({ body }) => ({ status: 200, json: { ok: true, reservation: { ...body }, warning: "A reserva foi salva, mas o pagamento automático não foi registrado." } }) }] });
  fe.run(`reservations = [];`);
  const r = await fe.run(`saveReservation({ id: "x", roomId: "21", guestName: "T", checkIn: "2099-01-01", checkOut: "2099-01-02", source: "direto" })`);
  assert.equal(r.ok, true);
  assert.match(fe.alerts.join(), /pagamento automático não foi registrado/);
});

test("editar o valor de uma Casa Fechada não cria pagamento automático", async () => {
  const ALL = ["10", "11", "12", "20", "21", "22", "23", "24", "25"];
  const db = banco(ALL.map((room, i) => ({ id: "k" + room, room_id: room, source: "direto", status: "confirmed", guest_name: "T",
    group_id: "cf:k", notes: "[Casa toda:k]", amount: i === 0 ? 3000 : 0, check_in: "2099-06-01", check_out: "2099-06-03" })));
  const r = await call("PUT", "/reservations/k10", { amount: 3500 });
  assert.equal(r.status, 200);
  assert.equal(db.tables.payments.length, 0);
});

test("reserva que volta a ser pré-reserva (pendente) perde o pagamento automático", async () => {
  const db = banco();
  await call("POST", "/reservations", { ...NOVA, id: "p1" });
  assert.equal(pagos(db, "p1").length, 1);
  await call("PUT", "/reservations/p1", { status: "pending" });
  assert.equal(pagos(db, "p1").length, 0);
});
