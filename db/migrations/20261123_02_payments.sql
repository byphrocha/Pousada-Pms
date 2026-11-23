-- =============================================================================
-- PMS-007: pagamentos separados do valor contratado (regra 6).
-- Decisões do Paulo (23/11/2026):
--   * receita entra no Financeiro quando o dinheiro é RECEBIDO (sinal/parcela pagos),
--     não quando a reserva é criada;
--   * só reservas DIRETAS (Airbnb/Booking: a plataforma cuida, inclusive taxas e estornos);
--   * Casa Fechada pode ter sinal + parcelas com vencimento, variando por reserva;
--   * estorno de reserva direta é devolvido via PIX.
-- Aditiva: só cria a tabela nova. Nenhum dado existente é alterado.
-- Rollback: 20261123_02_payments.down.sql (recusa se já houver pagamentos).
-- =============================================================================
begin;

create table if not exists public.payments (
  id             text primary key,
  -- Em CF/11+12 aponta para a 1ª linha do grupo (onde fica o valor contratado).
  reservation_id text not null references public.reservations(id) on delete restrict,
  kind           text not null check (kind in ('sinal', 'parcela', 'pagamento', 'estorno')),
  amount         numeric(10,2) not null check (amount > 0),
  method         text check (method is null or method in ('pix', 'dinheiro', 'cartao', 'transferencia')),
  due_date       date,          -- vencimento (parcela a receber)
  paid_at        date,          -- data em que o dinheiro entrou (ou saiu, no estorno)
  notes          text default '',
  created_at     timestamptz default now(),
  created_by     text,
  constraint payments_has_date        check (paid_at is not null or due_date is not null),
  constraint payments_refund_is_paid  check (kind <> 'estorno' or paid_at is not null),
  constraint payments_paid_has_method check (paid_at is null or method is not null)
);

create index if not exists payments_reservation_idx on public.payments (reservation_id);
create index if not exists payments_paid_at_idx     on public.payments (paid_at);

alter table public.payments enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'payments' and policyname = 'Server only') then
    create policy "Server only" on public.payments for all using (false) with check (false);
  end if;
end $$;

commit;
