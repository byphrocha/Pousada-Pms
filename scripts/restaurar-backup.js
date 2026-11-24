#!/usr/bin/env node
// Gera o SQL para restaurar um backup baixado pela PMS (💾 em Alertas).
// Uso: node scripts/restaurar-backup.js pms-backup-AAAA-MM-DD.json > restaurar.sql
//      psql <banco NOVO, com baseline + migrations e vazio> -v ON_ERROR_STOP=1 -f restaurar.sql
// Não conecta em banco nenhum: só lê o arquivo e escreve SQL. Tudo ou nada
// (uma transação); recusa se alguma tabela de destino já tiver dados.
"use strict";
const fs = require("fs");
const { restoreSql, validateBackup } = require("../lib/backup");

const file = process.argv[2];
if (!file) { console.error("Uso: node scripts/restaurar-backup.js <arquivo.json>"); process.exit(2); }
let b;
try { b = JSON.parse(fs.readFileSync(file, "utf8")); }
catch (e) { console.error("Não consegui ler o arquivo como JSON: " + e.message); process.exit(1); }
const problems = validateBackup(b);
if (problems.length) { console.error("Backup inválido: " + problems.join("; ")); process.exit(1); }
process.stdout.write(restoreSql(b));
console.error(`Backup de ${b.createdAt}: ` + Object.entries(b.counts).map(([t, n]) => `${t}=${n}`).join(", ") +
  (b.absent && b.absent.length ? ` (sem: ${b.absent.join(", ")})` : ""));
