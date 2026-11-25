// Avisos no celular (Web Push): assinatura VAPID, quem recebe, o que é avisado
// (só conflito novo, uma vez), caixa de mensagens do aparelho e a tela.
// Supabase simulado; nenhum push sai de verdade; dados fictícios.
"use strict";
process.env.JWT_SECRET = "segredo-so-de-teste";
process.env.SUPABASE_URL = "http://127.0.0.1:9";
process.env.SUPABASE_KEY = "chave-falsa";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const wp = require("../lib/webpush");
const pa = require("../lib/push-alerts");
const { app, runSync, _setSupabaseForTests, _setPushFetchForTests, _resetIcalStateForTests } = require("../server");
const { createFakeSupabase } = require("./helpers/fake-supabase");
const { TEST_USERS, ADMIN, STAFF } = require("./helpers/auth");

const KEYS = wp.generateVapidKeys();
const EP = "https://web.push.apple.com/QFicticio-aparelho-1";
let server, base;
test.before(async () => { server = app.listen(0); await new Promise(r => server.once("listening", r)); base = `http://127.0.0.1:${server.address().port}`; });
test.after(() => server.close());
const quiet = (fn) => async () => { const o = [console.log, console.warn, console.error];
  console.log = console.warn = console.error = () => {}; try { await fn(); } finally { [console.log, console.warn, console.error] = o; } };
const withKeys = (fn) => quiet(async () => {
  process.env.VAPID_PUBLIC_KEY = KEYS.publicKey; process.env.VAPID_PRIVATE_KEY = KEYS.privateKey;
  try { await fn(); } finally { delete process.env.VAPID_PUBLIC_KEY; delete process.env.VAPID_PRIVATE_KEY; }
});
const call = (method, p, auth, body) => fetch(base + p, { method,
  headers: { "Content-Type": "application/json", ...(auth ? { Authorization: auth } : {}) }, body: body ? JSON.stringify(body) : undefined })
  .then(async r => ({ status: r.status, body: await r.json().catch(() => null) }));
function seed(extra = {}) {
  const db = createFakeSupabase({ users: TEST_USERS.map(u => ({ ...u })), reservations: [], settings: [], ...extra }, { noOverlap: true });
  _setSupabaseForTests(db);
  return db;
}
const setting = (db, k) => (db.tables.settings.find(s => s.key === k) || {}).value;
function pushRecorder(status = 201) {
  const sent = [];
  _setPushFetchForTests(async (url, opts) => { sent.push({ url, opts }); return { status: typeof status === "function" ? status(url) : status }; });
  return sent;
}

// ── VAPID ────────────────────────────────────────────────────────────────────
test("VAPID: JWT ES256 válido para a origem do serviço de push, com validade e contato", () => {
  const auth = wp.vapidAuthorization(EP, { ...KEYS, subject: "https://pms.exemplo.test", now: Date.UTC(2030, 0, 1) });
  const m = auth.match(/^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/);
  assert.ok(m);
  assert.equal(m[4], KEYS.publicKey);
  const claims = JSON.parse(wp.fromB64u(m[2]).toString());
  assert.deepEqual(claims, { aud: "https://web.push.apple.com", exp: Date.UTC(2030, 0, 1) / 1000 + 12 * 3600, sub: "https://pms.exemplo.test" });
  assert.deepEqual(JSON.parse(wp.fromB64u(m[1]).toString()), { typ: "JWT", alg: "ES256" });
  const pub = wp.fromB64u(KEYS.publicKey);
  const key = crypto.createPublicKey({ format: "jwk", key: { kty: "EC", crv: "P-256", x: wp.b64u(pub.subarray(1, 33)), y: wp.b64u(pub.subarray(33)) } });
  assert.equal(crypto.verify("sha256", Buffer.from(`${m[1]}.${m[2]}`), { key, dsaEncoding: "ieee-p1363" }, wp.fromB64u(m[3])), true);
  assert.equal(wp.fromB64u(m[3]).length, 64, "assinatura no formato JWS (r||s), não DER");
});

test("VAPID: par de chaves conferido (pública tem de bater com a privada)", () => {
  assert.equal(wp.vapidKeysValid(KEYS.publicKey, KEYS.privateKey), true);
  assert.equal(wp.vapidKeysValid(wp.generateVapidKeys().publicKey, KEYS.privateKey), false);
  assert.equal(wp.vapidKeysValid("lixo", "lixo"), false);
});

test("endpoint: só https de serviço de push conhecido (a PMS não vira proxy)", () => {
  assert.equal(wp.endpointAllowed(EP), true);
  assert.equal(wp.endpointAllowed("https://fcm.googleapis.com/fcm/send/x"), true);
  assert.equal(wp.endpointAllowed("http://web.push.apple.com/x"), false);
  assert.equal(wp.endpointAllowed("https://127.0.0.1/x"), false);
  assert.equal(wp.endpointAllowed("https://web.push.apple.com.atacante.test/x"), false);
  assert.equal(wp.endpointAllowed("não é url"), false);
});

test("envio: push vazio com TTL e VAPID; 404/410 = aparelho sumiu; erro de rede não lança", async () => {
  const calls = [];
  const ok = await wp.sendEmptyPush(EP, { ...KEYS, subject: "https://x.test" }, async (u, o) => { calls.push(o); return { status: 201 }; });
  assert.equal(ok, "ok");
  assert.equal(calls[0].method, "POST");
  assert.equal(calls[0].body, undefined, "sem conteúdo");
  assert.equal(calls[0].headers.TTL, "86400");
  assert.match(calls[0].headers.Authorization, /^vapid t=/);
  assert.equal(await wp.sendEmptyPush(EP, { ...KEYS, subject: "s" }, async () => ({ status: 410 })), "gone");
  assert.equal(await wp.sendEmptyPush(EP, { ...KEYS, subject: "s" }, async () => ({ status: 500 })), "erro");
  assert.equal(await wp.sendEmptyPush(EP, { ...KEYS, subject: "s" }, async () => { throw new Error("rede"); }), "erro");
});

// ── o que é avisado ──────────────────────────────────────────────────────────
test("conflitos: só os novos; resolvido sai da lista e, se voltar, avisa de novo", () => {
  const st = (cs) => ({ feeds: { "airbnb/22": { conflicts: cs } } });
  const c1 = { room: "22", checkIn: "2026-12-02", checkOut: "2026-12-06" };
  let d = pa.diffConflicts(st([c1]), []);
  assert.equal(d.fresh.length, 1);
  d = pa.diffConflicts(st([c1]), d.notified);
  assert.equal(d.fresh.length, 0, "não repete a cada sincronização");
  d = pa.diffConflicts(st([]), d.notified);
  assert.deepEqual(d.notified, []);
  assert.equal(pa.diffConflicts(st([c1]), d.notified).fresh.length, 1);
});

test("mensagem: canal, produto e datas; nada de hóspede", () => {
  assert.deepEqual(pa.conflictMessage({ feed: "airbnb/22", room: "22", checkIn: "2026-12-02", checkOut: "2026-12-06" }),
    { title: "⚠️ Possível overbooking", body: "Airbnb quarto 22: 02/12 → 06/12 já está ocupado na PMS. Confira na plataforma." });
  assert.match(pa.conflictMessage({ feed: "airbnb/CF", room: "CF", checkIn: "2026-12-02", checkOut: "2026-12-03" }).body, /^Airbnb Casa Fechada:/);
  assert.match(pa.conflictMessage({ feed: "booking/20", room: "20", checkIn: "2026-12-02", checkOut: "2026-12-03" }).body, /^Booking quarto 20:/);
});

// ── rotas ────────────────────────────────────────────────────────────────────
test("sem chaves VAPID no servidor: tudo desligado, nada é enviado", quiet(async () => {
  seed(); const sent = pushRecorder();
  assert.deepEqual((await call("GET", "/push/config", ADMIN())).body, { enabled: false, publicKey: null });
  assert.equal((await call("POST", "/push/subscribe", ADMIN(), { endpoint: EP })).status, 503);
  assert.equal((await call("POST", "/push/test", ADMIN())).status, 503);
  assert.equal(sent.length, 0);
}));

test("ativar, testar e a caixa: o aparelho busca o texto uma vez com o próprio endpoint", withKeys(async () => {
  const db = seed(); const sent = pushRecorder();
  assert.deepEqual((await call("GET", "/push/config", STAFF())).body, { enabled: true, publicKey: KEYS.publicKey });
  assert.equal((await call("POST", "/push/subscribe", STAFF(), { endpoint: EP })).status, 403);
  assert.equal((await call("POST", "/push/subscribe", ADMIN(), { endpoint: "https://atacante.test/x" })).status, 400);
  assert.equal((await call("POST", "/push/subscribe", ADMIN(), { endpoint: EP })).status, 200);
  assert.equal((await call("POST", "/push/subscribe", ADMIN(), { endpoint: EP })).status, 200);
  assert.equal(setting(db, "push_subscriptions").list.length, 1, "o mesmo aparelho não duplica");
  const t = await call("POST", "/push/test", ADMIN());
  assert.deepEqual([t.status, t.body.sent], [200, 1]);
  assert.equal(sent[0].url, EP);
  assert.equal((await call("POST", "/push/inbox", null, { endpoint: "https://web.push.apple.com/outro" })).status, 404, "endpoint desconhecido não lê nada");
  const inbox = await call("POST", "/push/inbox", null, { endpoint: EP });
  assert.equal(inbox.status, 200);
  assert.equal(inbox.body.messages.length, 1);
  assert.equal(inbox.body.messages[0].title, "🔔 Teste da PMS");
  assert.deepEqual((await call("POST", "/push/inbox", null, { endpoint: EP })).body.messages, [], "lida uma vez só");
  assert.ok(db.tables.audit_log.some(a => a.action === "push.ativar"));
}));

test("aparelho que sumiu (410) é removido; desativar apaga a assinatura e a caixa", withKeys(async () => {
  const db = seed();
  await call("POST", "/push/subscribe", ADMIN(), { endpoint: EP });
  await call("POST", "/push/subscribe", ADMIN(), { endpoint: EP + "-2" });
  pushRecorder((u) => u === EP ? 410 : 201);
  const t = await call("POST", "/push/test", ADMIN());
  assert.deepEqual([t.body.sent, t.body.removed], [1, 1]);
  assert.deepEqual(setting(db, "push_subscriptions").list.map(s => s.endpoint), [EP + "-2"]);
  await call("POST", "/push/unsubscribe", ADMIN(), { endpoint: EP + "-2" });
  assert.deepEqual(setting(db, "push_subscriptions").list, []);
  assert.equal(db.tables.settings.filter(s => s.key.startsWith("push_inbox:")).length, 1, "só a caixa do aparelho removido por 410 fica (vazia de uso)");
}));

// ── ponta a ponta com a sincronização ────────────────────────────────────────
const URL_22 = "https://www.airbnb.com.br/calendar/ical/ficticio-22.ics";
const ics = (uid, ci, co) => ["BEGIN:VCALENDAR", "BEGIN:VEVENT", `UID:${uid}`, `DTSTART;VALUE=DATE:${ci.replace(/-/g, "")}`,
  `DTEND;VALUE=DATE:${co.replace(/-/g, "")}`, "SUMMARY:Reserved", "END:VEVENT", "END:VCALENDAR"].join("\n");

test("sincronização: conflito novo avisa uma vez; repetido não; resolvido e de volta avisa de novo", withKeys(async () => {
  const db = seed({
    reservations: [{ id: "d1", room_id: "22", source: "direto", guest_name: "Hóspede Fictício", check_in: "2099-12-04", check_out: "2099-12-06", status: "confirmed" }],
    settings: [{ key: "ical_urls", value: { airbnb: { "22": URL_22 }, booking: {} } }],
  });
  await call("POST", "/push/subscribe", ADMIN(), { endpoint: EP });
  const sent = pushRecorder();
  _resetIcalStateForTests();
  await runSync({ fetcher: async () => ics("A1", "2099-12-02", "2099-12-06") });
  assert.equal(sent.length, 1);
  const msg = (await call("POST", "/push/inbox", null, { endpoint: EP })).body.messages;
  assert.equal(msg[0].body, "Airbnb quarto 22: 02/12 → 06/12 já está ocupado na PMS. Confira na plataforma.");
  assert.doesNotMatch(JSON.stringify(msg), /Fictício/);
  await runSync({ fetcher: async () => ics("A1", "2099-12-02", "2099-12-06") });
  assert.equal(sent.length, 1, "não repete");
  await runSync({ fetcher: async () => "BEGIN:VCALENDAR\nEND:VCALENDAR" });
  await runSync({ fetcher: async () => ics("A1", "2099-12-02", "2099-12-06") });
  assert.equal(sent.length, 2, "voltou: avisa de novo");
}));

test("sincronização sem conflito ou sem aparelho: nenhum push", withKeys(async () => {
  seed({ settings: [{ key: "ical_urls", value: { airbnb: { "22": URL_22 }, booking: {} } }] });
  const sent = pushRecorder();
  _resetIcalStateForTests();
  await runSync({ fetcher: async () => ics("B1", "2099-11-02", "2099-11-03") });
  assert.equal(sent.length, 0);
}));

// ── tela ─────────────────────────────────────────────────────────────────────
const { loadFrontend } = require("./helpers/frontend-harness");
function tela(cfg, { standalone = true, subscribed = false, supported = true } = {}) {
  const fe = loadFrontend({ routes: [{ method: "GET", path: "/push/config", reply: () => ({ status: 200, json: cfg }) }] });
  const sub = subscribed ? { endpoint: EP } : null;
  fe.context.navigator = supported ? { standalone, serviceWorker: { getRegistration: async () => ({ pushManager: { getSubscription: async () => sub } }) } } : {};
  fe.context.window = supported ? { PushManager: function () {}, Notification: {}, matchMedia: () => ({ matches: standalone }) } : {};
  fe.run(`authRole = "admin"`);
  return fe;
}

test("tela: no iPhone fora do ícone pede para abrir pelo ícone; sem suporte idem", async () => {
  let fe = tela({ enabled: true, publicKey: KEYS.publicKey }, { standalone: false });
  await fe.run("loadPushState()");
  assert.match(fe.run("pushCardHtml()"), /abra a PMS pelo ícone da tela de início/);
  fe = tela({ enabled: true, publicKey: KEYS.publicKey }, { supported: false });
  await fe.run("loadPushState()");
  assert.match(fe.run("pushCardHtml()"), /abra a PMS pelo ícone/);
  assert.doesNotMatch(fe.run("pushCardHtml()"), /Ativar avisos/);
});

test("tela: servidor sem chaves, ativar, ativo (teste/desativar); só admin vê", async () => {
  let fe = tela({ enabled: false, publicKey: null });
  await fe.run("loadPushState()");
  assert.match(fe.run("pushCardHtml()"), /ainda não configurados no servidor/);
  fe = tela({ enabled: true, publicKey: KEYS.publicKey });
  await fe.run("loadPushState()");
  assert.match(fe.run("pushCardHtml()"), /onclick="enablePush\(\)">Ativar avisos/);
  assert.match(fe.run("pushCardHtml()"), /sem dados de hóspede/);
  fe = tela({ enabled: true, publicKey: KEYS.publicKey }, { subscribed: true });
  await fe.run("loadPushState()");
  const h = fe.run("pushCardHtml()");
  assert.match(h, /Ativos neste aparelho/);
  assert.match(h, /testPush\(\)/);
  assert.match(h, /disablePush\(\)/);
  fe.run(`reservations = []; prereservations = [];`);
  assert.match(fe.run("renderAlertas()"), /Avisos no celular/);
  fe.run(`authRole = "staff"`);
  assert.doesNotMatch(fe.run("renderAlertas()"), /Avisos no celular/);
});

test("tela: chave pública base64url vira os bytes certos para o navegador", () => {
  const fe = loadFrontend({});
  fe.context.atob = (s) => Buffer.from(s, "base64").toString("binary");
  const bytes = JSON.parse(fe.run(`JSON.stringify(Array.from(b64uToBytes(${JSON.stringify(KEYS.publicKey)})))`));
  assert.deepEqual(bytes, Array.from(wp.fromB64u(KEYS.publicKey)));
  assert.equal(bytes.length, 65);
});

test("chaves do Render que não formam par: avisos ficam desligados (não envia com assinatura inválida)", quiet(async () => {
  seed();
  process.env.VAPID_PUBLIC_KEY = wp.generateVapidKeys().publicKey; process.env.VAPID_PRIVATE_KEY = KEYS.privateKey;
  try { assert.deepEqual((await call("GET", "/push/config", ADMIN())).body, { enabled: false, publicKey: null }); }
  finally { delete process.env.VAPID_PUBLIC_KEY; delete process.env.VAPID_PRIVATE_KEY; }
}));

// ── calendário parado ────────────────────────────────────────────────────────
const H = 3600 * 1000;
const NOW = Date.UTC(2030, 0, 10, 12);
const iso = (ms) => new Date(ms).toISOString();
const status = (feeds) => ({ lastRunAt: iso(NOW - 60000), feeds });

test("parado: avisa depois de 1 h sem sucesso, uma vez, com o motivo; antes de 1 h não", () => {
  const st = status({ "airbnb/22": { problem: "HTTP 503", lastSuccessAt: iso(NOW - 2 * H), conflicts: [] },
                      "booking/20": { problem: "HTTP 503", lastSuccessAt: iso(NOW - 0.5 * H), conflicts: [] } });
  const d1 = pa.diffAlerts(st, NOW, []);
  assert.deepEqual(d1.messages, [{ title: "⚠️ Calendário parado",
    body: "Airbnb quarto 22 sem atualizar há mais de 1 h (HTTP 503). Reservas novas desse anúncio podem não estar na PMS: confira na plataforma." }]);
  assert.deepEqual(d1.notified, ["stale|airbnb/22"]);
  assert.deepEqual(pa.diffAlerts(st, NOW, d1.notified).messages, [], "não repete");
});

test("parado com conflito: só o aviso de conflito (não dois avisos para a mesma coisa)", () => {
  const st = status({ "airbnb/22": { problem: "conflito com outra reserva", lastSuccessAt: iso(NOW - 3 * H),
    conflicts: [{ room: "22", checkIn: "2030-02-02", checkOut: "2030-02-04" }] } });
  const d = pa.diffAlerts(st, NOW, []);
  assert.equal(d.messages.length, 1);
  assert.equal(d.messages[0].title, "⚠️ Possível overbooking");
});

test("voltou: avisa que normalizou; calendário removido da configuração não avisa", () => {
  const ok = status({ "airbnb/22": { problem: null, lastSuccessAt: iso(NOW - 60000), conflicts: [] } });
  assert.deepEqual(pa.diffAlerts(ok, NOW, ["stale|airbnb/22"]).messages,
    [{ title: "✅ Calendário voltou", body: "Airbnb quarto 22 voltou a atualizar normalmente." }]);
  assert.deepEqual(pa.diffAlerts(ok, NOW, ["stale|airbnb/22"]).notified, []);
  assert.deepEqual(pa.diffAlerts(status({}), NOW, ["stale|airbnb/CF"]).messages, []);
  const aindaFalhando = status({ "airbnb/22": { problem: "HTTP 503", lastSuccessAt: iso(NOW - 0.2 * H), conflicts: [] } });
  assert.deepEqual(pa.diffAlerts(aindaFalhando, NOW, ["stale|airbnb/22"]).messages, [], "sem problema resolvido, não diz que voltou");
});

test("Casa Fechada e suíte com nome amigável; sincronização que nunca rodou não avisa", () => {
  assert.match(pa.staleMessage({ feed: "airbnb/CF", problem: null }).body, /^Airbnb Casa Fechada sem atualizar há mais de 1 h\. /);
  assert.match(pa.staleMessage({ feed: "airbnb/11+12", problem: "tempo esgotado" }).body, /^Airbnb Suíte 11\+12 .*\(tempo esgotado\)/);
  assert.deepEqual(pa.diffAlerts(null, NOW, []).messages, []);
  assert.deepEqual(pa.diffAlerts({ feeds: { "airbnb/22": { problem: null, lastSuccessAt: null, conflicts: [] } } }, NOW, []).messages, [],
    "status sem nenhuma passada registrada não é 'parado'");
});

test("ponta a ponta: calendário falhando há mais de 1 h vira aviso no celular uma vez", withKeys(async () => {
  const db = seed({ settings: [{ key: "ical_urls", value: { airbnb: { "22": URL_22 }, booking: {} } },
    { key: "ical_sync_status", value: { lastRunAt: iso(Date.now() - 20 * 60000),
      feeds: { "airbnb/22": { ok: false, problem: "HTTP 503", lastSuccessAt: iso(Date.now() - 2 * H), lastAttemptAt: iso(Date.now() - 20 * 60000), events: 0, conflicts: [] } } } }] });
  await call("POST", "/push/subscribe", ADMIN(), { endpoint: EP });
  const sent = pushRecorder();
  _resetIcalStateForTests();
  await runSync({ fetcher: async () => { throw new Error("HTTP 503"); } });
  assert.equal(sent.length, 1);
  const m = (await call("POST", "/push/inbox", null, { endpoint: EP })).body.messages;
  assert.equal(m[0].title, "⚠️ Calendário parado");
  await runSync({ fetcher: async () => { throw new Error("HTTP 503"); } });
  assert.equal(sent.length, 1, "não repete");
  await runSync({ fetcher: async () => "BEGIN:VCALENDAR\nEND:VCALENDAR" });
  assert.equal(sent.length, 2);
  assert.equal((await call("POST", "/push/inbox", null, { endpoint: EP })).body.messages[0].title, "✅ Calendário voltou");
  assert.deepEqual(setting(db, "push_notified").keys, []);
}));

test("VAPID: chave privada que começa com byte zero (1 em 256) funciona, gerada ou já salva com 31 bytes", () => {
  const crypto2 = require("crypto");
  let ecdh;
  do { ecdh = crypto2.createECDH("prime256v1"); ecdh.generateKeys(); } while (ecdh.getPrivateKey()[0] !== 0 && ecdh.getPrivateKey().length === 32);
  const pub = wp.b64u(ecdh.getPublicKey());
  const curta = wp.b64u(ecdh.getPrivateKey().subarray(ecdh.getPrivateKey().length - 31));
  const cheia = wp.b64u(Buffer.concat([Buffer.alloc(1), ecdh.getPrivateKey().subarray(ecdh.getPrivateKey().length - 31)]));
  assert.equal(wp.vapidKeysValid(pub, curta), true);
  assert.equal(wp.vapidKeysValid(pub, cheia), true);
  assert.match(wp.vapidAuthorization(EP, { publicKey: pub, privateKey: curta, subject: "s" }), /^vapid t=/);
  for (let i = 0; i < 600; i++) { const k = wp.generateVapidKeys(); assert.equal(wp.fromB64u(k.privateKey).length, 32); }
});

// ── reserva cancelada pela sincronização ─────────────────────────────────────
test("cancelada pela sincronização: aviso com canal, quarto e datas; bloqueio do Airbnb não avisa; grupo vira 1", () => {
  assert.deepEqual(pa.cancelledMessages([{ id: "a", room_id: "20", source: "booking", guest_name: "CLOSED - Not available", check_in: "2026-11-25", check_out: "2026-11-26" }], "booking", "20"),
    [{ title: "❌ Reserva saiu do calendário", body: "Booking quarto 20: 25/11 → 26/11 sumiu do calendário e foi cancelada na PMS. Confira na plataforma se foi cancelada mesmo; se ela voltar, a PMS reativa sozinha." }]);
  assert.deepEqual(pa.cancelledMessages([{ id: "b", room_id: "22", source: "airbnb", guest_name: "Airbnb (Not available)", check_in: "2026-12-02", check_out: "2026-12-04" }], "airbnb", "22"), []);
  const cf = ["10", "11", "20"].map(r => ({ id: "c" + r, room_id: r, source: "airbnb", guest_name: "Reserved", group_id: "cf:x", check_in: "2026-12-04", check_out: "2026-12-06" }));
  const m = pa.cancelledMessages(cf, "airbnb", "CF");
  assert.equal(m.length, 1);
  assert.match(m[0].body, /^Airbnb Casa Fechada: 04\/12 → 06\/12/);
  assert.doesNotMatch(JSON.stringify(pa.cancelledMessages([{ id: "d", room_id: "21", source: "airbnb", guest_name: "Hóspede Fictício", check_in: "2026-12-01", check_out: "2026-12-02" }], "airbnb", "21")), /Fictício/);
});

test("ponta a ponta: reserva some 2 leituras → cancelada e aviso no celular uma vez", withKeys(async () => {
  const URL_B20 = "https://ical.booking.com/ficticio-20.ics";
  const ev = (uid, ci, co) => ["BEGIN:VEVENT", `UID:${uid}`, `DTSTART;VALUE=DATE:${ci.replace(/-/g, "")}`, `DTEND;VALUE=DATE:${co.replace(/-/g, "")}`, "SUMMARY:CLOSED - Not available", "END:VEVENT"];
  const cal = (...e) => ["BEGIN:VCALENDAR", ...e.flat(), "END:VCALENDAR"].join("\n");
  seed({ settings: [{ key: "ical_urls", value: { airbnb: {}, booking: { "20": URL_B20 } } }] });
  await call("POST", "/push/subscribe", ADMIN(), { endpoint: EP });
  const sent = pushRecorder();
  const prev = process.env.ICAL_RECONCILE; process.env.ICAL_RECONCILE = "apply";
  try {
    _resetIcalStateForTests();
    await runSync({ fetcher: async () => cal(ev("R1", "2099-11-25", "2099-11-26"), ev("R2", "2099-12-01", "2099-12-02")) });
    await runSync({ fetcher: async () => cal(ev("R2", "2099-12-01", "2099-12-02")) });
    assert.equal(sent.length, 0, "uma leitura sem a reserva ainda não cancela nem avisa");
    await runSync({ fetcher: async () => cal(ev("R2", "2099-12-01", "2099-12-02")) });
    assert.equal(sent.length, 1);
    const msgs = (await call("POST", "/push/inbox", null, { endpoint: EP })).body.messages;
    assert.equal(msgs[0].title, "❌ Reserva saiu do calendário");
    assert.match(msgs[0].body, /^Booking quarto 20: 25\/11 → 26\/11/);
    await runSync({ fetcher: async () => cal(ev("R2", "2099-12-01", "2099-12-02")) });
    assert.equal(sent.length, 1, "não repete");
  } finally { if (prev === undefined) delete process.env.ICAL_RECONCILE; else process.env.ICAL_RECONCILE = prev; }
}));
