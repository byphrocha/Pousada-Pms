// Testes das rotas de reservas com Supabase simulado (PMS-004/005 camada 1, D1/D2/D3).
// Nenhum banco real; dados fictícios.
"use strict";
process.env.JWT_SECRET = "segredo-so-de-teste";
process.env.SUPABASE_URL = "http://127.0.0.1:9";
process.env.SUPABASE_KEY = "chave-falsa";

const test = require("node:test");
const assert = require("node:assert/strict");
const jwt = require("jsonwebtoken");
const { app, _setSupabaseForTests } = require("../server");
const { createFakeSupabase } = require("./helpers/fake-supabase");

const { ADMIN: adminTok, STAFF: staffTok } = require("./helpers/auth");
const ADMIN = adminTok(), STAFF = staffTok();

let server, base;
test.before(async () => {
  server = app.listen(0);
  await new Promise(r => server.once("listening", r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server.close());

function seed(rows = [], opts) {
  const db = createFakeSupabase({ reservations: rows, transactions: [] }, opts);
  _setSupabaseForTests(db);
  return db;
}
function call(method, path, body, auth = ADMIN) {
  return fetch(base + path, {
    method, headers: { "Content-Type": "application/json", Authorization: auth },
    body: body ? JSON.stringify(body) : undefined,
  }).then(async r => ({ status: r.status, body: await r.json().catch(() => null) }));
}
const NEW = { guestName: "Hóspede Teste", roomId: "20", checkIn: "2030-03-10", checkOut: "2030-03-12", source: "direto" };
const BUSY = { id: "r1", room_id: "20", guest_name: "Outro Teste", check_in: "2030-03-11", check_out: "2030-03-13", status: "confirmed" };

function withMode(mode, fn) {
  return async () => {
    const prev = process.env.AVAILABILITY_CHECK;
    process.env.AVAILABILITY_CHECK = mode;
    try { await fn(); } finally {
      if (prev === undefined) delete process.env.AVAILABILITY_CHECK; else process.env.AVAILABILITY_CHECK = prev;
    }
  };
}

// ── POST /reservations ───────────────────────────────────────────────────────
test("D3: POST recusa data inexistente (31/02)", async () => {
  seed();
  const r = await call("POST", "/reservations", { ...NEW, checkIn: "2030-02-31", checkOut: "2030-03-02" });
  assert.equal(r.status, 400);
});

test("POST recusa quarto que não é físico", async () => {
  seed();
  for (const roomId of ["13", "CF", "11+12"]) {
    const r = await call("POST", "/reservations", { ...NEW, roomId });
    assert.equal(r.status, 400, roomId);
  }
});

test("D1 enforce: POST em quarto ocupado → 409 sem dados do outro hóspede, nada gravado", withMode("enforce", async () => {
  const db = seed([BUSY]);
  const r = await call("POST", "/reservations", NEW);
  assert.equal(r.status, 409);
  assert.deepEqual(r.body, { error: { code: "ROOM_CONFLICT", message: "Quarto indisponível no período", rooms: ["20"] } });
  assert.doesNotMatch(JSON.stringify(r.body), /Outro Teste|r1/);
  assert.equal(db.tables.reservations.length, 1);
}));

test("enforce: datas adjacentes (saída = entrada) são aceitas", withMode("enforce", async () => {
  const db = seed([{ ...BUSY, check_in: "2030-03-08", check_out: "2030-03-10" }]);
  const r = await call("POST", "/reservations", NEW);
  assert.equal(r.status, 200);
  assert.equal(db.tables.reservations.length, 2);
}));

test("enforce: bloqueio 'Airbnb (Not available)' de meses não barra reserva direta", withMode("enforce", async () => {
  seed([{ ...BUSY, source: "airbnb", guest_name: "Airbnb (Not available)", check_in: "2030-01-01", check_out: "2030-06-01" }]);
  assert.equal((await call("POST", "/reservations", NEW)).status, 200);
}));

test("enforce: reserva cancelada não ocupa", withMode("enforce", async () => {
  seed([{ ...BUSY, status: "cancelled" }]);
  assert.equal((await call("POST", "/reservations", NEW)).status, 200);
}));

test("enforce: falha na consulta de disponibilidade → 503 e nada gravado", withMode("enforce", async () => {
  const db = seed([], { failSelect: true });
  const r = await call("POST", "/reservations", NEW);
  assert.equal(r.status, 503);
  assert.equal(db.tables.reservations.length, 0);
}));

test("warn (padrão): conflito é registrado no log mas grava como antes", withMode("warn", async () => {
  const db = seed([BUSY]);
  const logged = [];
  const orig = console.warn; console.warn = (m) => logged.push(m);
  try {
    const r = await call("POST", "/reservations", NEW);
    assert.equal(r.status, 200);
  } finally { console.warn = orig; }
  assert.equal(db.tables.reservations.length, 2);
  assert.equal(logged.length, 1);
  assert.match(logged[0], /quartos=20/);
  assert.doesNotMatch(logged[0], /Outro Teste|Hóspede Teste/, "log sem nome de hóspede");
}));

test("off: não consulta disponibilidade", withMode("off", async () => {
  const db = seed([BUSY]);
  assert.equal((await call("POST", "/reservations", NEW)).status, 200);
  assert.equal(db.log.filter(l => l.op === "select" && l.table === "reservations").length, 0);
}));

test("modo inválido na variável cai para warn", withMode("banana", async () => {
  const db = seed([BUSY]);
  const orig = console.warn; console.warn = () => {};
  try { assert.equal((await call("POST", "/reservations", NEW)).status, 200); } finally { console.warn = orig; }
  assert.equal(db.tables.reservations.length, 2);
}));

// ── PUT /reservations/:id ────────────────────────────────────────────────────
const MINE = { id: "m1", room_id: "21", guest_name: "Hóspede Teste", check_in: "2030-03-10", check_out: "2030-03-12", status: "confirmed" };

test("D2: PUT recusa saída antes da entrada", async () => {
  const db = seed([MINE]);
  const r = await call("PUT", "/reservations/m1", { checkIn: "2030-03-12", checkOut: "2030-03-10" });
  assert.equal(r.status, 400);
  assert.equal(db.tables.reservations[0].check_in, "2030-03-10", "não alterou");
});

test("D2: PUT recusa data inexistente", async () => {
  seed([MINE]);
  assert.equal((await call("PUT", "/reservations/m1", { checkOut: "2030-02-30" })).status, 400);
});

test("PUT de linha antiga com quarto fora do padrão continua editável se o quarto não muda", async () => {
  seed([{ ...MINE, id: "old", room_id: "CF" }]);
  assert.equal((await call("PUT", "/reservations/old", { roomId: "CF", notes: "x" })).status, 200);
  assert.equal((await call("PUT", "/reservations/old", { roomId: "99" })).status, 400);
});

test("PUT em reserva inexistente → 404", async () => {
  seed([]);
  assert.equal((await call("PUT", "/reservations/nao-existe", { checkOut: "2030-03-20" })).status, 404);
});

test("enforce: PUT mudando para quarto ocupado → 409 e reserva original intacta", withMode("enforce", async () => {
  const db = seed([MINE, BUSY]);
  const r = await call("PUT", "/reservations/m1", { roomId: "20" });
  assert.equal(r.status, 409);
  assert.equal(db.tables.reservations.find(x => x.id === "m1").room_id, "21");
}));

test("enforce: PUT estendendo datas sobre outra reserva → 409", withMode("enforce", async () => {
  seed([MINE, { ...BUSY, room_id: "21", check_in: "2030-03-12", check_out: "2030-03-14" }]);
  assert.equal((await call("PUT", "/reservations/m1", { checkOut: "2030-03-13" })).status, 409);
}));

test("enforce: PUT da própria reserva sem mudar nada relevante passa (não conflita consigo)", withMode("enforce", async () => {
  seed([MINE]);
  assert.equal((await call("PUT", "/reservations/m1", { ...NEW, roomId: "21", checkIn: "2030-03-10", checkOut: "2030-03-12" })).status, 200);
}));

test("enforce: cancelar nunca é barrado", withMode("enforce", async () => {
  const db = seed([MINE, { ...BUSY, room_id: "21" }]);
  assert.equal((await call("PUT", "/reservations/m1", { status: "cancelled" })).status, 200);
  assert.equal(db.tables.reservations.find(x => x.id === "m1").status, "cancelled");
}));

test("enforce: reativar reserva cancelada num período já ocupado → 409", withMode("enforce", async () => {
  seed([{ ...MINE, status: "cancelled" }, { ...BUSY, room_id: "21" }]);
  assert.equal((await call("PUT", "/reservations/m1", { status: "confirmed" })).status, 409);
}));

test("PUT só de observação não consulta disponibilidade", withMode("enforce", async () => {
  const db = seed([MINE]);
  assert.equal((await call("PUT", "/reservations/m1", { notes: "obs" })).status, 200);
  // A consulta de disponibilidade é a que lê source/guest_name para reconhecer bloqueios.
  assert.equal(db.log.filter(l => l.op === "select" && l.table === "reservations" && /guest_name/.test(l.columns || "")).length, 0);
}));

// ── GET /transactions?reservation_id (usado pela correção F2) ────────────────
test("GET /transactions filtra por reservation_id", async () => {
  const db = createFakeSupabase({ transactions: [
    { id: "t1", reservation_id: "abc123", type: "income", amount: 1 },
    { id: "t2", reservation_id: "zzz999", type: "income", amount: 2 },
  ]});
  _setSupabaseForTests(db);
  const r = await call("GET", "/transactions?reservation_id=abc123");
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.map(t => t.id), ["t1"]);
});

test("GET /transactions com reservation_id inválido → 400 (não devolve tudo)", async () => {
  seed();
  for (const bad of ["", "a b", "x".repeat(21), "1;drop"]) {
    const r = await call("GET", "/transactions?reservation_id=" + encodeURIComponent(bad));
    assert.equal(r.status, 400, JSON.stringify(bad));
  }
});

test("GET /transactions continua só para admin", async () => {
  seed();
  assert.equal((await call("GET", "/transactions?reservation_id=abc", null, STAFF)).status, 403);
});

// ── Limite conhecido da camada 1 ─────────────────────────────────────────────
test("concorrência: dois POST simultâneos no mesmo quarto gravam no máximo uma reserva",
  { todo: "Camada 1 (consulta + insert) não fecha a corrida. Resolve com a constraint no banco (PR 6)." },
  withMode("enforce", async () => {
    const db = seed([], { delayMs: 5 });
    await Promise.all([call("POST", "/reservations", NEW), call("POST", "/reservations", NEW)]);
    assert.equal(db.tables.reservations.length, 1);
  }));
