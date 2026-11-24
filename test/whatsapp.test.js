// PMS-021: modelos de mensagem de WhatsApp. Nada é enviado pelo servidor;
// a tela preenche o modelo, a pessoa revisa e abre o WhatsApp.
// Dados fictícios (telefone inventado, nome de teste).
"use strict";
process.env.JWT_SECRET = "segredo-so-de-teste";
process.env.SUPABASE_URL = "http://127.0.0.1:9";
process.env.SUPABASE_KEY = "chave-falsa";

const test = require("node:test");
const assert = require("node:assert/strict");
const messages = require("../lib/messages");
const { app, _setSupabaseForTests } = require("../server");
const { createFakeSupabase } = require("./helpers/fake-supabase");
const { ADMIN, STAFF } = require("./helpers/auth");
const { loadFrontend } = require("./helpers/frontend-harness");

let server, base;
test.before(async () => { server = app.listen(0); await new Promise(r => server.once("listening", r)); base = `http://127.0.0.1:${server.address().port}`; });
test.after(() => server.close());
const call = (method, p, auth, body) => fetch(base + p, { method, headers: { "Content-Type": "application/json", Authorization: auth },
  body: body ? JSON.stringify(body) : undefined }).then(async r => ({ status: r.status, body: await r.json().catch(() => null) }));
const seed = (settings = []) => { const db = createFakeSupabase({ settings }); _setSupabaseForTests(db); return db; };

// ── Regras puras ────────────────────────────────────────────────────────────
test("validação: título/texto obrigatórios, limites e ids únicos", () => {
  assert.ok(messages.sanitizeTemplates("x").error);
  assert.ok(messages.sanitizeTemplates([]).error);
  assert.ok(messages.sanitizeTemplates([{ title: "", body: "a" }]).error);
  assert.ok(messages.sanitizeTemplates([{ title: "a", body: "  " }]).error);
  assert.ok(messages.sanitizeTemplates([{ title: "a", body: "x".repeat(2001) }]).error);
  assert.ok(messages.sanitizeTemplates(Array.from({ length: 13 }, () => ({ title: "a", body: "b" }))).error);
  const ok = messages.sanitizeTemplates([{ id: "A B!", title: " Um ", body: " oi " }, { id: "ab", title: "Dois", body: "oi" }]);
  assert.deepEqual(ok.templates.map(t => [t.id, t.title, t.body]), [["ab", "Um", "oi"], ["ab-2", "Dois", "oi"]]);
});

test("modelo com {valor} ou {saldo} vira só-admin, mesmo marcado como público", () => {
  const r = messages.sanitizeTemplates([{ title: "Cobrança", body: "Saldo {saldo}", admin: false }, { title: "Oi", body: "Olá {nome}" }]);
  assert.deepEqual(r.templates.map(t => t.admin), [true, false]);
  assert.deepEqual(messages.templatesForRole(r.templates, "staff").map(t => t.title), ["Oi"]);
  assert.equal(messages.templatesForRole(null, "admin").length, messages.DEFAULT_TEMPLATES.length);
  assert.ok(messages.templatesForRole(null, "staff").every(t => !/\{(valor|saldo)\}/.test(t.body)));
});

// ── Rotas ───────────────────────────────────────────────────────────────────
test("rota: sem modelos salvos devolve os iniciais; funcionário não recebe o de saldo", async () => {
  seed();
  const a = await call("GET", "/message-templates", ADMIN());
  assert.equal(a.status, 200);
  assert.equal(a.body.custom, false);
  assert.ok(a.body.templates.some(t => t.id === "saldo"));
  const s = await call("GET", "/message-templates", STAFF());
  assert.equal(s.status, 200);
  assert.ok(!s.body.templates.some(t => t.id === "saldo" || /\{(valor|saldo)\}/.test(t.body)));
});

test("rota: admin salva; texto inválido dá 400 sem gravar; funcionário recebe 403", async () => {
  const db = seed([{ key: "ical_urls", value: { airbnb: {}, booking: {} } }]);
  assert.equal((await call("PUT", "/message-templates", STAFF(), { templates: [{ title: "X", body: "Y" }] })).status, 403);
  const bad = await call("PUT", "/message-templates", ADMIN(), { templates: [{ title: "Sem texto", body: "" }] });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /sem texto/);
  const ok = await call("PUT", "/message-templates", ADMIN(), { templates: [{ title: "Chegada", body: "Olá, {nome}! Check-in a partir das [hora]." }] });
  assert.equal(ok.status, 200);
  const g = await call("GET", "/message-templates", STAFF());
  assert.equal(g.body.custom, true);
  assert.deepEqual(g.body.templates.map(t => t.title), ["Chegada"]);
  assert.ok(db.tables.settings.some(r => r.key === "ical_urls"), "não apaga outras configurações");
});

// ── Tela ────────────────────────────────────────────────────────────────────
test("telefone: DDD sem 55 ganha 55; com 55 mantém; + internacional; inválido vazio", () => {
  const fe = loadFrontend({});
  const p = (x) => fe.run(`waPhone(${JSON.stringify(x)})`);
  assert.equal(p("(44) 90000-0000"), "5544900000000");
  assert.equal(p("44 3000-0000"), "554430000000");
  assert.equal(p("+55 44 90000-0000"), "5544900000000");
  assert.equal(p("55 44 90000-0000"), "5544900000000");
  assert.equal(p("+1 555 000 0000"), "15550000000");
  assert.equal(p("9000-0000"), "");
  assert.equal(p(""), "");
  assert.equal(fe.run(`waLink("(44) 90000-0000", "Olá & até já")`), "https://wa.me/5544900000000?text=Ol%C3%A1%20%26%20at%C3%A9%20j%C3%A1");
  assert.equal(fe.run(`waLink("123", "x")`), "");
});

test("preenche nome (primeiro), quarto, datas e noites; sem nome some a vírgula", () => {
  const fe = loadFrontend({});
  fe.run(`authRole = "staff";`);
  const r = { id: "r1", roomId: "23", guestName: "Hóspede Teste da Silva", checkIn: "2030-03-02", checkOut: "2030-03-05", source: "direto", amount: 900, notes: "" };
  const t = fe.run(`fillTemplate("Olá, {nome}! {quarto}, de {entrada} a {saida} ({noites} noites). Total {valor}.", msgContext(${JSON.stringify(r)}))`);
  assert.equal(t, "Olá, Hóspede! quarto 23, de 02/03/2030 a 05/03/2030 (3 noites). Total [valor].");
  const sem = fe.run(`fillTemplate("Olá, {nome}! Tudo certo.", msgContext(${JSON.stringify({ ...r, guestName: "Reserved", source: "airbnb" })}))`);
  assert.equal(sem, "Olá! Tudo certo.");
  const cf = fe.run(`fillTemplate("{quarto}", msgContext(${JSON.stringify({ ...r, notes: "x [Casa toda:g1]" })}))`);
  assert.equal(cf, "Casa Fechada (pousada toda)");
});

test("valores só para admin: {valor} e {saldo} preenchidos; funcionário vê [valor]", () => {
  const fe = loadFrontend({});
  const r = { id: "r1", roomId: "20", guestName: "Hóspede Teste", checkIn: "2030-03-02", checkOut: "2030-03-04", source: "direto", amount: 1200 };
  fe.run(`authRole = "admin";`);
  const a = fe.run(`fillTemplate("{valor} / {saldo}", msgContext(${JSON.stringify(r)}, { saldo: 800 }))`);
  assert.match(a, /1\.200,00 \/ R\$\s?800,00/);
  fe.run(`authRole = "staff";`);
  assert.equal(fe.run(`fillTemplate("{valor} / {saldo}", msgContext(${JSON.stringify(r)}, { saldo: 800 }))`), "[valor] / [saldo]");
});

test("painel: abre pela reserva, escapa o texto e avisa trecho [entre colchetes]", async () => {
  const fe = loadFrontend({ routes: [{ method: "GET", path: "/message-templates", reply: () => ({ status: 200, json: { templates: [
    { id: "x", title: "Chegada <b>", body: "Olá, {nome}! Check-in [hora]. </textarea><img src=x>" }], custom: true } }) }] });
  fe.run(`authRole = "staff"; authToken = "t"; reservations = ${JSON.stringify([{ id: "r1", roomId: "20", guestName: "Hóspede Teste", checkIn: "2030-03-02", checkOut: "2030-03-04", source: "direto", phone: "(44) 90000-0000" }])};`);
  const html = fe.run(`reservationForm(reservations[0], true)`);
  assert.match(html, /toggleWhatsApp\('r1'\)/);
  assert.doesNotMatch(fe.run(`reservationForm(reservations[0], false)`), /toggleWhatsApp/, "reserva nova ainda não tem o botão");
  assert.doesNotMatch(html, /\[saldo\]|Editar modelos/);
  await fe.run(`loadMsgTemplates()`);
  const box = fe.run(`waBoxHtml(reservations[0], msgTemplates, "x", null, "(44) 90000-0000")`);
  assert.doesNotMatch(box, /<img src=x>|<b>/, "texto e título escapados");
  assert.match(box, /&lt;\/textarea&gt;&lt;img src=x&gt;/);
  assert.match(box, /Olá, Hóspede! Check-in \[hora\]/);
  assert.match(box, /trechos \[entre colchetes\] para completar/);
  assert.doesNotMatch(box, /Editar modelos/, "funcionário não edita modelos");
  assert.doesNotMatch(box, /btn-green" disabled/);
  const semTel = fe.run(`waBoxHtml(reservations[0], msgTemplates, "x", null, "123")`);
  assert.match(semTel, /Telefone ausente ou inválido/);
  assert.match(semTel, /btn-green" disabled/);
  fe.run(`authRole = "admin";`);
  assert.match(fe.run(`waBoxHtml(reservations[0], msgTemplates, "x", null, "(44) 90000-0000")`), /Editar modelos/);
});
