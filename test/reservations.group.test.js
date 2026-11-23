// POST /reservations/group — CF e 11+12 gravados de forma atômica (regra 5, PMS-005).
// Supabase simulado; dados fictícios.
"use strict";
process.env.JWT_SECRET = "segredo-so-de-teste";
process.env.SUPABASE_URL = "http://127.0.0.1:9";
process.env.SUPABASE_KEY = "chave-falsa";

const test = require("node:test");
const assert = require("node:assert/strict");
const jwt = require("jsonwebtoken");
const { app, _setSupabaseForTests } = require("../server");
const { createFakeSupabase } = require("./helpers/fake-supabase");

const STAFF = "Bearer " + jwt.sign({ userId: "u2", role: "staff", username: "staff" }, process.env.JWT_SECRET, { algorithm: "HS256" });

let server, base;
test.before(async () => {
  server = app.listen(0);
  await new Promise(r => server.once("listening", r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server.close());

function seed(rows = [], opts) {
  const db = createFakeSupabase({ reservations: rows }, opts);
  _setSupabaseForTests(db);
  return db;
}
function call(body, auth = STAFF) {
  return fetch(base + "/reservations/group", {
    method: "POST", headers: { "Content-Type": "application/json", ...(auth ? { Authorization: auth } : {}) },
    body: JSON.stringify(body),
  }).then(async r => ({ status: r.status, body: await r.json().catch(() => null) }));
}
function withMode(mode, fn) {
  return async () => {
    const prev = process.env.AVAILABILITY_CHECK;
    process.env.AVAILABILITY_CHECK = mode;
    try { await fn(); } finally {
      if (prev === undefined) delete process.env.AVAILABILITY_CHECK; else process.env.AVAILABILITY_CHECK = prev;
    }
  };
}

const ALL = ["10", "11", "12", "20", "21", "22", "23", "24", "25"];
const base_ = { guestName: "Grupo Teste", checkIn: "2030-06-10", checkOut: "2030-06-12", source: "direto", status: "confirmed" };
const rowsFor = (rooms, extra = {}) => rooms.map((roomId, i) => ({ ...base_, id: `g${i}${roomId}`, roomId, notes: " [Casa toda:gx]", ...extra }));
const OTHER = { id: "o1", room_id: "23", guest_name: "Outro Teste", phone: "0000", check_in: "2030-06-11", check_out: "2030-06-13", status: "confirmed" };

test("CF: grava as 9 linhas numa única operação de insert", async () => {
  const db = seed();
  const r = await call({ rows: rowsFor(ALL) });
  assert.equal(r.status, 200);
  assert.equal(r.body.product, "CF");
  assert.equal(db.tables.reservations.length, 9);
  const inserts = db.log.filter(l => l.op === "insert");
  assert.equal(inserts.length, 1, "um INSERT só");
  assert.equal(inserts[0].payload.length, 9);
  assert.deepEqual(r.body.reservations.map(x => x.id), rowsFor(ALL).map(x => x.id), "mesma ordem do pedido");
});

test("11+12: grava as duas linhas", async () => {
  const db = seed();
  const r = await call({ rows: rowsFor(["12", "11"]) });
  assert.equal(r.status, 200);
  assert.equal(r.body.product, "11+12");
  assert.equal(db.tables.reservations.length, 2);
});

test("enforce: um quarto ocupado barra a CF inteira — 409 sem dados do outro hóspede, nada gravado", withMode("enforce", async () => {
  const db = seed([OTHER]);
  const r = await call({ rows: rowsFor(ALL) });
  assert.equal(r.status, 409);
  assert.deepEqual(r.body, { error: { code: "ROOM_CONFLICT", message: "Quarto indisponível no período", rooms: ["23"] } });
  assert.doesNotMatch(JSON.stringify(r.body), /Outro Teste|o1|0000/);
  assert.equal(db.tables.reservations.length, 1);
}));

test("enforce: 11+12 com o 12 ocupado → 409 e nem o 11 é gravado", withMode("enforce", async () => {
  const db = seed([{ ...OTHER, room_id: "12" }]);
  const r = await call({ rows: rowsFor(["11", "12"]) });
  assert.equal(r.status, 409);
  assert.deepEqual(r.body.error.rooms, ["12"]);
  assert.equal(db.tables.reservations.length, 1);
}));

test("enforce: saída = entrada não é conflito ([check_in, check_out))", withMode("enforce", async () => {
  const db = seed([{ ...OTHER, check_in: "2030-06-08", check_out: "2030-06-10" }]);
  const r = await call({ rows: rowsFor(ALL) });
  assert.equal(r.status, 200);
  assert.equal(db.tables.reservations.length, 10);
}));

test("enforce: falha ao consultar disponibilidade → 503 e nada gravado", withMode("enforce", async () => {
  const db = seed([], { failSelect: true });
  const r = await call({ rows: rowsFor(ALL) });
  assert.equal(r.status, 503);
  assert.equal(db.tables.reservations.length, 0);
}));

test("warn: conflito é registrado mas a CF é gravada (comportamento atual de produção)", withMode("warn", async () => {
  const db = seed([OTHER]);
  const r = await call({ rows: rowsFor(ALL) });
  assert.equal(r.status, 200);
  assert.equal(db.tables.reservations.length, 10);
}));

test("falha no insert (ex.: id repetido no banco) → nenhuma linha gravada e erro sem detalhes internos", async () => {
  const db = seed([{ id: "g5", room_id: "99", check_in: "2020-01-01", check_out: "2020-01-02", status: "cancelled" }]);
  const rows = rowsFor(ALL);
  rows[4].id = "g5";
  const r = await call({ rows });
  assert.equal(r.status, 500);
  assert.match(r.body.error, /Nada foi salvo/);
  assert.doesNotMatch(r.body.error, /duplicate/);
  assert.equal(db.tables.reservations.length, 1);
});

test("CF incompleta (8 quartos), quarto repetido ou quarto estranho → 400 e nada gravado", async () => {
  const db = seed();
  const casos = [
    ALL.slice(0, 8),
    [...ALL.slice(0, 8), "10"],
    ["11", "13"],
    ["11", "11"],
    ["CF", "11+12"],
  ];
  for (const rooms of casos) {
    const r = await call({ rows: rowsFor(rooms) });
    assert.equal(r.status, 400, rooms.join(","));
  }
  assert.equal(db.tables.reservations.length, 0);
});

test("datas ou hóspede diferentes entre as linhas → 400", async () => {
  seed();
  const a = rowsFor(["11", "12"]); a[1].checkOut = "2030-06-13";
  const b = rowsFor(["11", "12"]); b[1].status = "pending";
  const c = rowsFor(["11", "12"]); c[1].guestName = "";
  for (const rows of [a, b, c]) assert.equal((await call({ rows })).status, 400);
});

test("datas inválidas, saída antes da entrada e 31/02 → 400", async () => {
  seed();
  for (const [checkIn, checkOut] of [["2030-02-31", "2030-03-02"], ["2030-06-12", "2030-06-10"], ["2030-06-10", "2030-06-10"], ["", ""]]) {
    const r = await call({ rows: rowsFor(["11", "12"], { checkIn, checkOut }) });
    assert.equal(r.status, 400, `${checkIn}..${checkOut}`);
  }
});

test("ids repetidos no pedido, externalUid ou corpo malformado → 400", async () => {
  seed();
  const dup = rowsFor(["11", "12"]); dup[1].id = dup[0].id;
  assert.equal((await call({ rows: dup })).status, 400);
  assert.equal((await call({ rows: rowsFor(["11", "12"], { externalUid: "x@airbnb" }) })).status, 400);
  assert.equal((await call({ rows: "x" })).status, 400);
  assert.equal((await call({ rows: [null, null] })).status, 400);
  assert.equal((await call({})).status, 400);
});

test("sem login → 401", async () => {
  seed();
  const r = await call({ rows: rowsFor(["11", "12"]) }, null);
  assert.equal(r.status, 401);
});

test("cancelada (status cancelled) não checa disponibilidade, mas grava as duas linhas juntas", withMode("enforce", async () => {
  const db = seed([{ ...OTHER, room_id: "11" }]);
  const r = await call({ rows: rowsFor(["11", "12"], { status: "cancelled" }) });
  assert.equal(r.status, 200);
  assert.equal(db.tables.reservations.length, 3);
}));
