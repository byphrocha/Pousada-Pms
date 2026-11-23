// Auditoria (PMS-014). Funções puras que decidem O QUE pode ser gravado.
// Regra 7 (privacidade): só campos operacionais. Nome, telefone, CPF, e-mail e
// observações nunca entram — no máximo o NOME do campo ("editou observações").
"use strict";

const RESERVATION_FIELDS = Object.freeze(["room_id", "check_in", "check_out", "status", "source", "amount", "payment", "adults", "children"]);
const PAYMENT_FIELDS = Object.freeze(["kind", "amount", "method", "due_date", "paid_at"]);
// Campos que podem mudar mas cujo VALOR não é registrado.
const PRIVATE_FIELDS = Object.freeze({ guest_name: "nome", phone: "telefone", notes: "observações", email: "e-mail", cpf: "CPF" });

// Só estes campos são números; quarto ("21") e datas continuam texto.
const NUMERIC = new Set(["amount", "adults", "children"]);
function norm(field, v) {
  if (v === undefined || v === null || v === "") return null;
  if (NUMERIC.has(field)) { const n = Number(v); return Number.isFinite(n) ? n : null; }
  if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v)) return v.slice(0, 10);
  return String(v);
}

/** Recorte permitido de uma linha (para criar/apagar). */
function snapshot(row, fields = RESERVATION_FIELDS) {
  const out = {};
  for (const f of fields) if (row && row[f] !== undefined) out[f] = norm(f, row[f]);
  return out;
}

/**
 * Diferença entre antes e depois: { campo: [antes, depois] } só dos campos permitidos,
 * e "privados" = lista de NOMES de campos pessoais que mudaram (sem valores).
 */
function diff(before, after, fields = RESERVATION_FIELDS) {
  const changes = {};
  for (const f of fields) {
    if (!after || after[f] === undefined) continue;
    const a = norm(f, before ? before[f] : undefined), b = norm(f, after[f]);
    if (a !== b) changes[f] = [a, b];
  }
  const privados = Object.keys(PRIVATE_FIELDS)
    .filter(f => after && after[f] !== undefined && String(after[f] ?? "") !== String((before && before[f]) ?? ""))
    .map(f => PRIVATE_FIELDS[f]);
  if (privados.length) changes.privados = privados;
  return changes;
}

/** Ação de uma edição de reserva: cancelar tem nome próprio. */
function reservationAction(changes) {
  if (changes.status && changes.status[1] === "cancelled") return "reserva.cancelar";
  if (changes.status && changes.status[0] === "cancelled") return "reserva.reativar";
  return "reserva.editar";
}

module.exports = { RESERVATION_FIELDS, PAYMENT_FIELDS, PRIVATE_FIELDS, snapshot, diff, reservationAction };
