-- Rollback de 20261123_02_payments.sql
-- Recusa apagar a tabela se já existir algum pagamento (perderia dinheiro registrado).
-- Para forçar, exporte os pagamentos antes e apague-os conscientemente.
begin;
do $$
declare n int;
begin
  if to_regclass('public.payments') is null then return; end if;
  select count(*) into n from public.payments;
  if n > 0 then
    raise exception 'payments tem % registro(s): exporte e confirme antes de remover a tabela', n;
  end if;
end $$;
drop table if exists public.payments;
commit;
