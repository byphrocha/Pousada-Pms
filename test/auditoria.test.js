// PMS-014: auditoria de alterações. Dados fictícios.
"use strict";
process.env.JWT_SECRET = "segredo-so-de-teste";
process.env.SUPABASE_URL = "http://127.0.0.1:9";
process.env.SUPABASE_KEY = "chave-falsa";

const test = require("node:test");
const assert = require("node:assert/strict");
const A = require("../lib/audit");
const { app, _setSupabaseForTests } = require("../server");
const { createFakeSupabase } = require("./helpers/fake-supabase");
const { ADMIN, STAFF } = require("./helpers/auth");
const { loadFrontend } = require("./helpers/frontend-harness");

// Dados pessoais fictícios que NUNCA podem aparecer na auditoria.
const NOME = "Fulana Ficticia", FONE = "44911112222", OBS = "chega tarde, alergia";
const PESSOAL = new RegExp([NOME, FONE, OBS, "Outro Nome Ficticio", "44933334444", "nova obs"].join("|"));

// ── Regras puras ─────────────────────────────────────────────────────────────
test("diff: só campos operacionais com antes → depois; pessoais viram só o NOME do campo", () => {
  const before = { room_id: "20", check_in: "2030-03-10", check_out: "2030-03-12", status: "confirmed", amount: "800.00",
                   guest_name: NOME, phone: FONE, notes: OBS };
  const after = { check_out: "2030-03-13", amount: 900, guest_name: "Outro Nome Ficticio", phone: FONE, notes: "nova obs" };
  const d = A.diff(before, after);
  assert.deepEqual(d, { check_out: ["2030-03-12", "2030-03-13"], amount: [800, 900], privados: ["nome", "observações"] });
  assert.doesNotMatch(JSON.stringify(d), PESSOAL);
});

test("diff: valor igual em formatos diferentes não conta como mudança", () => {
  assert.deepEqual(A.diff({ amount: "800.00", check_in: "2030-03-10T00:00:00Z" }, { amount: 800, check_in: "2030-03-10" }), {});
});

test("reservationAction: cancelar e reativar têm nome próprio", () => {
  assert.equal(A.reservationAction({ status: ["confirmed", "cancelled"] }), "reserva.cancelar");
  assert.equal(A.reservationAction({ status: ["cancelled", "confirmed"] }), "reserva.reativar");
  assert.equal(A.reservationAction({ check_out: ["a", "b"] }), "reserva.editar");
});

// ── Rotas ────────────────────────────────────────────────────────────────────
let server, base;
test.before(async () => { server = app.listen(0); await new Promise(r => server.once("listening", r)); base = `http://127.0.0.1:${server.address().port}`; });
test.after(() => server.close());
const quiet = (fn) => async () => { const o = console.error; console.error = () => {}; try { await fn(); } finally { console.error = o; } };
const call = (method, p, auth, body) => fetch(base + p, { method, headers: { "Content-Type": "application/json", Authorization: auth },
  body: body ? JSON.stringify(body) : undefined }).then(async r => ({ status: r.status, body: await r.json().catch(() => null) }));

const R1 = { id: "r1", room_id: "20", guest_name: NOME, phone: FONE, notes: OBS, check_in: "2030-03-10", check_out: "2030-03-12",
             status: "confirmed", source: "direto", amount: 800, payment: "pix" };
function seed() {
  const db = createFakeSupabase({ reservations: [{ ...R1 }], payments: [], audit_log: [] });
  _setSupabaseForTests(db);
  return db;
}
const log = (db) => db.tables.audit_log;

test("criar reserva: registra quem, papel e campos operacionais — sem nome/telefone/obs", async () => {
  const db = seed();
  await call("POST", "/reservations", STAFF(), { guestName: NOME, phone: FONE, notes: OBS, roomId: "21", checkIn: "2030-05-01", checkOut: "2030-05-03" });
  const [e] = log(db);
  assert.equal(e.action, "reserva.criar");
  assert.equal(e.username, "staff");
  assert.equal(e.role, "staff");
  assert.equal(e.changes.room_id, "21");
  assert.equal(e.reservation_id, e.entity_id);
  assert.doesNotMatch(JSON.stringify(log(db)), PESSOAL);
});

test("funcionário cancela: ação 'reserva.cancelar' com status antes → depois", async () => {
  const db = seed();
  await call("PUT", "/reservations/r1", STAFF(), { status: "cancelled" });
  assert.deepEqual(log(db).map(e => [e.action, e.username, e.changes.status]), [["reserva.cancelar", "staff", ["confirmed", "cancelled"]]]);
});

test("editar só nome/observação: registra que mudou, sem os valores", async () => {
  const db = seed();
  await call("PUT", "/reservations/r1", ADMIN(), { guestName: "Outro Nome Ficticio", notes: "nova obs" });
  const [e] = log(db);
  assert.equal(e.action, "reserva.editar");
  assert.deepEqual(e.changes, { privados: ["nome", "observações"] });
  assert.doesNotMatch(JSON.stringify(log(db)), PESSOAL);
});

test("salvar sem mudar nada não gera registro", async () => {
  const db = seed();
  await call("PUT", "/reservations/r1", ADMIN(), { checkIn: "2030-03-10", checkOut: "2030-03-12", guestName: NOME });
  assert.equal(log(db).length, 0);
});

test("pagamentos: registrar, marcar recebido e excluir ficam no histórico da reserva", async () => {
  const db = seed();
  const p = await call("POST", "/reservations/r1/payments", ADMIN(), { kind: "parcela", amount: 300, dueDate: "2030-02-01" });
  await call("PUT", `/payments/${p.body.payment.id}`, ADMIN(), { paidAt: "2026-01-05", method: "pix" });
  await call("DELETE", `/payments/${p.body.payment.id}`, ADMIN());
  assert.deepEqual(log(db).map(e => [e.action, e.reservation_id]),
    [["pagamento.registrar", "r1"], ["pagamento.receber", "r1"], ["pagamento.excluir", "r1"]]);
  const h = await call("GET", "/reservations/r1/history", ADMIN());
  assert.equal(h.body.enabled, true);
  assert.equal(h.body.items.length, 3);
});

test("histórico é só do admin; registros não podem ser apagados pela API (não há rota)", async () => {
  seed();
  assert.equal((await call("GET", "/reservations/r1/history", STAFF())).status, 403);
  assert.equal((await call("DELETE", "/audit/1", ADMIN())).status, 404);
});

test("falha ao gravar a auditoria NÃO impede a operação principal", quiet(async () => {
  const db = seed();
  const orig = db.from;
  db.from = (t) => { const q = orig(t); if (t === "audit_log") q.insert = () => ({ then: (res) => Promise.resolve({ data: null, error: { code: "XX000" } }).then(res) }); return q; };
  const r = await call("PUT", "/reservations/r1", STAFF(), { status: "cancelled" });
  assert.equal(r.status, 200);
  assert.equal(db.tables.reservations[0].status, "cancelled");
}));

test("sem a tabela audit_log (antes da migration): tudo funciona e o histórico diz que está desligado", async () => {
  const db = createFakeSupabase({ reservations: [{ ...R1 }] });
  const orig = db.from;
  db.from = (t) => { if (t !== "audit_log") return orig(t); const q = orig(t);
    q.select = () => ({ limit() { return this; }, then: (res) => Promise.resolve({ data: null, error: { code: "42P01", message: "does not exist" } }).then(res) });
    q.insert = () => { throw new Error("não deveria gravar"); };
    return q; };
  _setSupabaseForTests(db);
  assert.equal((await call("PUT", "/reservations/r1", ADMIN(), { status: "cancelled" })).status, 200);
  assert.deepEqual((await call("GET", "/reservations/r1/history", ADMIN())).body, { enabled: false, items: [] });
});

// ── Tela ─────────────────────────────────────────────────────────────────────
test("tela: histórico legível (quem, ação, antes → depois) e sem HTML injetado", () => {
  const fe = loadFrontend({});
  const html = fe.run(`renderHistoryBox([
    { at: "2030-01-05T13:40:00Z", username: "staff", action: "reserva.cancelar", changes: { status: ["confirmed", "cancelled"] } },
    { at: "2030-01-04T10:00:00Z", username: "<b>x</b>", action: "reserva.editar", changes: { check_out: ["2030-03-12", "2030-03-13"], privados: ["nome"] } },
  ])`);
  assert.match(html, /Histórico \(2\)/);
  assert.match(html, /staff cancelou/);
  assert.match(html, /saída: 12\/03\/2030 → 13\/03\/2030 · alterou nome/);
  assert.doesNotMatch(html, /<b>x<\/b>/);
});

test("snapshot: quarto e datas continuam texto; só valor/adultos/crianças viram número", () => {
  assert.deepEqual(A.snapshot({ room_id: "21", check_in: "2030-05-01", amount: "800.50", adults: "2", status: "confirmed" }),
    { room_id: "21", check_in: "2030-05-01", amount: 800.5, adults: 2, status: "confirmed" });
});
