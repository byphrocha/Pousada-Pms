#!/usr/bin/env bash
# Ensaio da restauração de backup (CI): num Postgres local com baseline +
# migrations e VAZIO, restaura um backup FICTÍCIO, confere contagens e
# conteúdo, e confere que restaurar de novo é recusado (banco não vazio).
set -euo pipefail
cd "$(dirname "$0")/.."
case "${PGHOST:-}" in localhost|127.0.0.1|/*) ;; *) echo "Recusado: PGHOST precisa ser localhost." >&2; exit 2 ;; esac
PSQL=(psql -X -q -v ON_ERROR_STOP=1)
tmp=$(mktemp -d)
node scripts/fixtures/backup-ficticio.js > "$tmp/b.json"
node scripts/restaurar-backup.js "$tmp/b.json" > "$tmp/r.sql"
"${PSQL[@]}" -f "$tmp/r.sql"
"${PSQL[@]}" -f scripts/verificar-restauracao.sql
if "${PSQL[@]}" -f "$tmp/r.sql" 2>"$tmp/err"; then echo "Restaurar por cima deveria ser recusado" >&2; exit 1; fi
grep -q "não está vazia" "$tmp/err" || { cat "$tmp/err" >&2; exit 1; }
echo "✅ restauração de backup: ok (e recusa banco com dados)"
