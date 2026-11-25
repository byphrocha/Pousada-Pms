// Lê a tela como o navegador recebe: build/index.html + os arquivos que ele
// referencia (css/*.css e js/*.js), na ordem em que aparecem (PMS-017).
"use strict";
const fs = require("fs");
const path = require("path");
const BUILD = path.join(__dirname, "../../build");

function readLocal(ref) {
  if (/^(https?:)?\/\//.test(ref)) throw new Error(`referência externa não esperada: ${ref}`);
  return fs.readFileSync(path.join(BUILD, ref.replace(/^\//, "")), "utf8");
}

// Scripts na ordem do documento: { file, code } (inline ou src).
function scripts() {
  const html = fs.readFileSync(path.join(BUILD, "index.html"), "utf8");
  const out = [];
  for (const m of html.matchAll(/<script(?:\s+src="([^"]+)")?\s*>([\s\S]*?)<\/script>/g)) {
    if (m[1]) out.push({ file: m[1], code: readLocal(m[1]) });
    else if (m[2].trim()) out.push({ file: "index.html", code: m[2] });
  }
  return out;
}

// Página inteira com CSS e scripts embutidos, para testes que procuram texto.
function fullPage() {
  const html = fs.readFileSync(path.join(BUILD, "index.html"), "utf8");
  return html
    .replace(/<link rel="stylesheet" href="([^"]+)">/g, (_, f) => `<style>\n${readLocal(f)}</style>`)
    .replace(/<script src="([^"]+)"><\/script>/g, (_, f) => `<script>\n${readLocal(f)}</script>`);
}

module.exports = { scripts, fullPage, BUILD };
