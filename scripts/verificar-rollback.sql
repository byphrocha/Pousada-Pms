-- PMS-016: depois de todos os .down.sql, só o baseline fica.
do $$
begin
  if to_regclass('public.payments') is not null then raise exception 'payments ficou'; end if;
  if to_regclass('public.audit_log') is not null then raise exception 'audit_log ficou'; end if;
  if exists (select 1 from information_schema.columns where table_schema='public' and table_name='reservations' and column_name='group_id')
    then raise exception 'group_id ficou'; end if;
  if exists (select 1 from pg_constraint where conname='reservations_no_overlap') then raise exception 'constraint ficou'; end if;
end $$;
\echo '   ok'
