// Supabase simulado em memória, só com o que server.js usa nas rotas testadas.
// Cada consulta devolve { data, error } como o supabase-js. Sem rede.
"use strict";

// Sem "users" no estado inicial, entram os usuários fictícios de helpers/auth.js
// (o servidor valida a sessão no banco). failSelect simula falha de leitura nas
// tabelas de dados, não na de usuários (senão nenhum pedido autenticado passaria).
// missingColumns: { tabela: ["coluna"] } simula banco ANTES de uma migration que
// cria a coluna (o select/filtro/gravação com ela falha como no Postgres).
// noOverlap: simula a constraint reservations_no_overlap (mesma regra da migration
// 20261123_01): o comando inteiro é recusado com 23P01 e nada é gravado.
const BLOCK_RE = /(not available|closed|blocked|bloqueado|indispon|unavailable)/i;
const occupies = (r) => !["cancelled", "pending"].includes(r.status || "confirmed") && String(r.check_out) > "2026-11-24" &&
  !(r.source === "airbnb" && BLOCK_RE.test(r.guest_name || ""));
const clash = (a, b) => a !== b && String(a.room_id) === String(b.room_id) && occupies(a) && occupies(b) &&
  a.check_in < b.check_out && b.check_in < a.check_out;
const OVERLAP = { code: "23P01", message: 'conflicting key value violates exclusion constraint "reservations_no_overlap"' };

function createFakeSupabase(initial = {}, { delayMs = 0, failSelect = false, maxRows = 1000, missingColumns = {}, noOverlap = false } = {}) {
  const tables = {};
  if (!("users" in initial)) initial = { ...initial, users: require("./auth").TEST_USERS };
  for (const [t, rows] of Object.entries(initial)) tables[t] = rows.map(r => ({ ...r }));
  const log = []; // operações executadas, para os testes inspecionarem

  function query(table) {
    const state = { table, op: "select", filters: [], payload: null, single: null, columns: "*", usedCols: [] };
    const rows = () => (tables[table] ||= []);
    const match = (r) => state.filters.every(f => f(r));

    const api = {
      select(cols = "*") { if (state.op === "select") state.columns = cols; return api; },
      insert(p) { state.op = "insert"; state.payload = p; return api; },
      update(p) { state.op = "update"; state.payload = p; return api; },
      upsert(p) { state.op = "upsert"; state.payload = p; return api; },
      delete()  { state.op = "delete"; return api; },
      eq(c, v)  { state.usedCols.push(c); state.filters.push(r => String(r[c]) === String(v)); return api; },
      neq(c, v) { state.filters.push(r => String(r[c]) !== String(v)); return api; },
      in(c, vs) { state.filters.push(r => vs.map(String).includes(String(r[c]))); return api; },
      lt(c, v)  { state.filters.push(r => String(r[c]) < String(v)); return api; },
      gt(c, v)  { state.filters.push(r => String(r[c]) > String(v)); return api; },
      gte(c, v) { state.filters.push(r => String(r[c]) >= String(v)); return api; },
      lte(c, v) { state.filters.push(r => String(r[c]) <= String(v)); return api; },
      like(c, pat) {
        const re = new RegExp("^" + String(pat).split("%").map(x => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$", "s");
        state.filters.push(r => re.test(String(r[c] ?? ""))); return api;
      },
      is(c, v)  { state.filters.push(r => (v === null ? r[c] == null : r[c] === v)); return api; },
      not(c, op, v) {
        if (op === "is" && v === null) state.filters.push(r => r[c] != null);
        return api;
      },
      order()   { return api; },
      range(a, b) { state.range = [a, b]; return api; },
      limit()   { return api; },
      single()      { state.single = "single"; return api; },
      maybeSingle() { state.single = "maybe";  return api; },
      then(resolve, reject) { return exec().then(resolve, reject); },
    };

    async function exec() {
      if (delayMs) await new Promise(r => setTimeout(r, delayMs));
      log.push({ table, op: state.op, payload: state.payload, columns: state.columns, filters: state.usedCols.slice() });
      const gone = missingColumns[table] || [];
      if (gone.length) {
        const cols = String(state.columns).split(",").map(x => x.trim());
        const payloadCols = [].concat(state.payload || []).flatMap(p => Object.keys(p || {}));
        const hit = gone.find(c => cols.includes(c) || state.usedCols.includes(c) || payloadCols.includes(c));
        if (hit) return { data: null, error: { code: state.op === "select" ? "42703" : "PGRST204",
          message: `column ${table}.${hit} does not exist` } };
      }
      let data;
      if (state.op === "select") {
        if (failSelect && table !== "users") return { data: null, error: { message: "falha simulada" } };
        data = rows().filter(match).map(r => ({ ...r }));
        if (state.range) data = data.slice(state.range[0], Math.min(state.range[1] + 1, state.range[0] + maxRows));
        else data = data.slice(0, maxRows);
      } else if (state.op === "insert") {
        const list = Array.isArray(state.payload) ? state.payload : [state.payload];
        for (const r of list) {
          if (r.id !== undefined && rows().some(x => x.id === r.id)) return { data: null, error: { message: "duplicate key" } };
        }
        if (noOverlap && table === "reservations") {
          const after = [...rows(), ...list];
          if (list.some(n => after.some(o => clash(n, o)))) return { data: null, error: OVERLAP };
        }
        // Sem id (coluna identity, ex.: audit_log): numera e marca a hora, como o banco.
        list.forEach(r => rows().push({ ...(r.id === undefined ? { id: rows().length + 1, at: new Date().toISOString() } : {}), ...r }));
        data = list.map(r => ({ ...r }));
      } else if (state.op === "update") {
        data = [];
        if (noOverlap && table === "reservations") {
          const after = rows().map(r => (match(r) ? { ...r, ...state.payload } : r));
          const changed = after.filter((r, i) => match(rows()[i]));
          if (changed.some(n => after.some(o => clash(n, o)))) return { data: null, error: OVERLAP };
        }
        for (const r of rows()) if (match(r)) { Object.assign(r, state.payload); data.push({ ...r }); }
      } else if (state.op === "upsert") {
        const list = Array.isArray(state.payload) ? state.payload : [state.payload];
        data = [];
        // Chave do conflito como no banco real: settings usa PRIMARY KEY (key);
        // as demais tabelas usam id.
        const pk = table === "settings" ? "key" : "id";
        for (const r of list) {
          const cur = rows().find(x => x[pk] === r[pk]);
          if (cur) Object.assign(cur, r); else rows().push({ ...r });
          data.push({ ...(cur || r) });
        }
      } else if (state.op === "delete") {
        data = rows().filter(match);
        tables[table] = rows().filter(r => !match(r));
      } else {
        data = [];
      }
      if (state.single === "single") {
        if (data.length !== 1) return { data: null, error: { message: "not single" } };
        return { data: data[0], error: null };
      }
      if (state.single === "maybe") {
        if (data.length > 1) return { data: null, error: { message: "multiple rows" } };
        return { data: data[0] || null, error: null };
      }
      return { data, error: null };
    }
    return api;
  }

  return { from: query, tables, log };
}

module.exports = { createFakeSupabase };
