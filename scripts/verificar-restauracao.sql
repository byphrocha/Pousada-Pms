-- Confere o backup fictício restaurado (scripts/fixtures/backup-ficticio.js).
do $$
begin
  if (select count(*) from public.users) <> 1 then raise exception 'users'; end if;
  if (select name from public.guests where id='g1') <> 'Hóspede O''Teste $pms$' then raise exception 'guests: texto alterado'; end if;
  if (select notes from public.guests where id='g1') <> 'aspas " e \ barra' then raise exception 'guests: escape'; end if;
  if (select count(*) from public.reservations) <> 2 then raise exception 'reservations'; end if;
  if (select amount from public.reservations where id='r1') <> 350.50 then raise exception 'valor'; end if;
  if (select check_out from public.reservations where id='r1') <> date '2099-01-12' then raise exception 'datas'; end if;
  if (select count(*) from public.payments) <> 1 then raise exception 'payments'; end if;
  if (select value->'booking'->>'20' from public.settings where key='ical_urls') is null then raise exception 'settings'; end if;
  if (select changes->>'amount' from public.audit_log where id=41) <> '350.5' then raise exception 'audit_log'; end if;
  -- a identidade continua depois do maior id restaurado
  insert into public.audit_log (action, entity) values ('teste', 'x');
  if (select max(id) from public.audit_log) <> 42 then raise exception 'sequência da auditoria'; end if;
end $$;
\echo '   restauração conferida'
