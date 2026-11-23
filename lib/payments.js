// Pagamentos de reservas diretas (PMS-007). Funções puras.
// Regra 6: valor contratado NÃO é dinheiro recebido. Receita = pagamentos com
// data de pagamento; o que ainda vai entrar fica "a receber" com vencimento.
"use strict";
const { isBusinessDate } = require("./availability");

const KINDS = Object.freeze(["sinal", "parcela", "pagamento", "estorno"]);
const METHODS = Object.freeze(["pix", "dinheiro", "cartao", "transferencia"]);
const MAX_AMOUNT = 1000000;
const KIND_LABEL = Object.freeze({ sinal: "Sinal", parcela: "Parcela", pagamento: "Pagamento", estorno: "Estorno" });

const cents = (v) => Math.round(Number(v) * 100);
const money = (c) => Math.round(c) / 100;

/**
 * Valida um pagamento novo (ou o resultado final de uma edição).
 * Retorna { error } ou { value } já normalizado para o banco.
 */
function validatePayment(b, today) {
  if (!b || typeof b !== "object") return { error: "Dados do pagamento inválidos" };
  const kind = String(b.kind || "");
  if (!KINDS.includes(kind)) return { error: "Tipo deve ser sinal, parcela, pagamento ou estorno" };
  const amount = typeof b.amount === "number" ? b.amount : Number(String(b.amount ?? "").replace(",", "."));
  if (!Number.isFinite(amount) || amount <= 0 || amount > MAX_AMOUNT) return { error: "Valor deve ser maior que zero" };
  if (Math.abs(cents(amount) - amount * 100) > 1e-6) return { error: "Valor com mais de 2 casas decimais" };
  const dueDate = b.dueDate ? String(b.dueDate) : null;
  const paidAt = b.paidAt ? String(b.paidAt) : null;
  if (dueDate && !isBusinessDate(dueDate)) return { error: "Vencimento inválido" };
  if (paidAt && !isBusinessDate(paidAt)) return { error: "Data de pagamento inválida" };
  if (!dueDate && !paidAt) return { error: "Informe a data em que foi pago ou o vencimento" };
  if (paidAt && today && paidAt > today) return { error: "Data de pagamento no futuro: use o vencimento" };
  if (kind === "estorno" && !paidAt) return { error: "Estorno precisa da data em que foi devolvido" };
  const method = b.method ? String(b.method) : null;
  if (method && !METHODS.includes(method)) return { error: "Forma de pagamento inválida" };
  if (paidAt && !method) return { error: "Informe a forma de pagamento" };
  return { value: {
    kind, amount: money(cents(amount)), method, due_date: dueDate, paid_at: paidAt,
    notes: String(b.notes || "").slice(0, 500),
  } };
}

/**
 * Resumo financeiro de uma reserva: contratado, recebido, estornado, saldo, a receber.
 * Contas em centavos para não acumular erro de ponto flutuante.
 */
function summarize(contracted, payments, today) {
  let received = 0, refunded = 0, scheduled = 0;
  const overdue = [];
  for (const p of payments || []) {
    const c = cents(p.amount);
    if (p.paid_at) {
      if (p.kind === "estorno") refunded += c; else received += c;
    } else if (p.kind !== "estorno") {
      scheduled += c;
      if (today && p.due_date && p.due_date < today) overdue.push(p.id);
    }
  }
  const contractedC = cents(contracted || 0);
  const net = received - refunded;
  return {
    contracted: money(contractedC),
    received: money(received),
    refunded: money(refunded),
    net: money(net),
    balance: money(contractedC - net),            // quanto falta receber
    scheduled: money(scheduled),                   // parcelas cadastradas ainda não pagas
    unscheduled: money(contractedC - net - scheduled), // saldo sem parcela cadastrada
    overdue,
  };
}

/** Pagamento pago → linha somente leitura do Financeiro (receita, ou despesa se estorno). */
function toFinanceRow(p, reservation) {
  const room = reservation ? (reservation.room_label || reservation.room_id) : "?";
  const who = reservation && reservation.guest_name ? ` — ${reservation.guest_name}` : "";
  return {
    id: `pay:${p.id}`,
    type: p.kind === "estorno" ? "expense" : "income",
    category: p.kind === "estorno" ? "estorno_reserva" : "reserva_direta",
    description: `${KIND_LABEL[p.kind] || p.kind} reserva Qto ${room}${who}`,
    amount: Number(p.amount),
    date: p.paid_at,
    month: String(p.paid_at).slice(0, 7),
    reservation_id: p.reservation_id,
    payment_id: p.id,
    readonly: true,
  };
}

/** Marca de grupo nas notas: Casa toda tem precedência (11 e 12 da CF têm as duas). */
function groupTag(notes) {
  const n = String(notes || "");
  const cf = /\[Casa toda:([^\]]+)\]/.exec(n);
  if (cf) return `[Casa toda:${cf[1]}]`;
  const s = /\[Suíte grupo:([^\]]+)\]/.exec(n);
  return s ? `[Suíte grupo:${s[1]}]` : null;
}

/**
 * Linha "dona" do contrato num grupo (onde ficam valor e pagamentos):
 * a de maior valor; empate → criada primeiro; depois menor id.
 */
function pickLead(rows) {
  return [...(rows || [])].sort((a, b) =>
    (Number(b.amount) || 0) - (Number(a.amount) || 0) ||
    String(a.created_at || "").localeCompare(String(b.created_at || "")) ||
    String(a.id).localeCompare(String(b.id)))[0] || null;
}

module.exports = { KINDS, METHODS, KIND_LABEL, validatePayment, summarize, toFinanceRow, groupTag, pickLead };
