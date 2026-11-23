-- =============================================================================
-- PMS Pousada — esquema base (estado de produção em 23/11/2026)
-- Reconstruído do catálogo de produção (pg_attribute, pg_constraint, pg_policies),
-- só estrutura: nenhum dado. Usado para montar o staging e como ponto de partida
-- das migrations (PMS-016).
-- Não rodar em produção: lá estas tabelas já existem.
-- =============================================================================

create table if not exists public.users (
  id            text primary key,
  username      text not null unique,
  password_hash text not null,
  role          text not null default 'staff',
  created_at    timestamptz default now()
);

create table if not exists public.guests (
  id         text primary key,
  name       text not null,
  phone      text default '',
  email      text default '',
  cpf        text default '',
  address    text default '',
  notes      text default '',
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table if not exists public.reservations (
  id           text primary key,
  room_id      text not null,
  guest_name   text not null,
  check_in     date not null,
  check_out    date not null,
  source       text default 'direto',
  adults       integer default 2,
  children     integer default 0,
  phone        text default '',
  notes        text default '',
  status       text default 'confirmed',
  external_uid text unique,
  created_at   timestamptz default now(),
  amount       numeric(10,2) default 0,
  payment      text default 'pix'
);

create table if not exists public.settings (
  key   text primary key,
  value jsonb
);

create table if not exists public.transactions (
  id             text primary key,
  type           text not null,
  category       text not null,
  description    text not null,
  amount         numeric(10,2) not null,
  date           date not null,
  month          text not null,
  reservation_id text,
  created_at     timestamptz default now()
);

create table if not exists public.prereservations (
  id         text primary key,
  room_id    text,
  guest_name text,
  phone      text,
  check_in   date,
  check_out  date,
  notes      text,
  status     text default 'aguardando',
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- RLS "Server only" em todas (aplicado em produção em 23/11/2026):
-- a chave pública não lê nem grava nada; o servidor usa a chave secreta.
do $$
declare t text;
begin
  foreach t in array array['users','guests','reservations','settings','transactions','prereservations'] loop
    execute format('alter table public.%I enable row level security', t);
    if not exists (select 1 from pg_policies where schemaname='public' and tablename=t and policyname='Server only') then
      execute format('create policy "Server only" on public.%I for all using (false) with check (false)', t);
    end if;
  end loop;
end $$;
