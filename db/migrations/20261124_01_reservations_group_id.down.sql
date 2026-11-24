-- Rollback de 20261124_01_reservations_group_id.sql
-- Remove só a coluna nova e o índice. As marcas em notes nunca foram alteradas,
-- então nada se perde. O servidor detecta a ausência da coluna e volta ao
-- comportamento anterior (edição linha a linha) sozinho, em até 60 s.
begin;
drop index if exists public.reservations_group_id_idx;
alter table public.reservations drop column if exists group_id;
commit;
