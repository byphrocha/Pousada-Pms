# Ensaio — tabela `payments` (PMS-007)

Data: 23/11/2026. Ambiente: **staging** (`pms-staging`). Produção **não** foi alterada.

## Decisões do Paulo (23/11/2026)
- Receita entra no Financeiro **quando o dinheiro é recebido** (sinal/parcela pagos), não quando a reserva é criada (regra 6).
- Controle **só de reservas diretas**. Airbnb/Booking: a plataforma cuida de taxas e estornos.
- Casa Fechada pode ter **sinal + parcelas com vencimento**, variando por reserva.
- Estorno de reserva direta é devolvido via **PIX**.

## Migration
- `db/migrations/20261123_02_payments.sql` — aditiva: cria só a tabela `payments` (+ índices, RLS "Server only").
- `db/migrations/20261123_02_payments.down.sql` — **recusa** remover a tabela se houver pagamentos registrados.

## Resultados no staging (Postgres real)
| # | Caso | Esperado | Obtido |
|---|---|---|---|
| 1 | Sinal pago (PIX) | aceita | aceita |
| 2 | Parcela a vencer (sem pagamento) | aceita | aceita |
| 3 | Sem data nenhuma | recusa | recusa (23514) |
| 4 | Valor zero | recusa | recusa (23514) |
| 5 | Estorno sem data de devolução | recusa | recusa (23514) |
| 6 | Pago sem forma de pagamento | recusa | recusa (23514) |
| 7 | Tipo desconhecido | recusa | recusa (23514) |
| 8 | Reserva inexistente | recusa | recusa (23503) |
| 9 | Apagar reserva que tem pagamento | recusa | recusa (23503) |
| 10 | Marcar parcela como paga | aceita | aceita |
| 11 | Estorno pago via PIX | aceita | aceita |

- Rollback com 3 pagamentos na tabela: **recusou** ("payments tem 3 registro(s)…").
- Rollback com a tabela vazia: tabela removida; reservas intactas.
- Reaplicada: staging com `payments` ativa.

## Como o sistema se comporta
- **Antes da migration em produção:** nada muda (servidor detecta a ausência da tabela; Financeiro como sempre).
- **Depois:** detecção automática em até 60 s.
  - Reserva direta nova (admin): **sem** receita automática; a reserva abre para registrar sinal/parcelas.
  - Financeiro: pagamentos recebidos aparecem como linhas somente leitura (💳 … via reserva), no mês em que o dinheiro entrou; estorno como despesa; quadro **A RECEBER** com parcelas e vencidas.
  - CF/11+12: valor do contrato e pagamentos ficam na linha "dona" do grupo; novas CFs gravam o valor só na 1ª linha (F3).

## Para aplicar em produção (com autorização)
1. Backup externo + restauração testada (pendente).
2. Aplicar `20261123_02_payments.sql`.
3. Conferir: `select to_regclass('public.payments');` e abrir uma reserva direta como admin (quadro 💳).
4. Rollback (só sem pagamentos registrados): `20261123_02_payments.down.sql`.

## Observações
- O único lançamento existente em `transactions` não é migrado nem alterado.
- Reservas diretas antigas com valor contratado aparecem com **saldo = valor** até o Paulo registrar o que já recebeu.
