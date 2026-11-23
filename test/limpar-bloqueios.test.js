// "Limpar bloqueios": só cancela bloqueios do Airbnb já encerrados; nunca apaga. Dados fictícios.
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
const call = (auth) => fetch(base + "/cleanup-blocked", { method: "POST", headers: { Authorization: auth } })
  .then(async r => ({ status: r.status, body: await r.json() }));

const row = (id, o) => ({ id, room_id: "21", check_in: "2020-01-01", check_out: "2020-01-05", status: "confirmed", source: "airbnb", guest_name: "Airbnb (Not available)", ...o });
function seed(rows, opts) { const db = createFakeSupabase({ reservations: rows, audit_log: [] }, opts); _setSupabaseForTests(db); return db; }

test("cancela só bloqueios do Airbnb já encerrados; nada é apagado", async () => {
  const db = seed([
    row("velho"),
    row("futuro", { check_in: "2099-01-01", check_out: "2099-02-01" }),
    row("reserva-real", { guest_name: "Reserved" }),
    row("booking-closed", { source: "booking", guest_name: "CLOSED - Not available" }),
    row("ja-cancelado", { status: "cancelled" }),
  ]);
  const r = await call(ADMIN());
  assert.equal(r.status, 200);
  assert.deepEqual([r.body.cancelled, r.body.deleted], [1, 0]);
  assert.equal(db.tables.reservations.length, 5, "nenhuma linha apagada");
  const st = Object.fromEntries(db.tables.reservations.map(x => [x.id, x.status]));
  assert.deepEqual(st, { velho: "cancelled", futuro: "confirmed", "reserva-real": "confirmed", "booking-closed": "confirmed", "ja-cancelado": "cancelled" });
  assert.equal(db.log.filter(l => l.op === "delete").length, 0);
  assert.deepEqual(db.tables.audit_log.map(a => [a.action, a.changes.cancelados]), [["bloqueios.limpar", 1]]);
});

test("mais de 1.000 bloqueios antigos: todos são arquivados (paginação + lotes)", async () => {
  const rows = Array.from({ length: 1305 }, (_, i) => row(`b${String(i).padStart(5, "0")}`));
  const db = seed(rows, { maxRows: 1000 });
  const r = await call(ADMIN());
  assert.equal(r.body.cancelled, 1305);
  assert.equal(db.tables.reservations.filter(x => x.status === "cancelled").length, 1305);
});

test("funcionário não pode (403)", async () => {
  seed([row("velho")]);
  assert.equal((await call(STAFF())).status, 403);
});

test("tela: salvar URLs com erro do servidor não mostra 'sucesso'", async () => {
  const fe = loadFrontend({ routes: [{ method: "POST", path: "/urls", reply: () => ({ status: 500, json: { error: "falha" } }) }] });
  await fe.run("saveUrls()");
  assert.match(fe.alerts.join("\n"), /Não foi possível salvar/);
  assert.doesNotMatch(fe.alerts.join("\n"), /sucesso/);
});
