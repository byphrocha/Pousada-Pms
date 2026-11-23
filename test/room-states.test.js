// P1.4: marcações de limpeza/check-in de aparelhos diferentes não se apagam. Dados fictícios.
"use strict";
process.env.JWT_SECRET = "segredo-so-de-teste";
process.env.SUPABASE_URL = "http://127.0.0.1:9";
process.env.SUPABASE_KEY = "chave-falsa";

const test = require("node:test");
const assert = require("node:assert/strict");
const jwt = require("jsonwebtoken");
const { app, _setSupabaseForTests } = require("../server");
const { createFakeSupabase } = require("./helpers/fake-supabase");
const { loadFrontend } = require("./helpers/frontend-harness");

const AUTH = require("./helpers/auth").STAFF();
let server, base;
test.before(async () => { server = app.listen(0); await new Promise(r => server.once("listening", r)); base = `http://127.0.0.1:${server.address().port}`; });
test.after(() => server.close());
const call = (m, p, body) => fetch(base + p, { method: m, headers: { "Content-Type": "application/json", Authorization: AUTH }, body: body ? JSON.stringify(body) : undefined })
  .then(async r => ({ status: r.status, body: await r.json() }));
const seed = (value, opts) => { const db = createFakeSupabase({ settings: value ? [{ key: currentKey(), value }] : [] }, opts); _setSupabaseForTests(db); return db; };
function currentKey() { const d = new Date(Date.now() - 3 * 3600 * 1000); return "room_states_" + d.toISOString().slice(0, 10); }

test("dois aparelhos marcando ao mesmo tempo: as duas marcações ficam", async () => {
  seed(null, { delayMs: 15 });
  await Promise.all([
    call("POST", "/room-states/20/cleaned"),
    call("POST", "/room-states/22/cleaned"),
    call("POST", "/room-states/24/checkedIn"),
  ]);
  const r = await call("GET", "/room-states");
  assert.deepEqual(r.body.cleaned, ["20", "22"]);
  assert.deepEqual(r.body.checkedIn, ["24"]);
});

test("aparelho com tela antiga (lista desatualizada) não apaga marcações dos outros", async () => {
  seed({ cleaned: ["20", "21"], checkedIn: ["24"] });
  await call("POST", "/room-states", { cleaned: ["25"], checkedIn: [] });
  const r = await call("GET", "/room-states");
  assert.deepEqual(r.body.cleaned, ["20", "21", "25"]);
  assert.deepEqual(r.body.checkedIn, ["24"]);
});

test("quarto ou tipo inválido → 400 e nada gravado", async () => {
  const db = seed(null);
  for (const p of ["/room-states/13/cleaned", "/room-states/CF/cleaned", "/room-states/20/limpo"])
    assert.equal((await call("POST", p)).status, 400, p);
  assert.equal(db.tables.settings.length, 0);
});

test("rota antiga ignora quartos desconhecidos", async () => {
  seed(null);
  await call("POST", "/room-states", { cleaned: ["20", "99", "CF"], checkedIn: "x" });
  assert.deepEqual((await call("GET", "/room-states")).body, { cleaned: ["20"], checkedIn: [] });
});

test("tela: marcar limpeza chama a rota do quarto e usa o estado devolvido", async () => {
  const fe = loadFrontend({ routes: [
    { method: "POST", path: "/room-states/22/cleaned", reply: () => ({ status: 200, json: { ok: true, cleaned: ["20", "22"], checkedIn: [] } }) },
  ]});
  await fe.run(`markClean("22")`);
  assert.equal(fe.calls.filter(c => c.path === "/room-states").length, 0, "não regrava a lista inteira");
  assert.equal(fe.run(`cleanedRooms.has("20") && cleanedRooms.has("22")`), true, "recebe a marcação de outro aparelho");
});

test("tela: falha ao salvar avisa e recarrega o estado real", async () => {
  const fe = loadFrontend({ routes: [
    { method: "POST", path: "/room-states/22/checkedIn", reply: () => ({ status: 500, json: { error: "Erro interno" } }) },
    { method: "GET", path: "/room-states", reply: () => ({ status: 200, json: { cleaned: [], checkedIn: [] } }) },
  ]});
  await fe.run(`markCheckedIn("22")`);
  assert.match(fe.alerts.join("\n"), /Não foi possível salvar/);
  assert.equal(fe.run(`checkedInRooms.has("22")`), false, "não finge que salvou");
});

test("tela: falha no 1º carregamento dos estados não quebra a tela (cleanedRooms declarada)", async () => {
  const fe = loadFrontend({ routes: [
    { method: "GET", path: "/reservations", reply: () => ({ status: 200, json: [] }) },
    { method: "GET", path: "/guests", reply: () => ({ status: 200, json: [] }) },
    { method: "GET", path: "/room-states", reply: () => ({ status: 500, json: { error: "Erro interno" } }) },
  ], keep: ["loadAll"] });
  fe.run(`authRole = "staff";`);
  await fe.run("loadAll()");
  assert.equal(fe.run(`getRoomStatus("20")`), "free");
});
