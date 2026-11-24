// PMS-022: relatórios de ocupação e caixa — números reconciliáveis. Dados fictícios.
"use strict";
process.env.JWT_SECRET = "segredo-so-de-teste";
process.env.SUPABASE_URL = "http://127.0.0.1:9";
process.env.SUPABASE_KEY = "chave-falsa";

const test = require("node:test");
const assert = require("node:assert/strict");
const R = require("../lib/reports");
const { app, _setSupabaseForTests } = require("../server");
const { createFakeSupabase } = require("./helpers/fake-supabase");
const { ADMIN, STAFF } = require("./helpers/auth");
const { loadFrontend } = require("./helpers/frontend-harness");

const res = (id, room, ci, co, o = {}) => ({ id, room_id: room, check_in: ci, check_out: co, status: "confirmed", source: "direto", guest_name: "Hóspede Teste", ...o });

// ── Regras puras ─────────────────────────────────────────────────────────────
test("monthBounds: dias do mês, virada de ano e fevereiro bissexto", () => {
  assert.deepEqual(R.monthBounds("2030-12"), { start: "2030-12-01", next: "2031-01-01", days: 31 });
  assert.equal(R.monthBounds("2028-02").days, 29);
  assert.equal(R.monthBounds("2030-13"), null);
  assert.equal(R.monthBounds("abc"), null);
});

test("noites contadas só dentro do mês, intervalo [check_in, check_out)", () => {
  assert.deepEqual(R.nightsInRange("2030-02-27", "2030-03-02", "2030-03-01", "2030-04-01"), ["2030-03-01"]);
  assert.deepEqual(R.nightsInRange("2030-03-31", "2030-04-02", "2030-03-01", "2030-04-01"), ["2030-03-31"]);
  assert.deepEqual(R.nightsInRange("2030-03-10", "2030-03-10", "2030-03-01", "2030-04-01"), []);
});

test("ocupação: CF conta 9 quartos, 11+12 conta 2; canceladas, pending e bloqueios Airbnb não contam", () => {
  const CF = ["10","11","12","20","21","22","23","24","25"].map((r, i) => res(`cf${i}`, r, "2030-03-01", "2030-03-03", { notes: "[Casa toda:g]" }));
  const rows = [
    ...CF,                                                            // 9 quartos × 2 noites = 18
    res("s1", "11", "2030-03-10", "2030-03-12"), res("s2", "12", "2030-03-10", "2030-03-12"), // 11+12: 2 × 2 = 4
    res("c", "20", "2030-03-20", "2030-03-25", { status: "cancelled" }),
    res("p", "21", "2030-03-20", "2030-03-25", { status: "pending" }),
    res("b", "22", "2030-03-01", "2030-03-31", { source: "airbnb", guest_name: "Airbnb (Not available)" }),
    res("bk", "24", "2030-03-15", "2030-03-16", { source: "booking", guest_name: "CLOSED - Not available" }), // conta (Booking)
  ];
  const o = R.occupancy(rows, "2030-03");
  assert.equal(o.available, 9 * 31);
  assert.equal(o.occupied, 18 + 4 + 1);
  assert.deepEqual(o.channels, { direto: 22, airbnb: 0, booking: 1, outro: 0 });
  assert.equal(o.rooms["22"].occupied, 2, "só as 2 noites da CF");
  assert.equal(o.rooms["22"].blockedOnly, 28, "bloqueio Airbnb à parte, sem as noites com hóspede");
  assert.equal(o.rooms["20"].occupied, 2, "cancelada não conta");
  assert.equal(o.rooms["21"].occupied, 2, "pending não conta");
});

test("reconciliação: soma por quarto = total = soma por canal; noite em conflito conta 1 vez", () => {
  const rows = [
    res("a", "21", "2030-03-05", "2030-03-08", { source: "airbnb", guest_name: "Reserved" }),
    res("b", "21", "2030-03-07", "2030-03-09", { source: "booking", guest_name: "CLOSED - Not available" }),
    res("c", "10", "2030-03-30", "2030-04-03"),
  ];
  const o = R.occupancy(rows, "2030-03");
  const sumRooms = Object.values(o.rooms).reduce((s, r) => s + r.occupied, 0);
  const sumCh = Object.values(o.channels).reduce((s, v) => s + v, 0);
  assert.equal(o.occupied, 6);        // 21: 05,06,07,08 = 4 (07 em conflito, 1 vez) + 10: 30,31 = 2
  assert.equal(sumRooms, o.occupied);
  assert.equal(sumCh, o.occupied);
  assert.equal(o.conflicts, 1);
  assert.equal(o.rooms["21"].conflicts, 1);
  assert.ok(o.pct <= 100);
});

test("conflito do MESMO canal também é detectado (ex.: duas diretas na mesma noite)", () => {
  const o = R.occupancy([res("x", "23", "2030-03-01", "2030-03-04"), res("y", "23", "2030-03-03", "2030-03-05")], "2030-03");
  assert.equal(o.occupied, 4);
  assert.equal(o.conflicts, 1);
  assert.equal(o.channels.direto, 4);
});

test("caixa: recebido − estornos + outras receitas − despesas; a receber e vencidas", () => {
  const c = R.cash({
    paidInMonth: [{ kind: "sinal", amount: 3000 }, { kind: "parcela", amount: "1500.50" }, { kind: "estorno", amount: 200 }],
    dueInMonth: [{ kind: "parcela", amount: 1500 }],
    overdue: [{ kind: "parcela", amount: 700 }],
    transactions: [{ type: "income", amount: 100 }, { type: "expense", amount: 450.25 }],
  });
  assert.deepEqual([c.received, c.refunded, c.netReceived, c.otherIncome, c.expenses, c.result, c.receivableInMonth, c.overdueTotal],
                   [4500.5, 200, 4300.5, 100, 450.25, 3950.25, 1500, 700]);
});

// ── Rota ─────────────────────────────────────────────────────────────────────
let server, base;
test.before(async () => { server = app.listen(0); await new Promise(r => server.once("listening", r)); base = `http://127.0.0.1:${server.address().port}`; });
test.after(() => server.close());
const get = (p, auth) => fetch(base + p, { headers: { Authorization: auth } }).then(async r => ({ status: r.status, body: await r.json() }));

function seed() {
  const db = createFakeSupabase({
    reservations: [res("r1", "20", "2030-03-10", "2030-03-13"), res("r2", "21", "2030-02-25", "2030-03-02"),
                   res("fora", "20", "2030-04-05", "2030-04-06")],
    payments: [
      { id: "p1", reservation_id: "r1", kind: "sinal", amount: 300, paid_at: "2030-03-05", method: "pix" },
      { id: "p2", reservation_id: "r1", kind: "parcela", amount: 500, paid_at: null, due_date: "2030-03-20" },
      { id: "p3", reservation_id: "r1", kind: "pagamento", amount: 999, paid_at: "2030-02-01", method: "pix" },
    ],
    transactions: [{ id: "t1", type: "expense", category: "conta_fixa", description: "Luz", amount: 120, date: "2030-03-15", month: "2030-03" }],
  });
  _setSupabaseForTests(db);
}

test("GET /reports/monthly: ocupação e caixa do mês batem com as linhas do banco", async () => {
  seed();
  const r = await get("/reports/monthly?month=2030-03", ADMIN());
  assert.equal(r.status, 200);
  assert.equal(r.body.occupancy.occupied, 3 + 1, "r1: 10,11,12; r2: só 01/03");
  assert.equal(r.body.cash.received, 300, "pagamento de fevereiro não entra");
  assert.equal(r.body.cash.expenses, 120);
  assert.equal(r.body.cash.result, 180);
  assert.equal(r.body.cash.receivableInMonth, 500);
});

test("GET /reports/monthly: mês inválido 400; funcionário 403", async () => {
  seed();
  assert.equal((await get("/reports/monthly?month=2030-3", ADMIN())).status, 400);
  assert.equal((await get("/reports/monthly?month=2030-03", STAFF())).status, 403);
});

// ── Tela ─────────────────────────────────────────────────────────────────────
test("tela: relatório mostra ocupação, barras por quarto com tooltip e caixa", () => {
  const fe = loadFrontend({});
  fe.run(`authRole = "admin"; reportMonth = "2030-03"; reportData = ${JSON.stringify({
    month: "2030-03",
    occupancy: R.occupancy([res("r1", "20", "2030-03-10", "2030-03-13")], "2030-03"),
    cash: { ...R.cash({ paidInMonth: [{ kind: "sinal", amount: 300 }], transactions: [{ type: "expense", amount: 120 }] }), paymentsOn: true },
  })};`);
  const html = fe.run("renderRelatorios()");
  assert.match(html, /Ocupação[\s\S]*1,1%/);
  assert.match(html, /title="Quarto 20: 3 de 31 noites com hóspede/);
  assert.match(html, /= Resultado[\s\S]*180,00/);
  assert.match(html, /No Booking toda linha importada se chama "CLOSED"/);
});

test("tela: funcionário que estava em Relatórios ou Financeiro volta para o mapa", () => {
  const fe = loadFrontend({});
  for (const v of ["relatorios", "financeiro"]) {
    fe.run(`authRole = "staff"; currentView = "${v}"; applyRole();`);
    assert.equal(fe.run("currentView"), "map", v);
  }
  fe.run(`authRole = "admin"; currentView = "relatorios"; applyRole();`);
  assert.equal(fe.run("currentView"), "relatorios");
});
