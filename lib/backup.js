// Backup completo do banco da PMS em um arquivo JSON e restauração em SQL.
// O Supabase Free não faz backup automático: o admin baixa o arquivo pela PMS
// e guarda em lugar privado (contém dados de hóspedes e hashes de senha).
"use strict";

const FORMAT = "pms-backup";
const VERSION = 1;

// Ordem de restauração: quem é referenciado vem antes (payments → reservations).
// "optional": tabela criada por migration; se ainda não existir, o backup diz isso.
const TABLES = [
  { name: "users",           key: "id" },
  { name: "guests",          key: "id" },
  { name: "reservations",    key: "id" },
  { name: "prereservations", key: "id" },
  { name: "transactions",    key: "id" },
  { name: "settings",        key: "key" },
  { name: "payments",        key: "id", optional: true },
  { name: "audit_log",       key: "id", optional: true, identity: true },
];

const isMissingTable = (e) => !!e && (e.code === "42P01" || e.code === "PGRST205" ||
  /does not exist|schema cache/i.test(e.message || ""));

// fetchTable(name, key) → { data, error }. Qualquer erro que não seja "tabela
// não existe" (em tabela opcional) aborta: um backup pela metade parece completo.
async function buildBackup(fetchTable, { now = new Date() } = {}) {
  const tables = {}, counts = {}, absent = [];
  for (const t of TABLES) {
    const { data, error } = await fetchTable(t.name, t.key);
    if (error) {
      if (t.optional && isMissingTable(error)) { absent.push(t.name); continue; }
      const e = new Error(`falha ao ler ${t.name}`);
      e.table = t.name;
      e.code = error.code;
      throw e;
    }
    tables[t.name] = data || [];
    counts[t.name] = tables[t.name].length;
  }
  return { format: FORMAT, version: VERSION, createdAt: now.toISOString(), counts, absent, tables };
}

// Confere a estrutura antes de restaurar (arquivo errado, cortado ou editado).
function validateBackup(b) {
  const problems = [];
  if (!b || b.format !== FORMAT) problems.push("não é um backup da PMS");
  else if (b.version !== VERSION) problems.push(`versão ${b.version} não suportada`);
  else {
    for (const t of TABLES) {
      const rows = b.tables && b.tables[t.name];
      if (rows === undefined) { if (!(b.absent || []).includes(t.name)) problems.push(`falta a tabela ${t.name}`); continue; }
      if (!Array.isArray(rows)) { problems.push(`${t.name} não é uma lista`); continue; }
      if (b.counts && b.counts[t.name] !== rows.length) problems.push(`${t.name}: ${rows.length} linhas, esperado ${b.counts[t.name]}`);
    }
  }
  return problems;
}

// Delimitador $tag$ que não aparece no texto (dados podem conter qualquer coisa).
function dollarQuote(text) {
  let tag = "pms";
  for (let i = 0; text.includes(`$${tag}$`); i++) tag = "pms" + i;
  return `$${tag}$${text}$${tag}$`;
}

// SQL para restaurar num banco com o esquema já criado (baseline + migrations)
// e VAZIO. Uma transação só: tudo ou nada. Não apaga nada.
function restoreSql(b) {
  const problems = validateBackup(b);
  if (problems.length) throw new Error("Backup inválido: " + problems.join("; "));
  const out = [
    `-- Restauração do backup da PMS de ${b.createdAt}. Banco precisa estar com o esquema criado e vazio.`,
    "begin;",
    "set local statement_timeout = 0;",
  ];
  for (const t of TABLES) {
    out.push(`do $$ begin if exists (select 1 from public.${t.name} limit 1) then ` +
      `raise exception 'public.${t.name} não está vazia: restauração cancelada'; end if; end $$;`);
  }
  for (const t of TABLES) {
    const rows = b.tables[t.name];
    if (!rows || !rows.length) continue;
    const over = t.identity ? " overriding system value" : "";
    out.push(`insert into public.${t.name}${over} select * from json_populate_recordset(null::public.${t.name}, ${dollarQuote(JSON.stringify(rows))}::json);`);
    if (t.identity) out.push(`select setval(pg_get_serial_sequence('public.${t.name}', 'id'), (select max(id) from public.${t.name}));`);
  }
  out.push("commit;");
  return out.join("\n") + "\n";
}

module.exports = { FORMAT, VERSION, TABLES, buildBackup, validateBackup, restoreSql, isMissingTable };
