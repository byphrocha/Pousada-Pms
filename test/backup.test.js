// Backup pela PMS: arquivo completo ou nenhum; registro da data; restauração em
// SQL (tudo ou nada, recusa banco com dados). Supabase simulado; dados fictícios.
"use strict";
process.env.JWT_SECRET = "segredo-so-de-teste";
process.env.SUPABASE_URL = "http://127.0.0.1:9";
process.env.SUPABASE_KEY = "chave-falsa";

const test = require("node:test");
const assert = require("node:assert/strict");
const bk = require("../lib/backup");
const { app, _setSupabaseForTests } = require("../server");
const { createFakeSupabase } = require("./helpers/fake-supabase");
const { TEST_USERS, ADMIN, STAFF } = require("./helpers/auth");

let server, base;
test.before(async () => { server = app.listen(0); await new Promise(r => server.once("listening", r)); base = `http://127.0.0.1:${server.address().port}`; });
test.after(() => server.close());
const quiet = (fn) => async () => { const o = [console.log, console.warn, console.error];
  console.log = console.warn = console.error = () => {}; try { await fn(); } finally { [console.log, console.warn, console.error] = o; } };
const get = (p, auth) => fetch(base + p, { headers: auth ? { Authorization: auth } : {} })
  .then(async r => ({ status: r.status, headers: r.headers, body: await r.json().catch(() => null) }));

function seed() {
  const db = createFakeSupabase({
    users: TEST_USERS.map(u => ({ ...u })),
    reservations: [{ id: "r1", room_id: "20", guest_name: "Hóspede Teste", check_in: "2030-03-10", check_out: "2030-03-12", status: "confirmed" }],
    guests: [{ id: "g1", name: "Hóspede Teste", phone: "TEL-FICTICIO" }],
    transactions: [], prereservations: [],
    settings: [{ key: "ical_urls", value: { airbnb: {}, booking: {} } }],
    payments: [{ id: "p1", reservation_id: "r1", kind: "sinal", amount: 50, method: "pix", paid_at: "2030-03-01" }],
    audit_log: [{ id: 1, action: "create", entity: "reservation" }],
  });
  _setSupabaseForTests(db);
  return db;
}
// Falha simulada na leitura de uma tabela.
function failOn(db, table, error) {
  const from = db.from;
  db.from = (t) => { const q = from(t); if (t !== table) return q;
    const sel = q.select; q.select = (...a) => { const r = sel(...a); r.order = () => r; r.range = async () => ({ data: null, error }); return r; }; return q; };
}

// ── lib ──────────────────────────────────────────────────────────────────────
test("buildBackup: todas as tabelas, contagens; tabela opcional ausente fica registrada", async () => {
  const data = { users: [{ id: "u" }], guests: [], reservations: [{ id: "r" }], prereservations: [], transactions: [], settings: [], payments: [] };
  const b = await bk.buildBackup(async (n) => n === "audit_log" ? { data: null, error: { code: "42P01" } } : { data: data[n], error: null },
    { now: new Date("2030-01-01T00:00:00Z") });
  assert.equal(b.format, "pms-backup");
  assert.equal(b.createdAt, "2030-01-01T00:00:00.000Z");
  assert.deepEqual(b.absent, ["audit_log"]);
  assert.equal(b.counts.reservations, 1);
  assert.deepEqual(bk.validateBackup(b), []);
});

test("buildBackup: erro em tabela obrigatória, ou erro que não é 'não existe', aborta", async () => {
  await assert.rejects(bk.buildBackup(async (n) => n === "reservations" ? { data: null, error: { code: "42P01" } } : { data: [], error: null }), /reservations/);
  await assert.rejects(bk.buildBackup(async (n) => n === "payments" ? { data: null, error: { code: "57014", message: "timeout" } } : { data: [], error: null }), /payments/);
});

test("validateBackup: arquivo errado, versão, tabela faltando e contagem não batendo", () => {
  assert.match(bk.validateBackup({ format: "outro" }).join(), /não é um backup/);
  assert.match(bk.validateBackup({ format: "pms-backup", version: 9 }).join(), /versão 9/);
  const ok = { format: "pms-backup", version: 1, counts: {}, absent: [], tables: {} };
  for (const t of bk.TABLES) { ok.tables[t.name] = []; ok.counts[t.name] = 0; }
  assert.deepEqual(bk.validateBackup(ok), []);
  const sem = JSON.parse(JSON.stringify(ok)); delete sem.tables.payments;
  assert.match(bk.validateBackup(sem).join(), /falta a tabela payments/);
  const cortado = JSON.parse(JSON.stringify(ok)); cortado.counts.reservations = 5;
  assert.match(bk.validateBackup(cortado).join(), /reservations: 0 linhas, esperado 5/);
});

test("restoreSql: uma transação, recusa banco com dados, identidade da auditoria e escape do delimitador", () => {
  const b = { format: "pms-backup", version: 1, createdAt: "x", counts: {}, absent: [], tables: {} };
  for (const t of bk.TABLES) { b.tables[t.name] = []; b.counts[t.name] = 0; }
  b.tables.guests = [{ id: "g", name: "tem $pms$ no meio" }]; b.counts.guests = 1;
  b.tables.audit_log = [{ id: 7, action: "a", entity: "e" }]; b.counts.audit_log = 1;
  const sql = bk.restoreSql(b);
  assert.match(sql, /^-- .*\nbegin;/);
  assert.match(sql, /commit;\n$/);
  assert.equal((sql.match(/não está vazia/g) || []).length, bk.TABLES.length);
  assert.match(sql, /insert into public\.audit_log overriding system value/);
  assert.match(sql, /setval\(pg_get_serial_sequence\('public\.audit_log', 'id'\)/);
  assert.match(sql, /\$pms0\$\[\{"id":"g","name":"tem \$pms\$ no meio"\}\]\$pms0\$/);
  assert.doesNotMatch(sql, /insert into public\.users/, "tabela vazia não gera insert");
  assert.throws(() => bk.restoreSql({ format: "x" }), /Backup inválido/);
});

// ── rotas ────────────────────────────────────────────────────────────────────
test("GET /admin/backup: arquivo completo, sem cache, registra a data e a auditoria", quiet(async () => {
  const db = seed();
  const r = await get("/admin/backup", ADMIN());
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("cache-control"), "no-store");
  assert.match(r.headers.get("content-disposition"), /attachment; filename="pms-backup-\d{4}-\d{2}-\d{2}\.json"/);
  assert.deepEqual(bk.validateBackup(r.body), []);
  assert.equal(r.body.counts.payments, 1);
  assert.equal(r.body.tables.guests[0].phone, "TEL-FICTICIO");
  const mark = db.tables.settings.find(s => s.key === "last_backup").value;
  assert.equal(mark.at, r.body.createdAt);
  assert.equal(mark.counts.reservations, 1);
  assert.doesNotMatch(JSON.stringify(mark), /Hóspede|TEL-FICTICIO/, "registro só com data e contagens");
  assert.ok(db.tables.audit_log.some(a => a.action === "backup"));
  const st = await get("/admin/backup/status", ADMIN());
  assert.deepEqual([st.status, st.body.lastAt], [200, r.body.createdAt]);
}));

test("GET /admin/backup: uma tabela falhando → 503 e nenhum registro de backup feito", quiet(async () => {
  const db = seed();
  failOn(db, "payments", { code: "57014", message: "canceling statement due to statement timeout" });
  const r = await get("/admin/backup", ADMIN());
  assert.equal(r.status, 503);
  assert.doesNotMatch(JSON.stringify(r.body), /Hóspede|timeout/);
  assert.equal(db.tables.settings.find(s => s.key === "last_backup"), undefined);
}));

test("GET /admin/backup: funcionário e sem login não baixam", quiet(async () => {
  seed();
  assert.equal((await get("/admin/backup", STAFF())).status, 403);
  assert.equal((await get("/admin/backup")).status, 401);
}));

test("status sem backup nenhum: lastAt nulo", quiet(async () => {
  seed();
  const st = await get("/admin/backup/status", ADMIN());
  assert.deepEqual([st.status, st.body.lastAt], [200, null]);
}));

// ── tela ─────────────────────────────────────────────────────────────────────
const { loadFrontend } = require("./helpers/frontend-harness");
const dias = (n) => new Date(Date.now() - n * 86400000).toISOString();
async function telaCom(reply) {
  const fe = loadFrontend({ routes: [{ method: "GET", path: "/admin/backup/status", reply }] });
  fe.run(`authRole = "admin"`);
  await fe.run("loadBackupStatus()");
  return fe;
}

test("tela: backup recente mostra a data, sem aviso; atrasado (7+ dias) ou nunca, pede para fazer", async () => {
  let fe = await telaCom(() => ({ status: 200, json: { lastAt: dias(2) } }));
  let h = fe.run("backupCardHtml()");
  assert.match(h, /Último backup: .* \(há 2 dias\)\./);
  assert.doesNotMatch(h, /Faça um agora/);
  fe = await telaCom(() => ({ status: 200, json: { lastAt: dias(7) } }));
  assert.match(fe.run("backupCardHtml()"), /há 7 dias\)\. Faça um agora\./);
  fe = await telaCom(() => ({ status: 200, json: { lastAt: null } }));
  assert.match(fe.run("backupCardHtml()"), /Nenhum backup feito pela PMS ainda\. Faça um agora\./);
});

test("tela: erro ao consultar aparece como erro (não como 'nenhum backup')", async () => {
  const fe = await telaCom(() => ({ status: 503, json: { error: "Não foi possível ler a data do último backup." } }));
  const h = fe.run("backupCardHtml()");
  assert.match(h, /Não foi possível consultar/);
  assert.doesNotMatch(h, /Nenhum backup feito/);
});

test("tela: cartão só para admin, no topo de Alertas, com aviso de guardar em lugar privado", async () => {
  const fe = await telaCom(() => ({ status: 200, json: { lastAt: dias(1) } }));
  fe.run(`reservations = []; prereservations = [];`);
  const h = fe.run("renderAlertas()");
  assert.ok(h.indexOf("💾 Backup do banco") >= 0 && h.indexOf("💾 Backup do banco") < h.indexOf("Nenhum conflito"));
  assert.match(h, /ontem/);
  assert.match(h, /guarde fora do celular, em lugar privado/);
  fe.run(`authRole = "staff"`);
  assert.doesNotMatch(fe.run("renderAlertas()"), /Backup do banco/);
});

test("tela: backup com erro não baixa nada e avisa o motivo", async () => {
  const fe = loadFrontend({ routes: [{ method: "GET", path: "/admin/backup", reply: () => ({ status: 503, json: { error: "Não foi possível ler todas as tabelas; nenhum arquivo foi gerado." } }) }] });
  let baixou = false;
  fe.context.URL = { createObjectURL: () => { baixou = true; return "blob:x"; }, revokeObjectURL() {} };
  fe.context.Blob = function () {};
  await fe.run("downloadBackup()");
  assert.equal(baixou, false);
  assert.match(fe.alerts.join(), /Backup não gerado: Não foi possível ler todas as tabelas/);
});

test("tela: backup bom vira arquivo pms-backup-AAAA-MM-DD.json e atualiza a data", async () => {
  const b = { format: "pms-backup", version: 1, createdAt: "2030-01-05T10:00:00.000Z", counts: {}, tables: {} };
  const fe = loadFrontend({ routes: [
    { method: "GET", path: "/admin/backup", reply: () => ({ status: 200, json: b }) },
    { method: "GET", path: "/admin/backup/status", reply: () => ({ status: 200, json: { lastAt: b.createdAt } }) }] });
  const a = { click() { a.clicked = true; }, remove() {} };
  let conteudo = null;
  fe.context.Blob = function (parts) { conteudo = parts.join(""); };
  fe.context.URL = { createObjectURL: () => "blob:x", revokeObjectURL() {} };
  const doc = fe.context.document;
  fe.context.document = new Proxy({}, { get: (_t, k) => k === "createElement" ? () => a : k === "body" ? { appendChild() {} } : doc[k] });
  await fe.run("downloadBackup()");
  assert.equal(a.download, "pms-backup-2030-01-05.json");
  assert.equal(a.clicked, true);
  assert.equal(JSON.parse(conteudo).format, "pms-backup");
  assert.equal(fe.run("backupStatus.lastAt"), b.createdAt);
});
