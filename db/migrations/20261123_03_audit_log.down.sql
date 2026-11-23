-- Rollback de 20261123_03_audit_log.sql
-- ATENÇÃO: remove o histórico de auditoria. Exporte antes se ele já tiver uso
-- (select * from public.audit_log). Não afeta reservas nem pagamentos.
begin;
drop table if exists public.audit_log;
drop function if exists public.audit_log_somente_acrescimo();
commit;
