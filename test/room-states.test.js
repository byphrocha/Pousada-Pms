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

// ── PMS-013: desfazer marcação feita por engano ──────────────────────────────
test("desfazer tira só aquela marcação; as outras ficam", async () => {
  const db = seed({ cleaned: ["20", "22"], checkedIn: ["24"] });
  const r = await call("DELETE", "/room-states/22/cleaned");
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.cleaned, ["20"]);
  assert.deepEqual(r.body.checkedIn, ["24"]);
  assert.deepEqual(db.tables.settings[0].value, { cleaned: ["20"], checkedIn: ["24"] });
});

test("desfazer e marcar outro quarto ao mesmo tempo: nenhuma operação apaga a outra", async () => {
  seed({ cleaned: ["20", "21"], checkedIn: [] }, { delayMs: 15 });
  await Promise.all([call("DELETE", "/room-states/20/cleaned"), call("POST", "/room-states/25/cleaned"), call("POST", "/room-states/23/checkedIn")]);
  const r = await call("GET", "/room-states");
  assert.deepEqual(r.body.cleaned, ["21", "25"]);
  assert.deepEqual(r.body.checkedIn, ["23"]);
});

test("desfazer: quarto ou tipo inválido → 400 e nada gravado", async () => {
  const db = seed({ cleaned: ["20"], checkedIn: [] });
  for (const p of ["/room-states/13/cleaned", "/room-states/20/limpo"])
    assert.equal((await call("DELETE", p)).status, 400, p);
  assert.ok(!db.log.some(l => l.op === "upsert"));
});

test("banco fora: rotas de quartos respondem 503 com mensagem (antes ficavam penduradas)", { timeout: 5000 }, async () => {
  const quiet = console.error; console.error = () => {};
  try {
    seed(null, { failSelect: true });
    for (const [m, p] of [["GET", "/room-states"], ["POST", "/room-states/20/cleaned"], ["DELETE", "/room-states/20/cleaned"]]) {
      const r = await call(m, p);
      assert.equal(r.status, 503, `${m} ${p}`);
      assert.match(r.body.error, /Tente de novo/);
    }
  } finally { console.error = quiet; }
});

test("tela: link de desfazer só quando há marcação de hoje que dá para desfazer", () => {
  const fe = loadFrontend({});
  fe.run(`reservations = [
    { id: "a", roomId: "24", checkIn: todayStr(), checkOut: "2099-01-01", status: "confirmed", guestName: "Hóspede Teste", source: "direto" },
    { id: "b", roomId: "20", checkIn: "2000-01-01", checkOut: todayStr(), status: "confirmed", guestName: "Hóspede Teste", source: "direto" },
    { id: "c", roomId: "21", checkIn: "2000-01-01", checkOut: "2099-01-01", status: "confirmed", guestName: "Hóspede Teste", source: "direto" }];
    checkedInRooms = new Set(["24", "21"]); cleanedRooms = new Set(["20", "22"]);`);
  assert.equal(fe.run(`undoableMark("24")`), "checkedIn");
  assert.equal(fe.run(`undoableMark("20")`), "cleaned");
  assert.equal(fe.run(`undoableMark("21")`), null, "sem check-in hoje: nada a desfazer");
  assert.equal(fe.run(`undoableMark("22")`), null, "sem saída hoje: nada a desfazer");
  const card = (id, cf) => fe.run(`roomCardHtml(ROOMS.find(r => r.id === "${id}"), getRoomStatus("${id}"), getRoomRes("${id}"), ${cf})`);
  assert.match(card("24", false), /unmarkRoomState\('24','checkedIn',event\)">↩ Desfazer check-in/);
  assert.match(card("20", false), /↩ Desfazer limpeza/);
  assert.doesNotMatch(card("21", false), /Desfazer/);
  assert.doesNotMatch(card("24", true), /Desfazer/, "Casa Fechada: sem ações por quarto");
});

test("tela: desfazer pede confirmação e atualiza com o que o servidor devolveu; erro aparece", async () => {
  const fe = loadFrontend({ routes: [{ method: "DELETE", path: "/room-states/24/checkedIn", reply: () => ({ status: 200, json: { ok: true, cleaned: [], checkedIn: ["21"] } }) }] });
  fe.run(`authToken = "t"; checkedInRooms = new Set(["24", "21"]); confirm = () => false;`);
  await fe.run(`unmarkRoomState("24", "checkedIn")`);
  assert.equal(fe.calls.filter(c => c.method === "DELETE").length, 0, "cancelou na confirmação: nada enviado");
  fe.run(`confirm = () => true;`);
  await fe.run(`unmarkRoomState("24", "checkedIn")`);
  assert.deepEqual(JSON.parse(fe.run(`JSON.stringify([...checkedInRooms])`)), ["21"]);
  const fe2 = loadFrontend({ routes: [{ method: "DELETE", path: "/room-states/24/checkedIn", reply: () => ({ status: 503, json: { error: "Tente de novo." } }) }] });
  fe2.run(`authToken = "t"; confirm = () => true; var alerts = []; alert = (m) => alerts.push(m);`);
  await fe2.run(`unmarkRoomState("24", "checkedIn")`);
  assert.match(fe2.run(`alerts.join("|")`), /Não foi possível desfazer a marcação do quarto 24/);
});
