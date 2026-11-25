// Realocação (25/11/2026): hóspede reservou a Suíte 11+12 no Airbnb e vai para o
// quarto 23. A estadia inteira muda; 11 e 12 ficam livres; a sincronização
// continua seguindo a reserva (mudança de datas e cancelamento no Airbnb).
// Supabase simulado com a constraint; dados fictícios.
"use strict";
process.env.JWT_SECRET = "segredo-so-de-teste";
process.env.SUPABASE_URL = "http://127.0.0.1:9";
process.env.SUPABASE_KEY = "chave-falsa";

const test = require("node:test");
const assert = require("node:assert/strict");
const { app, runSync, _setSupabaseForTests, _resetIcalStateForTests } = require("../server");
const { createFakeSupabase } = require("./helpers/fake-supabase");
const { TEST_USERS, ADMIN, STAFF } = require("./helpers/auth");

let server, base;
test.before(async () => { server = app.listen(0); await new Promise(r => server.once("listening", r)); base = `http://127.0.0.1:${server.address().port}`; });
test.after(() => server.close());
const quiet = (fn) => async () => { const o = [console.log, console.warn, console.error];
  console.log = console.warn = console.error = () => {};
  const p = process.env.ICAL_RECONCILE; process.env.ICAL_RECONCILE = "apply";
  try { _resetIcalStateForTests(); await fn(); }
  finally { [console.log, console.warn, console.error] = o; if (p === undefined) delete process.env.ICAL_RECONCILE; else process.env.ICAL_RECONCILE = p; } };
const move = (id, roomId, auth = ADMIN()) => fetch(`${base}/reservations/${id}/move`, { method: "POST",
  headers: { "Content-Type": "application/json", Authorization: auth }, body: JSON.stringify({ roomId }) })
  .then(async r => ({ status: r.status, body: await r.json().catch(() => null) }));

const URL_S = "https://www.airbnb.com.br/calendar/ical/ficticio-suite.ics";
const cal = (...evs) => ["BEGIN:VCALENDAR", ...evs.flatMap(([uid, ci, co]) => ["BEGIN:VEVENT", `UID:${uid}`,
  `DTSTART;VALUE=DATE:${ci.replace(/-/g, "")}`, `DTEND;VALUE=DATE:${co.replace(/-/g, "")}`, "SUMMARY:Reserved", "END:VEVENT"]), "END:VCALENDAR"].join("\n");
const OUTRA = ["OUTRA", "2099-06-01", "2099-06-02"]; // mantém o calendário com algo (vazio não cancela nada)

function banco(extra = []) {
  const db = createFakeSupabase({ users: TEST_USERS.map(u => ({ ...u })), reservations: [...extra], audit_log: [], payments: [],
    settings: [{ key: "ical_urls", value: { airbnb: { "11+12": URL_S }, booking: {} } }] }, { noOverlap: true });
  _setSupabaseForTests(db);
  return db;
}
const sync = (text) => runSync({ fetcher: async () => text });
// Só a estadia do teste (o evento OUTRA também é da suíte e fica em 11/12).
const byRoom = (db, room) => db.tables.reservations.filter(r => r.room_id === room && r.status !== "cancelled" && r.check_in !== "2099-06-01");

test("suíte do Airbnb → quarto 23: a estadia vai inteira, 11 e 12 ficam livres, tudo registrado", quiet(async () => {
  const db = banco();
  await sync(cal(["S1", "2099-11-25", "2099-11-26"], OUTRA));
  const [r11] = byRoom(db, "11");
  assert.ok(r11 && r11.group_id);
  const r = await move(r11.id, "23");
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.freed.sort(), ["11", "12"]);
  assert.equal(byRoom(db, "23").length, 1);
  assert.equal(byRoom(db, "11").length + byRoom(db, "12").length, 0);
  const moved = byRoom(db, "23")[0];
  assert.equal(moved.group_id, null, "sai do grupo: editar depois não mexe na linha cancelada");
  assert.ok(db.tables.audit_log.filter(a => a.action === "reserva.mudar_quarto").length >= 2);
  // próxima sincronização: nada volta para 11/12 (cancelada por pessoa não é reativada)
  await sync(cal(["S1", "2099-11-25", "2099-11-26"], OUTRA));
  assert.equal(byRoom(db, "11").length + byRoom(db, "12").length, 0);
  assert.equal(byRoom(db, "23").length, 1);
}));

test("depois de realocada, a sincronização continua seguindo: datas mudam e cancelamento no Airbnb cancela no 23", quiet(async () => {
  const db = banco();
  await sync(cal(["S2", "2099-11-25", "2099-11-26"], OUTRA));
  await move(byRoom(db, "11")[0].id, "23");
  await sync(cal(["S2", "2099-11-25", "2099-11-28"], OUTRA));
  const moved = db.tables.reservations.find(r => r.room_id === "23");
  assert.deepEqual([moved.status, moved.check_out], ["confirmed", "2099-11-28"], "datas acompanham");
  await sync(cal(OUTRA)); await sync(cal(OUTRA));
  assert.equal(moved.status, "cancelled", "cancelou no Airbnb → cancela no 23");
}));

test("quarto de destino ocupado → 409 ROOM_CONFLICT sem dados do outro hóspede, e nada muda", quiet(async () => {
  const db = banco([{ id: "d23", room_id: "23", source: "direto", status: "confirmed", guest_name: "Outro Hóspede Fictício",
    phone: "TEL-FICTICIO", check_in: "2099-11-25", check_out: "2099-11-27" }]);
  await sync(cal(["S3", "2099-11-25", "2099-11-26"], OUTRA));
  const r = await move(byRoom(db, "11")[0].id, "23");
  assert.equal(r.status, 409);
  assert.equal(r.body.error.code, "ROOM_CONFLICT");
  assert.doesNotMatch(JSON.stringify(r.body), /Fictício|TEL-FICTICIO/);
  assert.equal(byRoom(db, "11").length + byRoom(db, "12").length, 2, "suíte intacta");
}));

test("fica a linha do contrato (valor e pagamentos), mesmo abrindo pela outra", quiet(async () => {
  const db = banco([
    { id: "s11", room_id: "11", source: "direto", status: "confirmed", guest_name: "Teste", group_id: "suite:g", amount: 900, check_in: "2099-10-01", check_out: "2099-10-03" },
    { id: "s12", room_id: "12", source: "direto", status: "confirmed", guest_name: "Teste", group_id: "suite:g", amount: 0, check_in: "2099-10-01", check_out: "2099-10-03" }]);
  const r = await move("s12", "21");
  assert.equal(r.body.id, "s11");
  const s11 = db.tables.reservations.find(x => x.id === "s11"), s12 = db.tables.reservations.find(x => x.id === "s12");
  assert.deepEqual([s11.room_id, s11.status, s11.amount], ["21", "confirmed", 900]);
  assert.equal(s12.status, "cancelled");
}));

test("Casa Fechada → um quarto da própria casa: fica esse quarto, os outros 8 liberados", quiet(async () => {
  const ALL = ["10", "11", "12", "20", "21", "22", "23", "24", "25"];
  const db = banco(ALL.map((room, i) => ({ id: "cf" + room, room_id: room, source: "direto", status: "confirmed", guest_name: "Teste",
    group_id: "cf:g", amount: i === 0 ? 2000 : 0, check_in: "2099-09-01", check_out: "2099-09-03" })));
  const r = await move("cf20", "20");
  assert.equal(r.status, 200);
  const ativos = db.tables.reservations.filter(x => x.status === "confirmed");
  assert.deepEqual(ativos.map(x => [x.id, x.room_id]), [["cf10", "20"]], "a linha do contrato vai para o 20");
}));

test("validação: quarto inválido, reserva cancelada, inexistente e mesmo quarto", quiet(async () => {
  banco([{ id: "a", room_id: "21", source: "direto", status: "confirmed", guest_name: "T", check_in: "2099-01-01", check_out: "2099-01-02" },
         { id: "c", room_id: "21", source: "direto", status: "cancelled", guest_name: "T", check_in: "2099-02-01", check_out: "2099-02-02" }]);
  assert.equal((await move("a", "CF")).status, 400);
  assert.equal((await move("a", "99")).status, 400);
  assert.equal((await move("a", "21")).status, 400);
  assert.equal((await move("c", "22")).status, 400);
  assert.equal((await move("nao-existe", "22")).status, 404);
  assert.equal((await move("a", "22", STAFF())).status, 200, "funcionário também realoca (como edita)");
}));

test("se mover falhar depois de liberar, os quartos antigos voltam como estavam", quiet(async () => {
  const db = banco([
    { id: "s11", room_id: "11", source: "direto", status: "confirmed", guest_name: "T", group_id: "suite:h", amount: 1, check_in: "2099-08-01", check_out: "2099-08-02" },
    { id: "s12", room_id: "12", source: "direto", status: "confirmed", guest_name: "T", group_id: "suite:h", amount: 0, check_in: "2099-08-01", check_out: "2099-08-02" }]);
  const from = db.from;
  db.from = (t) => { const q = from(t); const up = q.update;
    q.update = (p) => { const r = up(p); if (p && p.room_id === "23") { r.eq = () => ({ then: (ok) => ok({ data: null, error: { code: "XX000" } }) }); } return r; }; return q; };
  const r = await move("s11", "23");
  assert.equal(r.status, 500);
  assert.equal(db.tables.reservations.find(x => x.id === "s12").status, "confirmed", "liberação desfeita");
  const s11 = db.tables.reservations.find(x => x.id === "s11");
  assert.deepEqual([s11.room_id, s11.group_id], ["11", "suite:h"]);
}));

// ── tela ─────────────────────────────────────────────────────────────────────
const { loadFrontend } = require("./helpers/frontend-harness");
test("tela: trocar o quarto de uma reserva da suíte pergunta e chama a mudança da estadia inteira", async () => {
  const fe = loadFrontend({ fields: { "f-roomId": "23", "f-guestName": "Reserved", "f-checkIn": "2099-11-25", "f-checkOut": "2099-11-26", "f-source": "airbnb" },
    routes: [{ method: "POST", path: "/reservations/r11/move", reply: () => ({ status: 200, json: { ok: true, id: "r11", roomId: "23", freed: ["11", "12"] } }) },
             { method: "PUT", path: "/reservations/r11", reply: () => ({ status: 200, json: { ok: true } }) }] });
  fe.run(`reservations = [{ id: "r11", roomId: "11", guestName: "Reserved", checkIn: "2099-11-25", checkOut: "2099-11-26", source: "airbnb", status: "confirmed", groupId: "suite:x", notes: "" },
                          { id: "r12", roomId: "12", guestName: "Reserved", checkIn: "2099-11-25", checkOut: "2099-11-26", source: "airbnb", status: "confirmed", groupId: "suite:x", notes: "" }].map(normalizeRes); authRole = "admin";`);
  let pergunta = "";
  fe.context.confirm = (m) => { pergunta = m; return true; };
  await fe.run(`submitForm("r11")`);
  assert.match(pergunta, /Mover a estadia da Suíte 11\+12 inteira para o quarto 23\?/);
  assert.ok(fe.calls.some(c => c.method === "POST" && c.path === "/reservations/r11/move" && c.body.roomId === "23"));
  assert.doesNotMatch(fe.alerts.join(), /não dá para trocar|Não mudou/);
});

test("tela: se a pessoa não confirmar, nada é enviado", async () => {
  const fe = loadFrontend({ fields: { "f-roomId": "23", "f-guestName": "Reserved", "f-checkIn": "2099-11-25", "f-checkOut": "2099-11-26", "f-source": "airbnb" } });
  fe.run(`reservations = [{ id: "r11", roomId: "11", guestName: "Reserved", checkIn: "2099-11-25", checkOut: "2099-11-26", source: "airbnb", status: "confirmed", groupId: "suite:x", notes: "" }].map(normalizeRes);`);
  fe.context.confirm = () => false;
  await fe.run(`submitForm("r11")`);
  assert.equal(fe.calls.filter(c => c.method !== "GET").length, 0);
});

test("tela: aberta pela linha do 12, mas fica a do 11 (contrato): o resto da edição vai para a linha que ficou", async () => {
  const fe = loadFrontend({ fields: { "f-roomId": "23", "f-guestName": "Reserved", "f-checkIn": "2099-11-25", "f-checkOut": "2099-11-26", "f-source": "airbnb" },
    routes: [{ method: "POST", path: "/reservations/r12/move", reply: () => ({ status: 200, json: { ok: true, id: "r11", roomId: "23", freed: ["11", "12"] } }) },
             { method: "PUT", path: "/reservations/r11", reply: () => ({ status: 200, json: { ok: true } }) }] });
  fe.run(`reservations = [{ id: "r11", roomId: "11", guestName: "Reserved", checkIn: "2099-11-25", checkOut: "2099-11-26", source: "airbnb", status: "confirmed", groupId: "suite:x", notes: "" },
                          { id: "r12", roomId: "12", guestName: "Reserved", checkIn: "2099-11-25", checkOut: "2099-11-26", source: "airbnb", status: "confirmed", groupId: "suite:x", notes: "" }].map(normalizeRes); authRole = "admin";`);
  await fe.run(`submitForm("r12")`);
  const puts = fe.calls.filter(c => c.method === "PUT").map(c => c.path);
  assert.ok(puts.includes("/reservations/r11"));
  assert.ok(!puts.includes("/reservations/r12"), "não grava na linha que foi liberada");
});
