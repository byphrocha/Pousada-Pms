# Ensaio — 20261124_01_reservations_group_id (PMS-006)

Caminho escolhido pelo Paulo em 24/11/2026: **coluna de grupo** (não o modelo
reserva + alocações). Migration aditiva; não altera `notes` nem outra coluna.

## Inventário em produção (somente leitura, 24/11 ~02h40)

| Item | Valor |
|---|---|
| Reservas | 2360 |
| Linhas com `[Casa toda:…]` (regra 1) | 1405 |
| Linhas só com `[Suíte grupo:…]` (regra 2) | 2 |
| Linhas importadas da suíte 11+12, sem marca (regra 3) | 100 |
| Grupos da regra 3 | 50, **todos** pares 11+12 com mesmas datas e status; 0 colidem com CF |
| Coluna `group_id` | não existe |

Observações do inventário (só contagens):
- Não há Casa Fechada nem 11+12 criadas à mão no PMS; todos os grupos vieram do Airbnb.
- 44 CFs reais (4 futuras, todas completas) e 180 grupos de bloqueio automático do anúncio CF.

**Conferência depois de aplicar em produção:** 1405 + 2 + 100 = **1507** linhas com `group_id`,
nenhuma marca sem grupo, nenhum grupo com datas diferentes, assinatura das demais colunas igual.

## Ensaio no staging (`pms-staging`, dados anonimizados)

| Passo | Resultado |
|---|---|
| Antes | 2340 linhas; 1392 com marca CF, 2 com marca de suíte, 0 importadas da suíte (notas anonimizadas); assinatura `d77ee77d…` |
| Aplicar `.sql` | 1394 linhas com grupo (1392 cf + 2 suite), 223 grupos; 0 marcas sem grupo; 0 grupos sem marca; 0 grupos com datas diferentes; **assinatura igual** (`d77ee77d…`) |
| Aplicar `.down.sql` | coluna removida; **assinatura igual** (`d77ee77d…`) |
| Reaplicar `.sql` | mesmo resultado (1394 / 223); staging fica com a coluna |

A regra 3 não foi exercitada no staging (notas anonimizadas); foi validada em produção
por consulta somente leitura (tabela acima).

## Roteiro para produção (só com autorização explícita do Paulo)

1. Mesclar a PR do código (sem a coluna o servidor segue como antes; detecta a coluna sozinho).
2. Cópia de segurança: `create table backup.reservations_20261124 as select * from public.reservations;`
   e conferir contagem e md5 iguais aos da tabela original.
3. Aplicar `db/migrations/20261124_01_reservations_group_id.sql`.
4. Conferir: 1507 linhas com grupo; 0 marcas sem grupo; 0 grupos com datas diferentes;
   assinatura das demais colunas igual à do passo 2.
5. Em até 60 s o servidor passa a editar/cancelar CF e 11+12 como grupo.

## Rollback

`db/migrations/20261124_01_reservations_group_id.down.sql` — remove índice e coluna.
`notes` nunca foi alterado, então nada se perde; o servidor volta sozinho ao
comportamento antigo (edição linha a linha) em até 60 s. Ensaiado no staging.
