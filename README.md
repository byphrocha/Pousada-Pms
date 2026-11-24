# PMS Pousada

Sistema de gestão da pousada: reservas (quartos individuais, suíte 11+12 e Casa Fechada),
hóspedes, limpeza/check-in, financeiro e sincronização de calendários (iCal) com Airbnb e Booking.

## Estrutura

| Caminho | O que é |
|---|---|
| `server.js` | API Express 4 e sincronização iCal |
| `build/index.html` | Interface (HTML/CSS/JS sem framework), servida como arquivo estático |
| `lib/availability.js` | Regras de disponibilidade (datas, quartos, sobreposição) — funções puras |
| `test/` | Testes automatizados (`node:test`, sem dependências extras) |
| `.env.example` | Variáveis de ambiente necessárias (sem valores) |

Quartos físicos: 10, 11, 12, 20, 21, 22, 23, 24, 25. Produtos compostos:
`11+12` ocupa os quartos 11 e 12; `CF` (Casa Fechada) ocupa os nove.
Uma estadia ocupa o intervalo `[check_in, check_out)`: saída e entrada no mesmo dia não conflitam.

## Rodar localmente

Requer Node.js 18 ou mais novo.

```bash
npm ci
cp .env.example .env          # preencha com um Supabase de DESENVOLVIMENTO, nunca o de produção
node --env-file=.env server.js   # Node 20.6+; no Node 18, exporte as variáveis antes
```

Abra http://localhost:3000.

## Testes

```bash
npm test
```

Os testes não acessam banco nem rede: usam dados fictícios e um Supabase simulado.

## Banco: baseline e migrations

- `db/00_baseline_schema.sql`: esquema de antes das migrations (do inventário de 23/11/2026).
- `db/migrations/AAAAMMDD_NN_nome.sql`: aplicadas nesta ordem; cada uma tem o seu `.down.sql`.
- Ensaio completo num Postgres **vazio e local** (o script recusa outro host):

```bash
PGHOST=localhost PGUSER=postgres PGDATABASE=ensaio npm run db:verificar
```

Ele aplica baseline e migrations, confere as regras (sobreposição recusada, CF tudo ou nada,
RLS em todas as tabelas, auditoria só por inclusão), desfaz tudo com os `.down.sql` e reaplica.
O CI faz o mesmo em Postgres 17 a cada PR. Migration nova sem `.down.sql` reprova.

## Avisos no celular (Web Push)

A PMS avisa o admin quando um calendário traz uma reserva que bate com outra já na PMS
(possível overbooking). Só quarto, canal e datas, sem dados de hóspede; cada conflito avisa uma vez.

- Servidor: `VAPID_PUBLIC_KEY` e `VAPID_PRIVATE_KEY` no Render (gerar com `node scripts/gerar-chaves-vapid.js`).
  Sem elas, os avisos ficam desligados.
- iPhone (iOS 16.4+): abrir a PMS **pelo ícone da tela de início** → Alertas → 🔔 → "Ativar avisos".
- O push vai vazio (sem conteúdo); o app busca o texto em `POST /push/inbox` usando o endereço
  secreto do próprio aparelho. O service worker (`build/sw.js`) não guarda cache.

## Backup e restauração

O Supabase Free não faz backup automático. Na PMS, **Alertas → 💾 Backup do banco → Baixar backup**
(só admin) gera `pms-backup-AAAA-MM-DD.json` com todas as tabelas. O aviso fica amarelo depois de 7 dias.
O arquivo tem dados de hóspedes e hashes de senha: guarde em lugar privado, fora do repositório
(o `.gitignore` bloqueia `pms-backup-*.json`).

Restaurar num banco **novo** (baseline + migrations aplicados, tabelas vazias):

```bash
node scripts/restaurar-backup.js pms-backup-AAAA-MM-DD.json > restaurar.sql
psql "<banco novo>" -v ON_ERROR_STOP=1 -f restaurar.sql
```

É uma transação só (tudo ou nada) e recusa se alguma tabela já tiver dados. O CI ensaia isso
com um backup fictício (`scripts/ensaio-restauracao.sh`).

## Regras para contribuir

- Nunca rode migrations ou scripts de escrita no banco de produção sem backup e restauração testados.
- Nunca coloque CPF, telefones, nomes reais, tokens, chaves ou URLs de feed iCal em código, testes, issues ou commits.
- Uma tarefa do backlog por PR, com testes e forma de desfazer.
