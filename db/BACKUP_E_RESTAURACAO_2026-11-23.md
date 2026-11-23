# Backup externo e restauração testada — 23/11/2026

Cumpre a regra 2 ("backup + restauração testada") para as migrations de 23/11.

## Backup
- **Método:** exportação CSV das 6 tabelas pelo Table Editor do Supabase (produção), feita pelo Paulo às ~17h. (`pg_dump` não foi possível no computador dele.)
- **Guarda:** fora do computador, em local privado (contém dados de hóspedes e hashes de senha do PMS).
- **Não inclui:** o schema `backup` (cópia de 23/11 das reservas, que continua no próprio banco).

## Restauração testada (staging `pms-staging`)
Importação dos CSVs pelo Table Editor do staging. Conferência feita pelo Claude, só com contagens e impressões digitais (md5), sem ler dados pessoais:

| Tabela | Linhas prod. | Linhas staging | Impressão do conteúdo |
|---|---|---|---|
| reservations | 2340 | 2340 | **idêntica** (id, quarto, datas, status, canal, valor, forma, adultos, crianças, external_uid, created_at; inclusive 14 nulos) |
| guests | 6 | 6 | **idêntica** (id + md5 de nome/CPF/telefone) |
| transactions | 2 | 2 | **idêntica** |
| users | 2 | 2 | **idêntica** (id, usuário, papel, md5 do hash) |
| prereservations | 2 | 2 | **idêntica** |
| settings | 13 | 13 | 12/13 chaves idênticas; `ical_sync_status` difere (reescrita a cada 15 min, mudou depois da exportação — esperado) |

**Resultado: restauração completa e fiel.**

## Depois da conferência
- Staging **anonimizado**: nomes/telefones/CPF/e-mails/endereços/observações de hóspedes, nomes de reservas diretas e pré-reservas, descrições do financeiro, senhas de usuários e links de calendário trocados por fictícios. Mantidos: textos genéricos das OTAs ("Reserved", "Not available") e marcas de grupo CF/11+12 (1.392 linhas). Conferido: 0 dados reais restantes.
- Ensaio da constraint com os **dados reais** (ver `ENSAIO_CONSTRAINT_2026-11-23.md`).

## Produção
- 23/11/2026 ~18h03, com autorização explícita do Paulo: aplicadas `20261123_02_payments` e `20261123_03_audit_log` (aditivas). Conferido: tabelas, 8 regras de pagamento, gatilho só-acréscimo, RLS "Server only"; reservas (2340) e lançamentos (2) intactos.
- `20261123_01_reservations_no_overlap`: **não aplicada** (aguarda os 4 conflitos de dezembro e autorização).
