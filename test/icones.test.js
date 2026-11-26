"use strict";
// Ícones do app: cada arquivo citado no manifesto e no index.html existe,
// é PNG e tem o tamanho declarado. Lê só o cabeçalho IHDR (sem dependências).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const BUILD = path.join(__dirname, "..", "build");

function pngSize(file) {
  const buf = fs.readFileSync(file);
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.ok(buf.subarray(0, 8).equals(sig), `${file} não é PNG`);
  assert.equal(buf.toString("ascii", 12, 16), "IHDR");
  return `${buf.readUInt32BE(16)}x${buf.readUInt32BE(20)}`;
}

test("ícones do manifesto existem com o tamanho declarado", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(BUILD, "manifest.webmanifest"), "utf8"));
  assert.ok(manifest.icons.length >= 3);
  for (const icon of manifest.icons) {
    const file = path.join(BUILD, icon.src.replace(/^\//, ""));
    assert.ok(fs.existsSync(file), `falta ${icon.src}`);
    assert.equal(pngSize(file), icon.sizes, icon.src);
  }
  assert.ok(manifest.icons.some((i) => i.purpose === "maskable"), "falta ícone maskable");
});

test("apple-touch-icon do index.html existe e tem 180x180", () => {
  const html = fs.readFileSync(path.join(BUILD, "index.html"), "utf8");
  const m = html.match(/rel="apple-touch-icon"\s+href="([^"]+)"/);
  assert.ok(m, "index.html sem apple-touch-icon");
  assert.equal(pngSize(path.join(BUILD, m[1].replace(/^\//, ""))), "180x180");
});

test("fonte SVG dos ícones está no repositório", () => {
  for (const f of ["icone.svg", "icone-maskable.svg"]) {
    const svg = fs.readFileSync(path.join(__dirname, "..", "assets", f), "utf8");
    assert.match(svg, /viewBox="0 0 1024 1024"/);
  }
});
