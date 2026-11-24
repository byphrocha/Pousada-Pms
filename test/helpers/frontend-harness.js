// Carrega o <script> de build/index.html num contexto isolado (node:vm), com DOM,
// localStorage e fetch simulados. Permite testar funções do frontend sem navegador.
// Só para testes: nenhum dado real, nenhuma rede.
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");

// Objeto "aceita tudo": qualquer propriedade é outro objeto igual, qualquer chamada
// retorna outro objeto igual. Cobre o uso de DOM que não interessa ao teste.
function anything() {
  const fn = function () {};
  return new Proxy(fn, {
    get(_t, key) {
      if (key === Symbol.toPrimitive) return () => "";
      if (key === "then") return undefined; // não parecer Promise
      if (key === "length") return 0;
      return anything();
    },
    set() { return true; },
    apply() { return anything(); },
  });
}

function loadFrontend({ fields = {}, routes = [], keep = [] } = {}) {
  const html = fs.readFileSync(path.join(__dirname, "../../build/index.html"), "utf8");
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
  if (scripts.length === 0) throw new Error("Nenhum <script> inline encontrado");

  const calls = [];   // { method, path, body }
  const alerts = [];
  const store = new Map();

  const document = new Proxy({}, {
    get(_t, key) {
      if (key === "getElementById") {
        return (id) => {
          if (Object.prototype.hasOwnProperty.call(fields, id)) {
            const el = anything();
            return new Proxy(el, { get: (t, k) => (k === "value" ? fields[id] : t[k]) });
          }
          return anything();
        };
      }
      if (key === "querySelector") return () => null;
      if (key === "addEventListener") return () => {};
      return anything();
    },
  });

  async function fetch(url, opts = {}) {
    const method = opts.method || "GET";
    const body = opts.body ? JSON.parse(opts.body) : undefined;
    calls.push({ method, path: url, body });
    const route = routes.find(r => r.method === method && (typeof r.path === "string" ? r.path === url : r.path.test(url)));
    const out = route ? route.reply({ method, path: url, body, calls }) : { status: 200, json: {} };
    // out.text: resposta que não é JSON (ex.: página de erro do proxy).
    return { status: out.status, ok: out.status < 400,
      json: async () => { if (out.text !== undefined) throw new SyntaxError("Unexpected token < in JSON"); return out.json; } };
  }

  const context = vm.createContext({
    document,
    window: anything(),
    navigator: anything(),
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
    },
    fetch,
    alert: (m) => alerts.push(String(m)),
    confirm: () => true,
    console: { log() {}, warn() {}, error() {} },
    setInterval: () => 0, clearInterval() {},
    setTimeout: (f) => { return 0; }, clearTimeout() {},
    Date, Math, JSON, Promise, Array, Object, String, Number, Set, Map, RegExp, Error,
    encodeURIComponent, decodeURIComponent, parseInt, parseFloat, isNaN,
  });
  for (const s of scripts) vm.runInContext(s, context, { filename: "index.html" });

  // Neutraliza o que redesenha a tela; o teste só observa as chamadas de API.
  const stubs = {
    loadAll: "async () => {}", render: "() => {}", closeModal: "() => {}",
    loadTransactions: "async () => {}", autoSaveGuest: "async () => {}",
  };
  vm.runInContext(Object.entries(stubs).filter(([k]) => !keep.includes(k))
    .map(([k, v]) => `${k} = ${v};`).join("\n"), context);

  const run = (code) => vm.runInContext(code, context);
  return { run, calls, alerts, context };
}

module.exports = { loadFrontend };
