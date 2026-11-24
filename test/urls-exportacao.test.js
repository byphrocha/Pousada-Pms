// PMS-012: o cartão "Exportar calendário" ficava em "Carregando URLs…" para sempre,
// porque a tela nunca buscava /calendar-urls. Agora há estado explícito e todo erro
// aparece. Dados fictícios; nenhum token real.
"use strict";
process.env.JWT_SECRET = "segredo-so-de-teste";
process.env.SUPABASE_URL = "http://127.0.0.1:9";
process.env.SUPABASE_KEY = "chave-falsa";
delete process.env.CALENDAR_TOKEN;
const test = require("node:test");
const assert = require("node:assert/strict");
const { loadFrontend } = require("./helpers/frontend-harness");

const rota = (status, json) => [{ method: "GET", path: "/calendar-urls", reply: () => ({ status, json }) }];

test("tela: sem CALENDAR_TOKEN mostra aviso claro em vez de 'Carregando' eterno", async () => {
  const fe = loadFrontend({ routes: rota(503, { code: "CALENDAR_TOKEN_MISSING", error: "x" }) });
  fe.run(`authRole = "admin"; authToken = "t";`);
  await fe.run("loadCalUrls()");
  const html = fe.run("renderCalUrls()");
  assert.doesNotMatch(html, /Carregando/);
  assert.match(html, /falta a variável CALENDAR_TOKEN/);
  assert.match(html, /continuam funcionando/);
  assert.match(html, /Tentar de novo/);
});

test("tela: erro de conexão também aparece (nada silencioso)", async () => {
  const fe = loadFrontend({ routes: [{ method: "GET", path: "/calendar-urls", reply: () => { throw new Error("rede"); } }] });
  fe.run(`authToken = "t";`);
  await fe.run("loadCalUrls()");
  assert.match(fe.run("renderCalUrls()"), /Erro de conexão/);
});

test("tela: com URLs lista os quartos e escapa o conteúdo", async () => {
  const fe = loadFrontend({ routes: rota(200, { urls: { "20": "https://exemplo.test/c/TOKEN-FICTICIO/20.ics", CF: "https://exemplo.test/c/x/CF.ics\"><b>" } }) });
  fe.run(`authToken = "t";`);
  await fe.run("loadCalUrls()");
  const html = fe.run("renderCalUrls()");
  assert.match(html, /Qto 20/);
  assert.match(html, /TOKEN-FICTICIO\/20\.ics/);
  assert.doesNotMatch(html, /"><b>/);
});

test("tela: primeira renderização dispara a busca uma vez só; sair e voltar busca de novo", async () => {
  const fe = loadFrontend({ routes: rota(200, { urls: { "10": "https://exemplo.test/10.ics" } }) });
  fe.run(`authToken = "t";`);
  assert.match(fe.run("renderCalUrls()"), /Carregando/);
  fe.run("renderCalUrls()"); // enquanto carrega, não duplica a chamada
  await new Promise(r => setImmediate(r));
  assert.equal(fe.calls.filter(c => c.path === "/calendar-urls").length, 1);
  assert.match(fe.run("renderCalUrls()"), /Qto 10/);
  fe.run(`showView("map"); showView("sync");`);
  await new Promise(r => setImmediate(r));
  fe.run("renderCalUrls()");
  await new Promise(r => setImmediate(r));
  assert.equal(fe.calls.filter(c => c.path === "/calendar-urls").length, 2);
});

test("servidor: sem CALENDAR_TOKEN responde 503 com código estável", async () => {
  const { app, _setSupabaseForTests } = require("../server");
  const { createFakeSupabase } = require("./helpers/fake-supabase");
  const { ADMIN } = require("./helpers/auth");
  _setSupabaseForTests(createFakeSupabase({}));
  const srv = app.listen(0);
  try {
    const port = srv.address().port;
    const r = await fetch(`http://127.0.0.1:${port}/calendar-urls`, { headers: { Authorization: ADMIN() } });
    assert.equal(r.status, 503);
    const body = await r.json();
    assert.equal(body.code, "CALENDAR_TOKEN_MISSING");
  } finally { srv.close(); }
});

// PMS-010 passo 2: a tela mostra um link por anúncio de cada plataforma.
const CANAIS = {
  urls: { "20": "https://exemplo.test/calendar/T/20.ics" },
  channels: {
    booking: { "20": "https://exemplo.test/calendar/TOKEN-FICTICIO/booking/20.ics" },
    airbnb: { CF: "https://exemplo.test/calendar/TOKEN-FICTICIO/airbnb/CF.ics", "11+12": "https://exemplo.test/calendar/TOKEN-FICTICIO/airbnb/11%2B12.ics\"><b>" },
  },
};

test("tela: links por plataforma, com nomes amigáveis, escapados e aviso da regra 3", async () => {
  const fe = loadFrontend({ routes: rota(200, CANAIS) });
  fe.run(`authToken = "t";`);
  await fe.run("loadCalUrls()");
  const html = fe.run("renderCalUrls()");
  const booking = html.indexOf("Para colar no Booking"), airbnb = html.indexOf("Para colar no Airbnb");
  assert.ok(booking >= 0 && airbnb > booking);
  assert.match(html.slice(booking, airbnb), /Quarto 20[\s\S]*booking\/20\.ics/);
  assert.doesNotMatch(html.slice(booking, airbnb), /airbnb\//);
  const doAirbnb = html.slice(airbnb, html.indexOf("<details"));
  assert.match(doAirbnb, /Casa Fechada[\s\S]*airbnb\/CF\.ics/);
  assert.match(doAirbnb, /Suíte 11\+12/);
  assert.doesNotMatch(html, /"><b>/);
  assert.match(html, /Não troque links já cadastrados/);
});

test("tela: links gerais ficam recolhidos, com aviso de não usar em anúncio", async () => {
  const fe = loadFrontend({ routes: rota(200, CANAIS) });
  fe.run(`authToken = "t";`);
  await fe.run("loadCalUrls()");
  const html = fe.run("renderCalUrls()");
  const det = html.slice(html.indexOf("<details"));
  assert.ok(html.indexOf("<details") > html.indexOf("Para colar no Airbnb"));
  assert.match(det, /Qto 20[\s\S]*calendar\/T\/20\.ics/);
  assert.match(det, /Não cole estes links num anúncio/);
});

test("tela: plataforma sem anúncio cadastrado diz o que fazer", async () => {
  const fe = loadFrontend({ routes: rota(200, { urls: {}, channels: { booking: {}, airbnb: { "21": "https://exemplo.test/a/21.ics" } } }) });
  fe.run(`authToken = "t";`);
  await fe.run("loadCalUrls()");
  const html = fe.run("renderCalUrls()");
  assert.match(html.slice(html.indexOf("Para colar no Booking"), html.indexOf("Para colar no Airbnb")), /Nenhum anúncio desta plataforma cadastrado em Sincronizar/);
  assert.match(html, /Quarto 21/);
  assert.doesNotMatch(html, /<details/);
});

test("tela: nome de anúncio vindo do servidor também é escapado", async () => {
  const fe = loadFrontend({ routes: rota(200, { urls: {}, channels: { booking: { "<img src=x>": "https://exemplo.test/b.ics" }, airbnb: {} } }) });
  fe.run(`authToken = "t";`);
  await fe.run("loadCalUrls()");
  const html = fe.run("renderCalUrls()");
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /&lt;img/);
});
