// PMS-011: registrar sincronizações e mostrar o último sucesso. Dados e calendários fictícios.
"use strict";
process.env.JWT_SECRET = "segredo-so-de-teste";
process.env.SUPABASE_URL = "http://127.0.0.1:9";
process.env.SUPABASE_KEY = "chave-falsa";

const test = require("node:test");
const assert = require("node:assert/strict");
const jwt = require("jsonwebtoken");
const S = require("../lib/sync-status");
const { app, runSync, _setSupabaseForTests, _resetIcalStateForTests } = require("../server");
const { createFakeSupabase } = require("./helpers/fake-supabase");
const { loadFrontend } = require("./helpers/frontend-harness");

const T0 = "2030-01-10T12:00:00.000Z";
const ms = (iso) => Date.parse(iso);
const MIN = 60 * 1000;

// ── Unitários ────────────────────────────────────────────────────────────────
test("classifyError: categorias fixas, nunca a mensagem bruta", () => {
  assert.equal(S.classifyError(new Error("Timeout ao buscar iCal")), "tempo esgotado");
  assert.equal(S.classifyError(new Error("HTTP 404")), "HTTP 404");
  assert.equal(S.classifyError(new Error("Arquivo iCal excede limite de tamanho")), "arquivo grande demais");
  assert.equal(S.classifyError(new Error("falha ao ler reservas para reconciliar")), "falha ao ler o banco");
  assert.equal(S.classifyError(new Error("Muitos redirecionamentos")), "redirecionamentos demais");
  assert.equal(S.classifyError(new Error("Domínio não permitido")), "endereço não permitido");
  const secreto = "getaddrinfo ENOTFOUND www.airbnb.com/calendar/ical/123.ics?s=tokenSecreto";
  assert.equal(S.classifyError(new Error(secreto)), "falha de rede");
});

test("mergeStatus: falha mantém o último sucesso anterior; calendário removido sai do status", () => {
  const s1 = S.mergeStatus(null, { feeds: [{ key: "airbnb/21", ok: true, events: 3 }, { key: "booking/20", ok: true, events: 1 }] }, T0);
  assert.equal(s1.feeds["airbnb/21"].lastSuccessAt, T0);
  assert.equal(s1.lastRunOk, true);
  const T1 = "2030-01-10T12:15:00.000Z";
  const s2 = S.mergeStatus(s1, { feeds: [{ key: "airbnb/21", ok: false, problem: "HTTP 503" }] }, T1);
  assert.deepEqual(s2.feeds["airbnb/21"], { lastAttemptAt: T1, lastSuccessAt: T0, problem: "HTTP 503", events: 3 });
  assert.equal(s2.feeds["booking/20"], undefined, "não configurado mais");
  assert.equal(s2.lastRunOk, false);
});

test("computeHealth: em dia, com falha, atrasado e nunca rodou", () => {
  const ok = S.mergeStatus(null, { feeds: [{ key: "airbnb/21", ok: true }] }, T0);
  assert.equal(S.computeHealth(ok, ms(T0) + 10 * MIN).ok, true);

  const late = S.computeHealth(ok, ms(T0) + 61 * MIN);
  assert.equal(late.ok, false);
  assert.equal(late.runStale, true);
  assert.deepEqual(late.stale.map(s => s.feed), ["airbnb/21"]);

  const bad = S.mergeStatus(ok, { feeds: [{ key: "airbnb/21", ok: false, problem: "HTTP 404" }] }, T0);
  const h = S.computeHealth(bad, ms(T0) + 1 * MIN);
  assert.equal(h.ok, false);
  assert.deepEqual(h.failing, [{ feed: "airbnb/21", problem: "HTTP 404", lastSuccessAt: T0 }]);

  assert.equal(S.computeHealth(null, ms(T0)).neverRan, true);
});

// ── Integração: runSync grava o status em settings ──────────────────────────
const ics = (n = 1) => ["BEGIN:VCALENDAR", "VERSION:2.0",
  ...Array.from({ length: n }, (_, i) => ["BEGIN:VEVENT", `UID:u${i}`, "DTSTART;VALUE=DATE:20990201",
    "DTEND;VALUE=DATE:20990203", "SUMMARY:Reserved", "END:VEVENT"]).flat(),
  "END:VCALENDAR"].join("\n");
const FEED_URL_21 = "https://www.airbnb.com/calendar/ical/fake-21.ics?s=tokenFicticio";
function setupDb(extra = {}) {
  _resetIcalStateForTests();
  const db = createFakeSupabase({
    settings: [{ key: "ical_urls", value: { airbnb: { "21": FEED_URL_21 }, booking: { "20": "https://ical.booking.com/fake-20.ics" } } }],
    reservations: [],
    ...extra,
  });
  _setSupabaseForTests(db);
  return db;
}
const quiet = (fn) => async () => { const o = [console.log, console.warn, console.error];
  console.log = console.warn = console.error = () => {}; try { await fn(); } finally { [console.log, console.warn, console.error] = o; } };
const statusOf = (db) => (db.tables.settings.find(r => r.key === "ical_sync_status") || {}).value;

test("runSync grava sucesso por calendário, sem apagar as URLs configuradas", quiet(async () => {
  const db = setupDb();
  await runSync({ fetcher: async () => ics(2) });
  const st = statusOf(db);
  assert.ok(st, "status gravado");
  assert.equal(st.lastRunOk, true);
  assert.equal(st.feeds["airbnb/21"].problem, null);
  assert.equal(st.feeds["airbnb/21"].events, 2);
  assert.ok(st.feeds["booking/20"].lastSuccessAt);
  assert.ok(db.tables.settings.find(r => r.key === "ical_urls").value.airbnb["21"], "URLs continuam lá");
}));

test("calendário com erro: categoria registrada, último sucesso mantido, URL/token nunca gravados", quiet(async () => {
  const db = setupDb();
  await runSync({ fetcher: async () => ics(1) });
  const firstOk = statusOf(db).feeds["airbnb/21"].lastSuccessAt;
  await runSync({ fetcher: async (url) => {
    if (url.includes("airbnb")) throw new Error(`HTTP 503 em ${url}`);
    return ics(1);
  } });
  const st = statusOf(db);
  assert.equal(st.feeds["airbnb/21"].problem, "HTTP 503");
  assert.equal(st.feeds["airbnb/21"].lastSuccessAt, firstOk);
  assert.equal(st.feeds["booking/20"].problem, null);
  assert.equal(st.lastRunOk, false);
  assert.doesNotMatch(JSON.stringify(st), /tokenFicticio|fake-21|https?:/);
}));

test("resposta que não é iCal conta como falha do calendário", quiet(async () => {
  const db = setupDb();
  await runSync({ fetcher: async (url) => (url.includes("booking") ? "<html>login</html>" : ics(1)) });
  assert.equal(statusOf(db).feeds["booking/20"].problem, "resposta inválida");
}));

test("falha ao gravar reserva importada marca o calendário com problema", quiet(async () => {
  const db = setupDb({ reservations: [] });
  const insert = db.from;
  // Faz o INSERT de reservas falhar (ex.: constraint futura recusando sobreposição).
  db.from = (table) => {
    const q = insert(table);
    if (table !== "reservations") return q;
    const origInsert = q.insert;
    q.insert = () => ({ then: (res) => Promise.resolve({ data: null, error: { code: "23P01" } }).then(res) });
    return q;
  };
  _setSupabaseForTests(db);
  await runSync({ fetcher: async () => ics(1) });
  db.from = insert;
  assert.equal(statusOf(db).feeds["airbnb/21"].problem, "falha ao gravar");
}));

test("sem conseguir ler a lista de calendários: não grava status 'em dia'", quiet(async () => {
  const db = setupDb();
  const orig = db.from;
  db.from = (table) => {
    const q = orig(table);
    if (table === "settings") q.maybeSingle = () => ({ then: (res) => Promise.resolve({ data: null, error: { code: "XX000" } }).then(res) });
    return q;
  };
  _setSupabaseForTests(db);
  const r = await runSync({ fetcher: async () => ics(1) });
  db.from = orig;
  assert.equal(statusOf(db), undefined);
  assert.match(r.log.join("\n"), /Nada foi sincronizado/);
}));

// ── Rota GET /sync/status ───────────────────────────────────────────────────
const STAFF = "Bearer " + jwt.sign({ userId: "u2", role: "staff", username: "staff" }, process.env.JWT_SECRET, { algorithm: "HS256" });
let server, base;
test.before(async () => { server = app.listen(0); await new Promise(r => server.once("listening", r)); base = `http://127.0.0.1:${server.address().port}`; });
test.after(() => server.close());
const get = (auth) => fetch(base + "/sync/status", { headers: auth ? { Authorization: auth } : {} })
  .then(async r => ({ status: r.status, body: await r.json().catch(() => null) }));

test("GET /sync/status: funcionário vê a situação, sem URL; sem login → 401", quiet(async () => {
  setupDb();
  await runSync({ fetcher: async () => ics(1) });
  const r = await get(STAFF);
  assert.equal(r.status, 200);
  assert.equal(r.body.health.ok, true);
  assert.ok(r.body.feeds["airbnb/21"]);
  assert.doesNotMatch(JSON.stringify(r.body), /tokenFicticio|https?:/);
  assert.equal((await get(null)).status, 401);
}));

test("GET /sync/status sem nenhum registro: neverRan", async () => {
  setupDb();
  const r = await get(STAFF);
  assert.equal(r.status, 200);
  assert.equal(r.body.health.neverRan, true);
});

// ── Tela ─────────────────────────────────────────────────────────────────────
function screen(health) {
  const fe = loadFrontend({ routes: [
    { method: "GET", path: "/sync/status", reply: () => ({ status: 200, json: { health, syncing: false } }) },
  ] });
  return fe;
}

test("tela: calendários em dia → nenhum aviso", async () => {
  const fe = screen({ ok: true, lastRunAt: new Date().toISOString(), failing: [], stale: [] });
  await fe.run("refreshSyncStatus()");
  assert.equal(fe.run("syncWarning()"), null);
});

test("tela: calendário com falha aparece com nome legível e categoria", async () => {
  const fe = screen({ ok: false, lastRunAt: new Date().toISOString(), failing: [{ feed: "airbnb/CF", problem: "HTTP 404", lastSuccessAt: null }], stale: [{ feed: "airbnb/CF", lastSuccessAt: null }] });
  await fe.run("refreshSyncStatus()");
  const w = fe.run("syncWarning()");
  assert.match(w, /Airbnb Casa Fechada \(HTTP 404\)/);
  assert.doesNotMatch(w, /Sem atualizar: Airbnb Casa Fechada/, "não repete o mesmo calendário");
});

test("tela: servidor acordou e ainda não sincronizou → aviso de atraso", async () => {
  const old = new Date(Date.now() - 5 * 60 * MIN).toISOString();
  const fe = screen({ ok: false, runStale: true, lastRunAt: old, failing: [], stale: [] });
  await fe.run("refreshSyncStatus()");
  assert.match(fe.run("syncWarning()"), /sem atualizar desde/);
});

test("tela: falha ao consultar o status não apaga o último status conhecido", async () => {
  let n = 0;
  const fe = loadFrontend({ routes: [
    { method: "GET", path: "/sync/status", reply: () => (++n === 1
      ? { status: 200, json: { health: { ok: false, neverRan: true } } }
      : { status: 500, json: { error: "x" } }) },
  ] });
  await fe.run("refreshSyncStatus()");
  await fe.run("refreshSyncStatus()");
  assert.match(fe.run("syncWarning()"), /ainda não foram sincronizados/);
});
