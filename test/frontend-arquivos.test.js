// PMS-017: a tela é index.html + css/app.css + js/NN-*.js. O servidor entrega
// cada arquivo com o tipo certo, sem cache velho, e 404 para o que não existe.
"use strict";
process.env.JWT_SECRET = "segredo-so-de-teste";
process.env.SUPABASE_URL = "http://127.0.0.1:9";
process.env.SUPABASE_KEY = "chave-falsa";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { app } = require("../server");
const src = require("./helpers/frontend-source");

let server, base;
test.before(async () => { server = app.listen(0); await new Promise(r => server.once("listening", r)); base = `http://127.0.0.1:${server.address().port}`; });
test.after(() => server.close());

test("cada arquivo referenciado existe e é servido com o tipo certo, revalidando sempre", async () => {
  const html = fs.readFileSync(path.join(src.BUILD, "index.html"), "utf8");
  const refs = [...html.matchAll(/(?:src|href)="((?:js|css)\/[^"]+)"/g)].map(m => m[1]);
  assert.ok(refs.length >= 16);
  for (const ref of refs) {
    const r = await fetch(`${base}/${ref}`);
    assert.equal(r.status, 200, ref);
    assert.match(r.headers.get("content-type"), ref.endsWith(".css") ? /text\/css/ : /javascript/, ref);
    assert.match(r.headers.get("cache-control") || "", /max-age=0/, ref);
  }
});

test("arquivo de tela inexistente → 404 (não a página no lugar)", async () => {
  for (const p of ["/js/99-nao-existe.js", "/css/nao.css", "/icons/nao.png"]) {
    const r = await fetch(base + p);
    assert.equal(r.status, 404, p);
    assert.doesNotMatch(await r.text(), /<html/i);
  }
  assert.equal((await fetch(base + "/qualquer-rota")).status, 200, "rotas da tela continuam caindo na página");
});

test("todo arquivo js da pasta está na página (nenhum esquecido), em ordem numérica", () => {
  const onDisk = fs.readdirSync(path.join(src.BUILD, "js")).filter(f => f.endsWith(".js")).sort();
  const inPage = src.scripts().map(s => s.file.replace(/^js\//, ""));
  assert.deepEqual(inPage, onDisk);
});

test("nenhum script inline sobrou no index.html (tudo em arquivos)", () => {
  const html = fs.readFileSync(path.join(src.BUILD, "index.html"), "utf8");
  assert.equal([...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].filter(m => m[1].trim()).length, 0);
  assert.doesNotMatch(html, /<style>/);
});
