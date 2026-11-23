-- =============================================================================
-- PMS-005 camada 2: o banco impede duas ocupações do mesmo quarto em noites que
-- se cruzam. Fecha a corrida que a checagem no servidor não fecha (dois pedidos
-- ao mesmo tempo passavam os dois).
--
-- Regras (as mesmas do servidor, lib/availability.js):
--   * intervalo [check_in, check_out): saída e entrada no mesmo dia NÃO conflitam;
--   * reservas canceladas não ocupam;
--   * "pending" NÃO ocupa (decisão do Paulo, 23/11/2026; mesma regra do servidor);
--   * bloqueios "Not available" do Airbnb não ocupam (são indisponibilidade
--     espelhada, não hóspede). No Booking toda linha se chama "CLOSED - Not
--     available", inclusive reserva real: NÃO são ignoradas;
--   * vale só para estadias que terminam depois de 24/11/2026: o histórico tem
--     duplicatas antigas de importação que não ameaçam ninguém.
--
-- Pré-requisitos em produção (ver db/ENSAIO_CONSTRAINT_2026-11-23.md):
--   backup externo + restauração testada, autorização do Paulo, e ZERO conflitos
--   na consulta de verificação. Se houver conflito, este script falha e não muda nada.
-- Rollback: 20261123_01_reservations_no_overlap.down.sql
-- =============================================================================

begin;

create extension if not exists btree_gist with schema extensions;

-- Falha cedo, com mensagem clara, se ainda houver sobreposição futura.
do $$
declare n int;
begin
  select count(*) into n
  from public.reservations a
  join public.reservations b
    on a.room_id = b.room_id and a.id < b.id
   and a.check_in < b.check_out and b.check_in < a.check_out
  where coalesce(a.status, 'confirmed') not in ('cancelled', 'pending') and coalesce(b.status, 'confirmed') not in ('cancelled', 'pending')
    and a.check_out > date '2026-11-24' and b.check_out > date '2026-11-24'
    and not (a.source = 'airbnb' and a.guest_name ~* '(not available|closed|blocked|bloqueado|indispon|unavailable)')
    and not (b.source = 'airbnb' and b.guest_name ~* '(not available|closed|blocked|bloqueado|indispon|unavailable)');
  if n > 0 then
    raise exception 'Ainda há % par(es) de reservas sobrepostas: resolva antes de criar a constraint', n;
  end if;
end $$;

alter table public.reservations
  add constraint reservations_no_overlap
  exclude using gist (
    room_id with =,
    daterange(check_in, check_out, '[)') with &&
  )
  where (
    coalesce(status, 'confirmed') not in ('cancelled', 'pending')
    and check_out > date '2026-11-24'
    and not (source = 'airbnb' and guest_name ~* '(not available|closed|blocked|bloqueado|indispon|unavailable)')
  );

commit;
