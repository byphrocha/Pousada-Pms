-- PMS-016: o que tem de valer depois de baseline + migrations. Roda dentro de
-- uma transação desfeita no fim (rollback): não deixa nenhum dado no banco.
-- Datas futuras porque a constraint só olha estadias depois de 24/11/2026.
begin;

do $$
declare ok boolean;
begin
  -- 1. Estrutura
  if to_regclass('public.payments') is null then raise exception 'falta public.payments'; end if;
  if to_regclass('public.audit_log') is null then raise exception 'falta public.audit_log'; end if;
  if not exists (select 1 from information_schema.columns where table_schema='public' and table_name='reservations' and column_name='group_id')
    then raise exception 'falta reservations.group_id'; end if;
  if not exists (select 1 from pg_constraint where conname='reservations_no_overlap')
    then raise exception 'falta a constraint reservations_no_overlap'; end if;
  select bool_and(c.relrowsecurity) into ok from pg_class c join pg_namespace n on n.oid=c.relnamespace
   where n.nspname='public' and c.relkind='r';
  if not ok then raise exception 'há tabela em public sem RLS'; end if;

  -- 2. Regra 4: [entrada, saída) — saída e entrada no mesmo dia não conflitam
  insert into public.reservations (id, room_id, guest_name, check_in, check_out) values
    ('t1', '20', 'Hóspede Teste', '2099-01-10', '2099-01-12'),
    ('t2', '20', 'Hóspede Teste', '2099-01-12', '2099-01-14');

  -- 3. Sobreposição recusada com 23P01 (o que o servidor transforma em 409 ROOM_CONFLICT)
  begin
    insert into public.reservations (id, room_id, guest_name, check_in, check_out) values ('t3', '20', 'Hóspede Teste', '2099-01-11', '2099-01-13');
    raise exception 'sobreposição foi aceita';
  exception when exclusion_violation then null;
  end;

  -- 4. Regra 5: CF num único INSERT — um quarto ocupado recusa o comando inteiro
  begin
    insert into public.reservations (id, room_id, guest_name, check_in, check_out, group_id)
    select 'cf' || r, r, 'Hóspede Teste', '2099-01-11', '2099-01-12', 'cf:teste'
      from unnest(array['10','11','12','20','21','22','23','24','25']) r;
    raise exception 'CF entrou com o quarto 20 ocupado';
  exception when exclusion_violation then null;
  end;
  if exists (select 1 from public.reservations where group_id = 'cf:teste') then raise exception 'CF pela metade'; end if;

  -- 5. Cancelada, pendente e bloqueio do Airbnb não ocupam
  insert into public.reservations (id, room_id, guest_name, check_in, check_out, status, source) values
    ('t4', '20', 'Hóspede Teste', '2099-01-10', '2099-01-12', 'cancelled', 'direto'),
    ('t5', '20', 'Hóspede Teste', '2099-01-10', '2099-01-12', 'pending', 'direto'),
    ('t6', '20', 'Airbnb (Not available)', '2099-01-10', '2099-01-12', 'confirmed', 'airbnb');

  -- 6. Pagamento: estorno sem data é recusado; auditoria só aceita inclusão
  begin
    insert into public.payments (id, reservation_id, kind, amount, method) values ('p1', 't1', 'estorno', 10, 'pix');
    raise exception 'estorno sem data foi aceito';
  exception when check_violation then null;
  end;
  insert into public.audit_log (action, entity) values ('teste', 'reservation');
  begin
    delete from public.audit_log;
    raise exception 'audit_log aceitou apagar';
  exception when raise_exception then
    if sqlerrm not like 'audit_log só aceita inclusão%' then raise; end if;
  end;
end $$;

rollback;
\echo '   ok'
