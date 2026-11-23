# Ensaio — constraint `reservations_no_overlap` (PMS-005 camada 2)

Data: 23/11/2026. Ambiente: **staging** (`pms-staging`, Supabase Free, sa-east-1).
Produção **não** foi alterada.

## 1. Staging
- Projeto criado com autorização do Paulo (23/11, ~15:57).
- Esquema montado com `db/00_baseline_schema.sql`, reconstruído do catálogo de produção.
- **Conferência:** impressão digital (md5) de colunas, tipos, padrões, constraints e políticas **idêntica** entre produção e staging; RLS "Server only" nas 6 tabelas nos dois.
- Dados do staging: só fictícios (nenhum dado de produção copiado).

## 2. Resultados do ensaio (executado no Postgres do staging)
| Etapa | Resultado |
|---|---|
| Aplicar com 1 sobreposição futura de propósito | **Falhou com mensagem clara** ("Ainda há 1 par…"); nada criado (nem constraint, nem extensão). Histórico sobreposto e bloqueio Airbnb não foram contados |
| Resolver o conflito e aplicar | Constraint criada |
| 12 casos de comportamento | **12/12 conforme esperado** (abaixo) |
| Rollback (`.down.sql`) | Constraint removida; 12 linhas intactas |
| Reaplicar | Constraint ativa de novo |

| # | Caso | Esperado | Obtido |
|---|---|---|---|
| 1 | Sobrepõe mesmo quarto | recusa | recusa (23P01) |
| 2 | Saída = entrada (adjacente) | aceita | aceita |
| 3 | Mesmas datas, outro quarto | aceita | aceita |
| 4 | Cancelada sobreposta | aceita | aceita |
| 5 | Bloqueio "Not available" do Airbnb sobreposto | aceita | aceita |
| 6 | Booking "CLOSED - Not available" sobreposto (pode ser reserva real) | recusa | recusa (23P01) |
| 7 | `pending` sobreposta (regra antiga) | recusa | recusa (23P01) |
| 8 | CF (9 linhas num INSERT) com o quarto 20 ocupado | recusa, 0 linhas | recusa (23P01), **0 linhas gravadas** |
| 9 | Editar datas para cima de outra reserva | recusa | recusa (23P01) |
| 10 | Reativar reserva cancelada que conflita | recusa | recusa (23P01) |
| 11 | Histórico (antes do corte de 24/11/2026) sobreposto | aceita | aceita |
| 12 | 11+12 num INSERT, quartos livres | aceita | aceita |

**Reensaio após a decisão de 23/11/2026 ("pending" não bloqueia), constraint recriada com `status not in ('cancelled','pending')`:**

| # | Caso | Esperado | Obtido |
|---|---|---|---|
| 7 | `pending` sobreposta a uma confirmada | aceita | aceita |
| 7b | Confirmada sobreposta a confirmada | recusa | recusa (23P01) |
| 7c | **Confirmar** a `pending` cujas datas já estão ocupadas | recusa | recusa (23P01) → servidor responde 409 |
| 1 | Sobrepõe mesmo quarto | recusa | recusa (23P01) |
| 2 | Adjacente | aceita | aceita |

**Concorrência:** não executada com duas conexões simultâneas (as ferramentas só permitem uma conexão por vez). A garantia vem do próprio Postgres: constraint de exclusão é verificada no commit e uma segunda transação concorrente espera a primeira e então é recusada. O teste `todo` do Node continua documentando que a camada 1 sozinha não fecha a corrida.

## 3. Situação de produção (medida em 23/11, só leitura)
- Sobreposições **futuras** que impediriam a criação: **4 pares, 2 quartos, Airbnb × Booking** (os casos de dezembro que o Paulo está cancelando no Booking).
- Sobreposições do passado: 82 pares (duplicatas antigas de importação) — fora da constraint pelo corte de data.

## 4. Roteiro para produção (só com autorização explícita do Paulo)
1. **Código primeiro:** PR que traduz 23P01 em 409 e mostra conflito de importação no aviso 📅 mesclada e no ar.
2. **Backup externo** (`pg_dump`) feito e **restaurado no staging** (comparar contagens).
3. Conferir **0 sobreposições futuras** com a consulta da própria migration (bloco `do $$`).
4. Aplicar `db/migrations/20261123_01_reservations_no_overlap.sql` (transação; se houver conflito, falha sem mudar nada).
5. Verificar: `select pg_get_constraintdef(oid) from pg_constraint where conname = 'reservations_no_overlap';`
6. Acompanhar 24 h: logs `[availability] banco recusou`, aviso 📅 de "possível overbooking".
7. **Rollback**, se algo der errado: `db/migrations/20261123_01_reservations_no_overlap.down.sql` (remove só a constraint; não mexe em dados).

## 5. Efeitos esperados após aplicar
- Duas reservas no mesmo quarto e noite **não conseguem mais ser gravadas**, nem por corrida, nem por edição, nem por reativação.
- Se Airbnb e Booking venderem as mesmas noites (overbooking das plataformas), a segunda reserva **não entra no PMS**: aparece no aviso 📅 como "Possível overbooking — Booking quarto 20, 24/12 → 26/12…" até ser resolvida.
