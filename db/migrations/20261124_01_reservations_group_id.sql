-- PMS-006 (coluna de grupo, escolhida pelo Paulo em 24/11/2026).
-- Aditiva: cria reservations.group_id e preenche a partir das marcas atuais.
-- NÃO altera notes nem nenhuma outra coluna; o rollback só remove a coluna.
-- Esquema conferido: reservations.id text PK, notes text, external_uid text UNIQUE,
-- room_id text, source text (db/00_baseline_schema.sql e inventário de 23/11).
begin;

alter table public.reservations add column if not exists group_id text;
create index if not exists reservations_group_id_idx
  on public.reservations (group_id) where group_id is not null;

-- 1) Casa Fechada (manual e importada): [Casa toda:X] → cf:X
update public.reservations
   set group_id = 'cf:' || substring(notes from '\[Casa toda:([^\]]+)\]')
 where group_id is null and notes ~ '\[Casa toda:[^\]]+\]';

-- 2) Suíte 11+12 manual: [Suíte grupo:X] → suite:X (só se não for CF)
update public.reservations
   set group_id = 'suite:' || substring(notes from '\[Suíte grupo:([^\]]+)\]')
 where group_id is null and notes ~ '\[Suíte grupo:[^\]]+\]';

-- 3) Suíte 11+12 importada (sem marca): external_uid = <source>-<quarto>-<uid>
update public.reservations
   set group_id = 'suite:ical-' || source || '-' ||
                  substring(external_uid from length(source) + length(room_id) + 3)
 where group_id is null
   and notes = 'Importado via iCal (Suíte 11+12)'
   and room_id in ('11', '12')
   and external_uid like source || '-' || room_id || '-%';

commit;
