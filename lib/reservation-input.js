// PMS-004 (P1.2 do plano): valida os campos da reserva no servidor.
// Antes, valor inválido era TROCADO em silêncio: status errado virava
// "confirmed" (um "canceled" com erro de digitação reativava a reserva), valor
// "abc" virava 0 (apagava o valor contratado), canal inválido virava "direto".
// Agora é recusado com 400 e mensagem. Campo ausente/vazio continua opcional.
"use strict";

const STATUSES = ["confirmed", "cancelled", "pending"];
const SOURCES  = ["direto", "booking", "airbnb"];
const PAYMENTS = ["pix", "dinheiro", "cartao", "transferencia"];
const STATUS_LABEL = { confirmed: "confirmada", cancelled: "cancelada", pending: "pendente" };

const given = (b, k) => b[k] !== undefined && b[k] !== null && b[k] !== "";

/**
 * Devolve a mensagem do primeiro problema, ou null.
 * partial: edição (PUT) — só valida o que veio; nome, se vier, não pode ser vazio.
 */
function checkReservationInput(b, { partial = false } = {}) {
  if (!b || typeof b !== "object") return "Corpo da requisição inválido.";
  if (given(b, "status") && !STATUSES.includes(b.status))
    return `Status inválido. Use: ${STATUSES.map(s => `${s} (${STATUS_LABEL[s]})`).join(", ")}.`;
  if (given(b, "source") && !SOURCES.includes(b.source))
    return `Canal inválido. Use: ${SOURCES.join(", ")}.`;
  if (given(b, "payment") && !PAYMENTS.includes(b.payment))
    return `Forma de pagamento inválida. Use: ${PAYMENTS.join(", ")}.`;
  // Adultos: 0 é aceito (a CF divide os adultos pelos 9 quartos e pode dar 0) e
  // gravado como 1; negativo, fração ou texto são recusados.
  for (const [k, max, label] of [["adults", 40, "adultos"], ["children", 20, "crianças"]]) {
    if (!given(b, k)) continue;
    const n = Number(b[k]);
    if (!Number.isInteger(n) || n < 0 || n > max) return `Número de ${label} inválido (de 0 a ${max}).`;
  }
  if (given(b, "amount")) {
    const n = Number(b.amount);
    if (!Number.isFinite(n) || n < 0 || n > 10000000) return "Valor inválido: use um número igual ou maior que zero.";
  }
  if (partial && "guestName" in b && String(b.guestName ?? "").trim() === "")
    return "O nome do hóspede não pode ficar vazio.";
  for (const [k, max, label] of [["guestName", 200, "O nome"], ["phone", 30, "O telefone"], ["notes", 2000, "As observações"]])
    if (given(b, k) && String(b[k]).length > max) return `${label} passa de ${max} caracteres.`;
  return null;
}

module.exports = { STATUSES, SOURCES, PAYMENTS, checkReservationInput };
