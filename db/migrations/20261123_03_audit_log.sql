-- =============================================================================
-- PMS-014: auditoria de alterações (quem fez o quê, quando).
-- Só acréscimo: um gatilho recusa UPDATE e DELETE, inclusive para o servidor.
-- Privacidade (regra 7): o servidor grava só campos operacionais (quarto, datas,
-- status, canal, valor, forma de pagamento). Nome, telefone, CPF e observações
-- NUNCA entram aqui.
-- Aditiva. Rollback: 20261123_03_audit_log.down.sql
-- =============================================================================
begin;

create table if not exists public.audit_log (
  id         bigint generated always as identity primary key,
  at         timestamptz not null default now(),
  user_id    text,
  username   text,
  role       text,
  action     text not null,
  entity     text not null,
  entity_id  text,
  -- Reserva a que o registro se refere (para pagamentos: a linha dona do contrato).
  reservation_id text,
  changes    jsonb not null default '{}'::jsonb
);
create index if not exists audit_log_entity_idx      on public.audit_log (entity, entity_id, at desc);
create index if not exists audit_log_reservation_idx on public.audit_log (reservation_id, at desc);
create index if not exists audit_log_at_idx     on public.audit_log (at desc);

create or replace function public.audit_log_somente_acrescimo() returns trigger
language plpgsql as $$
begin
  raise exception 'audit_log só aceita inclusão (% recusado)', tg_op;
end $$;

drop trigger if exists audit_log_somente_acrescimo on public.audit_log;
create trigger audit_log_somente_acrescimo
  before update or delete on public.audit_log
  for each row execute function public.audit_log_somente_acrescimo();

alter table public.audit_log enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'audit_log' and policyname = 'Server only') then
    create policy "Server only" on public.audit_log for all using (false) with check (false);
  end if;
end $$;

commit;
