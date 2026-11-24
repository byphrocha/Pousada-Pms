// PMS-010 passo 2: calendários por canal que o Airbnb e o Booking vão importar.
// Regras: sem bloqueio "Not available" do Airbnb (consequência, fecharia quartos
// em cadeia), sem eco do próprio anúncio, CF/11+12 somam os quartos, nenhum dado
// de hóspede, e erro no banco nunca vira calendário vazio. Dados fictícios.
"use strict";
process.env.JWT_SECRET = "segredo-so-de-teste";
process.env.SUPABASE_URL = "http://127.0.0.1:9";
process.env.SUPABASE_KEY = "chave-falsa";
process.env.CALENDAR_TOKEN = "token-ficticio-de-teste";

const test = require("node:test");
const assert = require("node:assert/strict");
const fx = require("../lib/feed-export");
const { app, _setSupabaseForTests } = require("../server");
const { createFakeSupabase } = require("./helpers/fake-supabase");
const { ADMIN } = require("./helpers/auth");

let server, base;
test.before(async () => { server = app.listen(0); await new Promise(r => server.once("listening", r)); base = `http://127.0.0.1:${server.address().port}`; });
test.after(() => server.close());
const get = (p, auth) => fetch(base + p, { headers: auth ? { Authorization: auth } : {} })
  .then(async r => ({ status: r.status, text: await r.text() }));
const quiet = (fn) => async () => { const o = [console.log, console.error]; console.log = console.error = () => {};
  try { await fn(); } finally { [console.log, console.error] = o; } };

const ALL = ["10", "11", "12", "20", "21", "22", "23", "24", "25"];
const D = (ci, co) => ({ check_in: ci, check_out: co, status: "confirmed" });
// Linhas como estão no banco em 24/11/2026 (tipos de origem reais, nomes fictícios).
const rows = [
  // bloqueio automático da CF no Airbnb (consequência de a suíte ter sido vendida), nos 9 quartos
  ...ALL.map(room => ({ id: "blk" + room, room_id: room, source: "airbnb", guest_name: "Airbnb (Not available)",
    external_uid: `airbnb-${room}-B1`, notes: "Importado via iCal (Casa Fechada) [Casa toda:cf-B1]", group_id: "cf:cf-B1", ...D("2030-02-01", "2030-02-03") })),
  // reserva da suíte 11+12 no Airbnb
  ...["11", "12"].map(room => ({ id: "su" + room, room_id: room, source: "airbnb", guest_name: "Reserved",
    external_uid: `airbnb-${room}-S1`, notes: "Importado via iCal (Suíte 11+12)", group_id: "suite:ical-airbnb-S1", ...D("2030-02-01", "2030-02-03") })),
  // reserva do anúncio do quarto 22 no Airbnb
  { id: "ab22", room_id: "22", source: "airbnb", guest_name: "Reserved", external_uid: "airbnb-22-A1", notes: "Importado via iCal", ...D("2030-03-01", "2030-03-04") },
  // Casa Fechada real vendida no Airbnb
  ...ALL.map(room => ({ id: "cf" + room, room_id: room, source: "airbnb", guest_name: "Reserved",
    external_uid: `airbnb-${room}-C1`, notes: "Importado via iCal (Casa Fechada) [Casa toda:cf-C1]", group_id: "cf:cf-C1", ...D("2030-05-10", "2030-05-12") })),
  // Booking (toda entrada vem como CLOSED; pode ser reserva real)
  { id: "bk22", room_id: "22", source: "booking", guest_name: "CLOSED - Not available", external_uid: "booking-22-K1", notes: "Importado via iCal", ...D("2030-04-01", "2030-04-03") },
  // reserva direta no 24
  { id: "dir24", room_id: "24", source: "direto", guest_name: "Hóspede Teste da Silva", phone: "TEL-FICTICIO", ...D("2030-06-01", "2030-06-05") },
  // canceladas e pendentes não ocupam
  { id: "can", room_id: "24", source: "direto", guest_name: "Cancelado Teste", ...D("2030-07-01", "2030-07-03"), status: "cancelled" },
  { id: "pen", room_id: "24", source: "direto", guest_name: "Pendente Teste", ...D("2030-08-01", "2030-08-03"), status: "pending" },
];
const periods = (channel, product) => fx.feedRows(rows, { channel, product })
  .map(r => `${r.check_in}..${r.check_out}`).filter((v, i, a) => a.indexOf(v) === i).sort();

test("bloqueio automático do Airbnb nunca é exportado (senão fecha quartos livres em cadeia)", () => {
  for (const [ch, p] of [["booking", "20"], ["airbnb", "21"], ["booking", "24"], ["airbnb", "CF"]])
    assert.ok(!fx.feedRows(rows, { channel: ch, product: p }).some(r => r.id.startsWith("blk")), `${ch}/${p}`);
});

test("sem eco: o anúncio não recebe de volta as próprias reservas", () => {
  assert.deepEqual(periods("airbnb", "22"), ["2030-04-01..2030-04-03", "2030-05-10..2030-05-12"], "Airbnb 22: Booking + CF; sem a própria");
  assert.deepEqual(periods("booking", "22"), ["2030-03-01..2030-03-04", "2030-05-10..2030-05-12"], "Booking 22: Airbnb 22 + CF; sem a própria");
  assert.ok(!periods("airbnb", "11+12").includes("2030-02-01..2030-02-03"), "suíte não recebe a própria");
  assert.ok(!periods("airbnb", "CF").includes("2030-05-10..2030-05-12"), "CF não recebe a própria");
});

test("CF soma os 9 quartos; 11+12 soma 11 e 12; reserva de outro anúncio do Airbnb entra", () => {
  assert.deepEqual(periods("airbnb", "CF"), ["2030-02-01..2030-02-03", "2030-03-01..2030-03-04", "2030-04-01..2030-04-03", "2030-06-01..2030-06-05"]);
  assert.deepEqual(periods("airbnb", "11+12"), ["2030-05-10..2030-05-12"], "CF vendida fecha a suíte");
  assert.deepEqual(periods("airbnb", "21"), ["2030-05-10..2030-05-12"], "CF vendida fecha o 21; suíte vendida não");
  assert.deepEqual(periods("booking", "20"), ["2030-05-10..2030-05-12"]);
  assert.deepEqual(periods("booking", "24"), ["2030-05-10..2030-05-12", "2030-06-01..2030-06-05"], "direta + CF; sem cancelada/pendente");
});

test("arquivo: um evento por período, UID estável, sem nome nem telefone", () => {
  const ics = fx.buildCalendar(fx.feedRows(rows, { channel: "airbnb", product: "CF" }), { channel: "airbnb", product: "CF", now: new Date("2030-01-01T00:00:00Z") });
  assert.equal((ics.match(/BEGIN:VEVENT/g) || []).length, 4, "9 linhas da mesma data viram 1 evento");
  assert.match(ics, /UID:pms-CF-20300601-20300605@pousada/);
  assert.match(ics, /DTSTART;VALUE=DATE:20300601\r\nDTEND;VALUE=DATE:20300605/);
  assert.doesNotMatch(ics, /Silva|TEL-FICTICIO|Hóspede|Reserved|CLOSED/);
  assert.equal(fx.roomsOf("99"), null);
});

function db(extra = {}, opts) {
  const d = createFakeSupabase({ reservations: rows.map(r => ({ ...r })), settings: [{ key: "ical_urls", value: {
    airbnb: { "21": "https://www.airbnb.com/calendar/ical/fonte-21.ics", "22": "https://www.airbnb.com/calendar/ical/fonte-22.ics", "CF": "https://www.airbnb.com/calendar/ical/fonte-cf.ics", "11+12": "" },
    booking: { "20": "https://admin.booking.com/fonte-20.ics", "22": "https://admin.booking.com/fonte-22.ics", "24": "https://admin.booking.com/fonte-24.ics" } } }], ...extra }, opts);
  _setSupabaseForTests(d); return d;
}

test("rota: token certo serve o calendário; errado 403; canal/anúncio inválido 404", quiet(async () => {
  db();
  const ok = await get("/calendar/token-ficticio-de-teste/booking/22.ics");
  assert.equal(ok.status, 200);
  assert.match(ok.text, /BEGIN:VCALENDAR/);
  assert.equal((ok.text.match(/BEGIN:VEVENT/g) || []).length, 2);
  assert.equal((await get("/calendar/errado/booking/22.ics")).status, 403);
  assert.equal((await get("/calendar/token-ficticio-de-teste/expedia/22.ics")).status, 404);
  assert.equal((await get("/calendar/token-ficticio-de-teste/airbnb/99.ics")).status, 404);
  const cf = await get(`/calendar/token-ficticio-de-teste/airbnb/${encodeURIComponent("11+12")}.ics`);
  assert.equal(cf.status, 200);
}));

test("rota: erro no banco responde 503, nunca calendário vazio (a plataforma reabriria tudo)", quiet(async () => {
  db({}, { failSelect: true });
  const r = await get("/calendar/token-ficticio-de-teste/airbnb/CF.ics");
  assert.equal(r.status, 503);
  assert.doesNotMatch(r.text, /VCALENDAR/);
}));

test("lista de links: só anúncios cadastrados, por canal, sem expor as URLs de origem", quiet(async () => {
  db();
  const r = await get("/calendar-urls", ADMIN());
  assert.equal(r.status, 200);
  const body = JSON.parse(r.text);
  assert.deepEqual(Object.keys(body.channels.airbnb), ["21", "22", "CF"], "11+12 sem URL cadastrada não aparece");
  assert.deepEqual(Object.keys(body.channels.booking), ["20", "22", "24"]);
  assert.match(body.channels.booking["22"], /\/calendar\/token-ficticio-de-teste\/booking\/22\.ics$/);
  assert.doesNotMatch(r.text, /fonte-|airbnb\.com|admin\.booking/);
}));
