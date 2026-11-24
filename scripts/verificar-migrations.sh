#!/usr/bin/env bash
# PMS-016: prova que o banco é reproduzível a partir do repositório.
# Num Postgres VAZIO e descartável: baseline → todas as migrations (ordem do nome)
# → verificações → todos os .down.sql (ordem inversa) → migrations de novo.
# Recusa rodar fora de localhost: nunca aponte para o Supabase.
#
# Uso: PGHOST=localhost PGPORT=5432 PGUSER=postgres PGDATABASE=ensaio scripts/verificar-migrations.sh
set -euo pipefail
cd "$(dirname "$0")/.."

case "${PGHOST:-}" in
  localhost|127.0.0.1|/*) ;;
  *) echo "Recusado: PGHOST precisa ser localhost (banco descartável). Atual: '${PGHOST:-vazio}'" >&2; exit 2 ;;
esac
if [ -n "${DATABASE_URL:-}" ]; then echo "Recusado: não use DATABASE_URL aqui." >&2; exit 2; fi

PSQL=(psql -X -q -v ON_ERROR_STOP=1)
run() { echo "→ $1"; "${PSQL[@]}" -f "$1"; }

vazio=$("${PSQL[@]}" -tAc "select count(*) from information_schema.tables where table_schema='public'")
if [ "$vazio" != "0" ]; then echo "Recusado: o banco não está vazio ($vazio tabelas em public)." >&2; exit 2; fi

# O Supabase cria as extensões no schema "extensions"; aqui criamos igual.
"${PSQL[@]}" -c "create schema if not exists extensions"

ups=$(ls db/migrations/*.sql | grep -v '\.down\.sql$' | sort)
for up in $ups; do
  [ -f "${up%.sql}.down.sql" ] || { echo "Falta rollback: ${up%.sql}.down.sql" >&2; exit 1; }
done

run db/00_baseline_schema.sql
for up in $ups; do run "$up"; done
echo "→ verificações com as migrations aplicadas"
"${PSQL[@]}" -f scripts/verificar-migrations.sql

for up in $(echo "$ups" | sort -r); do run "${up%.sql}.down.sql"; done
echo "→ verificações depois do rollback"
"${PSQL[@]}" -f scripts/verificar-rollback.sql

for up in $ups; do run "$up"; done
echo "→ verificações depois de reaplicar"
"${PSQL[@]}" -f scripts/verificar-migrations.sql
echo "✅ baseline + migrations + rollback + reaplicação: ok"
