// Supabase simulado em memória, só com o que server.js usa nas rotas testadas.
// Cada consulta devolve { data, error } como o supabase-js. Sem rede.
"use strict";

function createFakeSupabase(initial = {}, { delayMs = 0, failSelect = false } = {}) {
  const tables = {};
  for (const [t, rows] of Object.entries(initial)) tables[t] = rows.map(r => ({ ...r }));
  const log = []; // operações executadas, para os testes inspecionarem

  function query(table) {
    const state = { table, op: "select", filters: [], payload: null, single: null, columns: "*" };
    const rows = () => (tables[table] ||= []);
    const match = (r) => state.filters.every(f => f(r));

    const api = {
      select(cols = "*") { if (state.op === "select") state.columns = cols; return api; },
      insert(p) { state.op = "insert"; state.payload = p; return api; },
      update(p) { state.op = "update"; state.payload = p; return api; },
      upsert(p) { state.op = "upsert"; state.payload = p; return api; },
      delete()  { state.op = "delete"; return api; },
      eq(c, v)  { state.filters.push(r => String(r[c]) === String(v)); return api; },
      neq(c, v) { state.filters.push(r => String(r[c]) !== String(v)); return api; },
      in(c, vs) { state.filters.push(r => vs.map(String).includes(String(r[c]))); return api; },
      lt(c, v)  { state.filters.push(r => String(r[c]) < String(v)); return api; },
      gt(c, v)  { state.filters.push(r => String(r[c]) > String(v)); return api; },
      order()   { return api; },
      limit()   { return api; },
      single()      { state.single = "single"; return api; },
      maybeSingle() { state.single = "maybe";  return api; },
      then(resolve, reject) { return exec().then(resolve, reject); },
    };

    async function exec() {
      if (delayMs) await new Promise(r => setTimeout(r, delayMs));
      log.push({ table, op: state.op, payload: state.payload });
      let data;
      if (state.op === "select") {
        if (failSelect) return { data: null, error: { message: "falha simulada" } };
        data = rows().filter(match).map(r => ({ ...r }));
      } else if (state.op === "insert") {
        const list = Array.isArray(state.payload) ? state.payload : [state.payload];
        for (const r of list) {
          if (rows().some(x => x.id === r.id)) return { data: null, error: { message: "duplicate key" } };
        }
        list.forEach(r => rows().push({ ...r }));
        data = list.map(r => ({ ...r }));
      } else if (state.op === "update") {
        data = [];
        for (const r of rows()) if (match(r)) { Object.assign(r, state.payload); data.push({ ...r }); }
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
