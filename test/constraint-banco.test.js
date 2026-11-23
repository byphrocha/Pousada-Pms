// PMS-005 camada 2: quando o banco recusa sobreposição (23P01, constraint
// reservations_no_overlap), a API responde 409 ROOM_CONFLICT sem dados de outros
// hóspedes — nunca 500. O comportamento do Postgres foi ensaiado no staging
// (db/ENSAIO_CONSTRAINT_2026-11-23.md); aqui o Supabase falso simula a recusa.
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
const { ADMIN, STAFF } = require("./helpers/auth");

let server, base;
test.before(async () => { server = app.listen(0); await new Promise(r => server.once("listening", r)); base = `http://127.0.0.1:${server.address().port}`; });
test.after(() => server.close());
const quiet = (fn) => async () => { const o = console.warn; console.warn = () => {}; try { await fn(); } finally { console.warn = o; } };
const call = (method, p, auth, body) => fetch(base + p, { method, headers: { "Content-Type": "application/json", Authorization: auth },
  body: body ? JSON.stringify(body) : undefined }).then(async r => ({ status: r.status, body: await r.json().catch(() => null) }));

// Banco que recusa a escrita com 23P01 (como a constraint faria) — simula a corrida:
// a checagem do servidor viu o quarto livre, mas outro pedido gravou antes.
function dbRecusando(rows = [], op = "insert") {
  const db = createFakeSupabase({ reservations: rows });
  const orig = db.from;
  db.from = (table) => {
    const q = orig(table);
    if (table === "reservations") q[op] = () => ({
      select() { return this; }, single() { return this; }, eq() { return this; },
      then: (res) => Promise.resolve({ data: null, error: { code: "23P01", message: "conflicting key value violates exclusion constraint \"reservations_no_overlap\" ... (room_id, ...)=(20, [2030-03-10,2030-03-12))" } }).then(res),
    });
    return q;
  };
  _setSupabaseForTests(db);
  return db;
}
const OUTRO = { id: "o1", room_id: "23", guest_name: "Outro Hóspede", phone: "44999990000", check_in: "2030-03-11", check_out: "2030-03-13", status: "confirmed", source: "direto" };

test("POST: banco recusa por sobreposição → 409 ROOM_CONFLICT, sem detalhes do banco", quiet(async () => {
  dbRecusando();
  const r = await call("POST", "/reservations", STAFF(), { guestName: "Teste", roomId: "20", checkIn: "2030-03-10", checkOut: "2030-03-12" });
  assert.equal(r.status, 409);
  assert.equal(r.body.error.code, "ROOM_CONFLICT");
  assert.deepEqual(r.body.error.rooms, ["20"]);
  assert.doesNotMatch(JSON.stringify(r.body), /exclusion|constraint|2030-03-10,/);
}));

test("Casa Fechada: banco recusa → 409 apontando o quarto que colidiu, sem nome/telefone do outro", quiet(async () => {
  dbRecusando([OUTRO]);
  const rows = ["10","11","12","20","21","22","23","24","25"].map((roomId, i) =>
    ({ id: `c${i}`, roomId, guestName: "Grupo Teste", checkIn: "2030-03-10", checkOut: "2030-03-12" }));
  // modo off: a checagem do servidor não roda, só o banco barra (pior caso da corrida)
  const prev = process.env.AVAILABILITY_CHECK; process.env.AVAILABILITY_CHECK = "off";
  try {
    const r = await call("POST", "/reservations/group", ADMIN(), { rows });
    assert.equal(r.status, 409);
    assert.deepEqual(r.body.error.rooms, ["23"]);
    assert.doesNotMatch(JSON.stringify(r.body), /Outro Hóspede|44999990000|o1/);
  } finally { if (prev === undefined) delete process.env.AVAILABILITY_CHECK; else process.env.AVAILABILITY_CHECK = prev; }
}));

test("PUT: mudar datas para cima de outra reserva e o banco recusar → 409", quiet(async () => {
  dbRecusando([{ id: "m1", room_id: "20", guest_name: "Teste", check_in: "2030-04-01", check_out: "2030-04-03", status: "confirmed" }], "update");
  const prev = process.env.AVAILABILITY_CHECK; process.env.AVAILABILITY_CHECK = "off";
  try {
    const r = await call("PUT", "/reservations/m1", STAFF(), { checkIn: "2030-03-10", checkOut: "2030-03-12" });
    assert.equal(r.status, 409);
    assert.deepEqual(r.body.error.rooms, ["20"]);
  } finally { if (prev === undefined) delete process.env.AVAILABILITY_CHECK; else process.env.AVAILABILITY_CHECK = prev; }
}));

test("outros erros do banco continuam 500 (não viram conflito falso)", quiet(async () => {
  const db = createFakeSupabase({ reservations: [] });
  const orig = db.from;
  db.from = (t) => { const q = orig(t); if (t === "reservations") q.insert = () => ({ select() { return this; }, single() { return this; },
    then: (res) => Promise.resolve({ data: null, error: { code: "XX000", message: "x" } }).then(res) }); return q; };
  _setSupabaseForTests(db);
  const r = await call("POST", "/reservations", STAFF(), { guestName: "Teste", roomId: "20", checkIn: "2030-03-10", checkOut: "2030-03-12" });
  assert.equal(r.status, 500);
}));

test("migration e rollback existem, e a regra de bloqueio do Airbnb no SQL é a mesma do código", () => {
  const dir = path.join(__dirname, "..", "db", "migrations");
  const up = fs.readFileSync(path.join(dir, "20261123_01_reservations_no_overlap.sql"), "utf8");
  const down = fs.readFileSync(path.join(dir, "20261123_01_reservations_no_overlap.down.sql"), "utf8");
  assert.match(down, /drop constraint if exists reservations_no_overlap/);
  assert.match(up, /daterange\(check_in, check_out, '\[\)'\)/, "intervalo [check_in, check_out)");
  // Se alguém mudar os padrões em lib/availability.js, o SQL precisa mudar junto.
  const lib = fs.readFileSync(path.join(__dirname, "..", "lib", "availability.js"), "utf8");
  const libList = [...lib.match(/AIRBNB_BLOCK_PATTERNS = Object\.freeze\(\[([^\]]+)\]/)[1].matchAll(/\/([^/]+)\/i/g)].map(m => m[1]).sort();
  for (const m of up.matchAll(/guest_name ~\* '\(([^)]+)\)'/g)) assert.deepEqual(m[1].split("|").sort(), libList);
});
