// PMS-007: pagamentos separados do valor contratado (regra 6). Dados fictícios.
"use strict";
process.env.JWT_SECRET = "segredo-so-de-teste";
process.env.SUPABASE_URL = "http://127.0.0.1:9";
process.env.SUPABASE_KEY = "chave-falsa";

const test = require("node:test");
const assert = require("node:assert/strict");
const P = require("../lib/payments");
const { app, _setSupabaseForTests } = require("../server");
const { createFakeSupabase } = require("./helpers/fake-supabase");
const { ADMIN, STAFF } = require("./helpers/auth");
const { loadFrontend } = require("./helpers/frontend-harness");

const TODAY = "2030-01-10";

// ── Regras puras ─────────────────────────────────────────────────────────────
test("validatePayment: casos válidos", () => {
  assert.deepEqual(P.validatePayment({ kind: "sinal", amount: 300, method: "pix", paidAt: "2030-01-05" }, TODAY).value,
    { kind: "sinal", amount: 300, method: "pix", due_date: null, paid_at: "2030-01-05", notes: "" });
  assert.equal(P.validatePayment({ kind: "parcela", amount: "350,50", dueDate: "2030-02-05" }, TODAY).value.amount, 350.5);
  assert.ok(P.validatePayment({ kind: "estorno", amount: 100, method: "pix", paidAt: TODAY }, TODAY).value);
});

test("validatePayment: recusa o que viraria dado errado no caixa", () => {
  const bad = [
    [{ kind: "gorjeta", amount: 1, method: "pix", paidAt: TODAY }, /Tipo/],
    [{ kind: "sinal", amount: 0, method: "pix", paidAt: TODAY }, /maior que zero/],
    [{ kind: "sinal", amount: -5, method: "pix", paidAt: TODAY }, /maior que zero/],
    [{ kind: "sinal", amount: "abc", method: "pix", paidAt: TODAY }, /maior que zero/],
    [{ kind: "sinal", amount: 10.555, method: "pix", paidAt: TODAY }, /2 casas/],
    [{ kind: "parcela", amount: 10 }, /data/],
    [{ kind: "sinal", amount: 10, paidAt: TODAY }, /forma/],
    [{ kind: "sinal", amount: 10, method: "bitcoin", paidAt: TODAY }, /Forma/],
    [{ kind: "sinal", amount: 10, method: "pix", paidAt: "2030-01-11" }, /futuro/],
    [{ kind: "estorno", amount: 10, dueDate: "2030-02-01" }, /Estorno/],
    [{ kind: "parcela", amount: 10, dueDate: "2030-02-30" }, /Vencimento/],
  ];
  for (const [b, re] of bad) assert.match(P.validatePayment(b, TODAY).error || "", re, JSON.stringify(b));
});

test("summarize: contratado ≠ recebido; estorno reduz o recebido; parcelas vencidas", () => {
  const s = P.summarize(3000, [
    { id: "a", kind: "sinal", amount: 900, paid_at: "2030-01-02" },
    { id: "b", kind: "parcela", amount: 1050, due_date: "2030-01-08", paid_at: null },   // vencida
    { id: "c", kind: "parcela", amount: 1050, due_date: "2030-02-08", paid_at: null },
    { id: "d", kind: "estorno", amount: 100, paid_at: "2030-01-09" },
  ], TODAY);
  assert.deepEqual(s, { contracted: 3000, received: 900, refunded: 100, net: 800, balance: 2200,
                        scheduled: 2100, unscheduled: 100, overdue: ["b"] });
});

test("summarize: centavos sem erro de ponto flutuante (0,1 + 0,2)", () => {
  const s = P.summarize(0.3, [{ kind: "pagamento", amount: 0.1, paid_at: TODAY }, { kind: "pagamento", amount: 0.2, paid_at: TODAY }], TODAY);
  assert.equal(s.balance, 0);
});

test("groupTag/pickLead: Casa toda tem precedência; dono do contrato = maior valor", () => {
  assert.equal(P.groupTag("x [Casa toda:g1] [Suíte grupo:g2]"), "[Casa toda:g1]");
  assert.equal(P.groupTag("[Suíte grupo:g2]"), "[Suíte grupo:g2]");
  assert.equal(P.groupTag("nada"), null);
  assert.equal(P.pickLead([{ id: "b", amount: 0 }, { id: "a", amount: 5000 }, { id: "c", amount: 0 }]).id, "a");
});

// ── Rotas ────────────────────────────────────────────────────────────────────
let server, base;
test.before(async () => { server = app.listen(0); await new Promise(r => server.once("listening", r)); base = `http://127.0.0.1:${server.address().port}`; });
test.after(() => server.close());
const call = (method, p, auth, body) => fetch(base + p, { method, headers: { "Content-Type": "application/json", Authorization: auth },
  body: body ? JSON.stringify(body) : undefined }).then(async r => ({ status: r.status, body: await r.json().catch(() => null) }));

const CF = ["10","11","12","20","21","22","23","24","25"].map((room, i) => ({
  id: `cf${i}`, room_id: room, guest_name: "Grupo Teste", check_in: "2030-12-24", check_out: "2030-12-27",
  source: "direto", status: "confirmed", amount: i === 0 ? 9000 : 0, created_at: `2030-01-01T00:00:0${i}Z`,
  notes: ` [Casa toda:gx]${room === "11" || room === "12" ? " [Suíte grupo:sx]" : ""}` }));
const AIR = { id: "air1", room_id: "21", guest_name: "Reserved", check_in: "2030-03-01", check_out: "2030-03-03", source: "airbnb", status: "confirmed", amount: 0, notes: "" };
function seed(extra = {}) {
  const db = createFakeSupabase({ reservations: [...CF.map(r => ({ ...r })), { ...AIR }], payments: [], transactions: [], ...extra });
  _setSupabaseForTests(db);
  return db;
}

test("CF: pagamento registrado em qualquer quarto do grupo vai para a linha dona do contrato", async () => {
  const db = seed();
  const r = await call("POST", "/reservations/cf5/payments", ADMIN(), { kind: "sinal", amount: 2700, method: "pix", paidAt: "2026-01-05" });
  assert.equal(r.status, 200);
  assert.equal(db.tables.payments[0].reservation_id, "cf0");
  const g = await call("GET", "/reservations/cf7/payments", ADMIN());
  assert.equal(g.body.leadId, "cf0");
  assert.equal(g.body.label, "Casa Fechada");
  assert.equal(g.body.summary.contracted, 9000);
  assert.equal(g.body.summary.balance, 6300);
});

test("sinal + parcelas com vencimento; marcar parcela como paga atualiza o saldo", async () => {
  const db = seed();
  await call("POST", "/reservations/cf0/payments", ADMIN(), { kind: "sinal", amount: 3000, method: "pix", paidAt: "2026-01-05" });
  const p1 = await call("POST", "/reservations/cf0/payments", ADMIN(), { kind: "parcela", amount: 3000, dueDate: "2030-11-24" });
  await call("POST", "/reservations/cf0/payments", ADMIN(), { kind: "parcela", amount: 3000, dueDate: "2030-12-20" });
  let g = (await call("GET", "/reservations/cf0/payments", ADMIN())).body.summary;
  assert.deepEqual([g.net, g.balance, g.scheduled], [3000, 6000, 6000]);
  const m = await call("PUT", `/payments/${p1.body.payment.id}`, ADMIN(), { paidAt: "2026-01-06", method: "transferencia" });
  assert.equal(m.status, 200);
  g = (await call("GET", "/reservations/cf0/payments", ADMIN())).body.summary;
  assert.deepEqual([g.net, g.balance, g.scheduled], [6000, 3000, 3000]);
  assert.equal(db.tables.payments.length, 3);
});

test("PUT valida o resultado final: marcar pago sem forma de pagamento → 400", async () => {
  seed();
  const p = await call("POST", "/reservations/cf0/payments", ADMIN(), { kind: "parcela", amount: 100, dueDate: "2030-11-24" });
  assert.equal((await call("PUT", `/payments/${p.body.payment.id}`, ADMIN(), { paidAt: "2026-01-06" })).status, 400);
  assert.equal((await call("PUT", "/payments/nao-existe", ADMIN(), { amount: 5 })).status, 404);
});

test("reserva do Airbnb/Booking: pagamentos recusados (a plataforma cuida)", async () => {
  seed();
  const r = await call("POST", "/reservations/air1/payments", ADMIN(), { kind: "pagamento", amount: 500, method: "pix", paidAt: "2026-01-05" });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /só para reservas diretas/);
});

test("funcionário não acessa pagamentos (403)", async () => {
  seed();
  assert.equal((await call("GET", "/reservations/cf0/payments", STAFF())).status, 403);
  assert.equal((await call("POST", "/reservations/cf0/payments", STAFF(), { kind: "sinal", amount: 1, method: "pix", paidAt: "2026-01-01" })).status, 403);
});

test("Financeiro: só o que foi RECEBIDO aparece como receita, no mês do pagamento; estorno como despesa", async () => {
  seed({ transactions: [{ id: "t1", type: "expense", category: "conta_fixa", description: "Luz", amount: 200, date: "2026-01-15", month: "2026-01" }] });
  await call("POST", "/reservations/cf0/payments", ADMIN(), { kind: "sinal", amount: 3000, method: "pix", paidAt: "2026-01-05" });
  await call("POST", "/reservations/cf0/payments", ADMIN(), { kind: "parcela", amount: 3000, dueDate: "2030-11-24" });
  await call("POST", "/reservations/cf0/payments", ADMIN(), { kind: "estorno", amount: 500, method: "pix", paidAt: "2026-02-03" });
  const jan = (await call("GET", "/transactions?month=2026-01", ADMIN())).body;
  const inc = jan.filter(t => t.type === "income");
  assert.equal(inc.length, 1, "parcela a vencer NÃO é receita");
  assert.equal(inc[0].amount, 3000);
  assert.equal(inc[0].readonly, true);
  assert.match(inc[0].description, /Sinal reserva Qto Casa Fechada/);
  assert.ok(jan.some(t => t.id === "t1"), "lançamentos comuns continuam");
  const feb = (await call("GET", "/transactions?month=2026-02", ADMIN())).body;
  assert.deepEqual(feb.map(t => [t.type, t.category, t.amount]), [["expense", "estorno_reserva", 500]]);
  const fevLimite = (await call("GET", "/transactions?month=2028-02", ADMIN())).status;
  assert.equal(fevLimite, 200, "fevereiro não gera data inválida");
});

test("A receber: parcelas não pagas com quarto do grupo, vencidas marcadas", async () => {
  seed();
  await call("POST", "/reservations/cf0/payments", ADMIN(), { kind: "parcela", amount: 1000, dueDate: "2020-01-01" });
  await call("POST", "/reservations/cf0/payments", ADMIN(), { kind: "parcela", amount: 2000, dueDate: "2099-01-01" });
  await call("POST", "/reservations/cf0/payments", ADMIN(), { kind: "sinal", amount: 500, method: "pix", paidAt: "2026-01-01" });
  const r = (await call("GET", "/payments/receivable", ADMIN())).body;
  assert.equal(r.length, 2);
  assert.deepEqual(r.map(p => [p.amount, p.overdue, p.group]), [[1000, true, "Casa Fechada"], [2000, false, "Casa Fechada"]]);
});

test("apagar reserva com pagamentos → 409 com orientação (banco recusa por FK)", async () => {
  const db = seed();
  const orig = db.from;
  db.from = (t) => { const q = orig(t); if (t === "reservations") q.delete = () => ({ eq() { return this; },
    then: (res) => Promise.resolve({ data: null, error: { code: "23503" } }).then(res) }); return q; };
  const r = await call("DELETE", "/reservations/cf0", ADMIN());
  assert.equal(r.status, 409);
  assert.match(r.body.error, /Cancele a reserva/);
});

test("F3: Casa Fechada criada pela rota de grupo guarda o valor só na 1ª linha", async () => {
  const db = seed({ reservations: [] });
  const rows = ["10","11","12","20","21","22","23","24","25"].map((roomId, i) =>
    ({ id: `n${i}`, roomId, guestName: "Grupo Teste", checkIn: "2031-01-10", checkOut: "2031-01-12", amount: 9000, source: "direto" }));
  assert.equal((await call("POST", "/reservations/group", ADMIN(), { rows })).status, 200);
  const amounts = db.tables.reservations.filter(r => r.id.startsWith("n")).map(r => [r.id, r.amount]);
  assert.deepEqual(amounts.filter(([, a]) => a > 0), [["n0", 9000]]);
});

test("sem a tabela payments (antes da migration): rotas respondem 503 e o Financeiro funciona como antes", async () => {
  const db = createFakeSupabase({ reservations: CF.map(r => ({ ...r })), transactions: [{ id: "t1", type: "income", category: "reserva_direta", description: "x", amount: 10, date: "2026-01-02", month: "2026-01" }] });
  const orig = db.from;
  db.from = (t) => { if (t !== "payments") return orig(t); const q = orig(t);
    q.select = () => ({ limit() { return this; }, eq() { return this; }, order() { return this; },
      then: (res) => Promise.resolve({ data: null, error: { code: "42P01", message: "relation \"public.payments\" does not exist" } }).then(res) });
    return q; };
  _setSupabaseForTests(db);
  assert.equal((await call("GET", "/payments/status", ADMIN())).body.enabled, false);
  assert.equal((await call("GET", "/reservations/cf0/payments", ADMIN())).status, 503);
  const tx = (await call("GET", "/transactions?month=2026-01", ADMIN())).body;
  assert.deepEqual(tx.map(t => t.id), ["t1"]);
});

// ── Tela ─────────────────────────────────────────────────────────────────────
const FORM = { "f-roomId": "20", "f-guestName": "Hóspede Teste", "f-checkIn": "2030-03-10", "f-checkOut": "2030-03-12",
  "f-source": "direto", "f-adults": "2", "f-children": "0", "f-phone": "", "f-notes": "", "f-amount": "800", "f-payment": "pix", "f-email": "" };

test("tela com pagamentos ativos: reserva nova NÃO lança receita e abre a reserva para registrar o sinal", async () => {
  const fe = loadFrontend({ fields: FORM, routes: [
    { method: "POST", path: "/reservations", reply: ({ body }) => ({ status: 200, json: { ok: true, reservation: { ...body } } }) },
  ] });
  fe.run(`authRole = "admin"; reservations = []; transactions = []; paymentsEnabled = true;
          var __opened = null; openEditModal = (id) => { __opened = id; };`);
  await fe.run("submitForm(null)");
  assert.equal(fe.calls.filter(c => c.method === "POST" && c.path === "/transactions").length, 0, "regra 6");
  assert.ok(fe.run("__opened"), "abre a reserva criada");
});

test("tela sem pagamentos (antes da migration): mantém o lançamento antigo", async () => {
  const fe = loadFrontend({ fields: FORM, routes: [
    { method: "POST", path: "/reservations", reply: ({ body }) => ({ status: 200, json: { ok: true, reservation: { ...body } } }) },
    { method: "POST", path: "/transactions", reply: ({ body }) => ({ status: 200, json: body }) },
  ] });
  fe.run(`authRole = "admin"; reservations = []; transactions = []; paymentsEnabled = false;`);
  await fe.run("submitForm(null)");
  assert.equal(fe.calls.filter(c => c.method === "POST" && c.path === "/transactions").length, 1);
});

test("tela: quadro de pagamentos mostra contratado, recebido, saldo e parcela vencida", () => {
  const fe = loadFrontend({});
  const html = fe.run(`renderPaymentsBox({ label: "Casa Fechada", summary: { contracted: 9000, received: 3000, refunded: 0, net: 3000, balance: 6000,
      scheduled: 6000, unscheduled: 0, overdue: ["p2"] },
    payments: [{ id: "p1", kind: "sinal", amount: 3000, paid_at: "2030-01-05", method: "pix" },
               { id: "p2", kind: "parcela", amount: 3000, due_date: "2000-01-01", paid_at: null }] }, "cf0")`);
  assert.match(html, /Contratado[\s\S]*9\.000,00/);
  assert.match(html, /Saldo[\s\S]*6\.000,00/);
  assert.match(html, /vencida/);
  assert.match(html, /Recebido hoje/);
});

test("tela: registrar parcela a receber envia vencimento (não data de pagamento)", async () => {
  const fe = loadFrontend({ fields: { "pay-kind": "parcela", "pay-amount": "1500", "pay-status": "vence", "pay-date": "2030-12-01", "pay-method": "pix", "pay-notes": "" },
    routes: [{ method: "POST", path: "/reservations/cf0/payments", reply: () => ({ status: 200, json: { ok: true } }) }] });
  fe.run(`loadPaymentsBox = async () => {};`);
  await fe.run(`addPayment("cf0")`);
  const post = fe.calls.find(c => c.method === "POST");
  assert.deepEqual([post.body.dueDate, post.body.paidAt, post.body.amount], ["2030-12-01", undefined, 1500]);
});

test("tela: linha de pagamento no Financeiro é somente leitura (abre a reserva, não o lançamento)", () => {
  const fe = loadFrontend({});
  fe.run(`reservations = [{ id: "cf0" }];`);
  const html = fe.run(`renderFinList("income", [{ id: "pay:p1", type: "income", category: "reserva_direta", description: "Sinal <b>x</b>", amount: 10, date: "2030-01-05", reservation_id: "cf0", readonly: true }])`);
  assert.match(html, /openEditModal\('cf0'\)/);
  assert.doesNotMatch(html, /openTransactionModal/);
  assert.doesNotMatch(html, /<b>x<\/b>/, "descrição escapada");
});

test("Financeiro sem filtro de mês: parcela a vencer continua fora da receita", async () => {
  seed();
  await call("POST", "/reservations/cf0/payments", ADMIN(), { kind: "parcela", amount: 3000, dueDate: "2030-11-24" });
  await call("POST", "/reservations/cf0/payments", ADMIN(), { kind: "sinal", amount: 1000, method: "pix", paidAt: "2026-01-05" });
  const all = (await call("GET", "/transactions", ADMIN())).body;
  assert.deepEqual(all.filter(t => t.readonly).map(t => t.amount), [1000]);
});

// ── Receita antiga no caixa (decisão 23/11/2026: só avisar) ──────────────────
test("rota: informa receita antiga do grupo (CF) para evitar contar duas vezes", async () => {
  seed({ transactions: [
    { id: "t1", type: "income", category: "reserva_direta", amount: 150.1, reservation_id: "cf3" },
    { id: "t2", type: "income", category: "reserva_direta", amount: 219.9, reservation_id: "cf0" },
    { id: "t3", type: "expense", category: "manutencao", amount: 50, reservation_id: "cf0" },
    { id: "t4", type: "income", category: "outros", amount: 999, reservation_id: "air1" },
  ] });
  const g = await call("GET", "/reservations/cf5/payments", ADMIN());
  assert.equal(g.status, 200);
  assert.deepEqual(g.body.legacyIncome, { count: 2, total: 370 });
  seed();
  assert.deepEqual((await call("GET", "/reservations/cf5/payments", ADMIN())).body.legacyIncome, { count: 0, total: 0 });
});

test("tela: aviso de receita antiga aparece só quando existe; falha de leitura também avisa", () => {
  const fe = loadFrontend({});
  const box = (li) => fe.run(`renderPaymentsBox(${JSON.stringify({ label: "20", summary: P.summarize(370, [], TODAY), payments: [], legacyIncome: li })}, "r1")`);
  assert.match(box({ count: 2, total: 370 }), /2 receitas lançadas[\s\S]*370,00[\s\S]*conta duas vezes/);
  assert.match(box({ count: 1, total: 100 }), /1 receita lançada/);
  assert.doesNotMatch(box({ count: 0, total: 0 }), /sistema antigo|Não foi possível conferir/);
  assert.match(box(null), /Não foi possível conferir/);
});
