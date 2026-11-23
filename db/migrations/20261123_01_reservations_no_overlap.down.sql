-- Rollback de 20261123_01_reservations_no_overlap.sql
-- Remove só a constraint. Nenhum dado é alterado. A extensão btree_gist fica
-- (inofensiva; remover poderia quebrar outro objeto que passe a usá-la).
begin;
alter table public.reservations drop constraint if exists reservations_no_overlap;
commit;
