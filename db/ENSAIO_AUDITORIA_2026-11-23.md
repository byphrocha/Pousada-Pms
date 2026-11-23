# Ensaio — tabela `audit_log` (PMS-014)

Data: 23/11/2026. Ambiente: **staging** (`pms-staging`). Produção **não** foi alterada.

## O que é
Histórico de **quem fez o quê e quando** em reservas e pagamentos: criar, editar, cancelar, reativar, apagar; registrar, marcar recebido, alterar, excluir pagamento.

- **Só acréscimo:** um gatilho no banco recusa `UPDATE` e `DELETE`, inclusive vindos do servidor.
- **Privacidade (regra 7):** grava só quarto, datas, status, canal, valor, forma, adultos/crianças e, nos pagamentos, tipo/valor/forma/vencimento/data paga. Nome, telefone, CPF, e-mail e observações **nunca** são gravados — no máximo "alterou nome".
- Falha ao gravar a auditoria **não** impede a operação principal (vai só para o log).
- Leitura só pelo admin (`GET /reservations/:id/history`), inclui grupo CF/11+12 e pagamentos.
- Ações da sincronização iCal **não** são registradas aqui (o aviso 📅 e os logs `[ical-reconcile]` cobrem).

## Migration
- `db/migrations/20261123_03_audit_log.sql` — aditiva (tabela, índices, gatilho, RLS "Server only").
- `db/migrations/20261123_03_audit_log.down.sql` — remove a tabela (**apaga o histórico**: exportar antes se já estiver em uso).

## Resultados no staging (Postgres real)
| Caso | Esperado | Obtido |
|---|---|---|
| Inserir registro | aceita | aceita |
| Alterar registro | recusa | recusa (P0001), registro intacto |
| Apagar registro | recusa | recusa (P0001), registro intacto |
| Registro sem ação | recusa | recusa (23502) |
| Rollback | remove | tabela removida; reservas intactas |
| Reaplicar (com `reservation_id`) | cria | ok; alterar/apagar seguem recusados |

## Para aplicar em produção (com autorização)
Junto com as outras migrations, depois do backup externo restaurado no staging. Ativa sozinha em até 60 s.
