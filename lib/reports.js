// Relatórios de ocupação e caixa (PMS-022). Funções puras e reconciliáveis:
// cada total pode ser refeito a partir das linhas que o originaram.
"use strict";
const { ROOM_IDS, isBlocking, isCalendarBlock } = require("./availability");

/** Limites do mês: { start: "AAAA-MM-01", next: 1º dia do mês seguinte, days }. */
function monthBounds(month) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(String(month || ""))) return null;
  const [y, m] = month.split("-").map(Number);
  const next = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, "0")}-01`;
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { start: `${month}-01`, next, days };
}

/** Noites ("AAAA-MM-DD") de [checkIn, checkOut) que caem em [start, next). */
function nightsInRange(checkIn, checkOut, start, next) {
  const from = String(checkIn).slice(0, 10) > start ? String(checkIn).slice(0, 10) : start;
  const to = String(checkOut).slice(0, 10) < next ? String(checkOut).slice(0, 10) : next;
  const out = [];
  for (let d = new Date(from + "T00:00:00Z"); d.toISOString().slice(0, 10) < to; d.setUTCDate(d.getUTCDate() + 1))
    out.push(d.toISOString().slice(0, 10));
  return out;
}

/**
 * Ocupação do mês por quarto e por canal.
 * - Hóspede = reserva que ocupa (confirmada) e não é bloqueio de calendário do Airbnb.
 * - Uma noite com 2+ reservas no mesmo quarto conta 1 vez (e entra em "conflitos").
 * - Bloqueios do Airbnb: noites sem hóspede identificado, contadas à parte.
 */
function occupancy(rows, month) {
  const b = monthBounds(month);
  if (!b) return null;
  // quarto -> noite -> { n: quantas reservas, srcs: Set(canais) }. Conflito = n > 1,
  // inclusive do MESMO canal (ex.: CF importada também pelo feed do quarto).
  const guest = new Map(ROOM_IDS.map(r => [r, new Map()]));
  const blocked = new Map(ROOM_IDS.map(r => [r, new Set()]));
  for (const r of rows || []) {
    const room = String(r.room_id);
    if (!guest.has(room) || !isBlocking(r.status)) continue;
    const nights = nightsInRange(r.check_in, r.check_out, b.start, b.next);
    if (isCalendarBlock(r)) { nights.forEach(n => blocked.get(room).add(n)); continue; }
    const src = ["direto", "airbnb", "booking"].includes(r.source) ? r.source : "outro";
    for (const n of nights) {
      const m = guest.get(room);
      if (!m.has(n)) m.set(n, { n: 0, srcs: new Set() });
      const e = m.get(n); e.n++; e.srcs.add(src);
    }
  }
  const rooms = {};
  const channels = { direto: 0, airbnb: 0, booking: 0, outro: 0 };
  let occupied = 0, conflicts = 0, blockedOnly = 0;
  for (const room of ROOM_IDS) {
    const m = guest.get(room);
    let roomConflicts = 0;
    for (const { n, srcs } of m.values()) {
      if (n > 1) roomConflicts++;
      // Canal da noite: direto > booking > airbnb (só desempate; conflitos são mostrados à parte).
      const ch = ["direto", "booking", "airbnb", "outro"].find(c => srcs.has(c));
      channels[ch]++;
    }
    const blockedNights = [...blocked.get(room)].filter(n => !m.has(n)).length;
    rooms[room] = { occupied: m.size, pct: pct(m.size, b.days), conflicts: roomConflicts, blockedOnly: blockedNights };
    occupied += m.size; conflicts += roomConflicts; blockedOnly += blockedNights;
  }
  const available = ROOM_IDS.length * b.days;
  return { month, days: b.days, available, occupied, pct: pct(occupied, available), channels, conflicts, blockedOnly, rooms };
}

const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : 0);
const cents = (v) => Math.round(Number(v || 0) * 100);
const money = (c) => Math.round(c) / 100;

/**
 * Caixa do mês: pagamentos de reservas diretas (recebidos/estornados no mês),
 * outros lançamentos do Financeiro do mês, a receber no mês e vencidas.
 */
function cash({ paidInMonth = [], dueInMonth = [], overdue = [], transactions = [] }) {
  let received = 0, refunded = 0, otherIncome = 0, expenses = 0, due = 0, late = 0;
  for (const p of paidInMonth) { if (p.kind === "estorno") refunded += cents(p.amount); else received += cents(p.amount); }
  for (const t of transactions) { if (t.type === "income") otherIncome += cents(t.amount); else if (t.type === "expense") expenses += cents(t.amount); }
  for (const p of dueInMonth) if (p.kind !== "estorno") due += cents(p.amount);
  for (const p of overdue) if (p.kind !== "estorno") late += cents(p.amount);
  return {
    received: money(received), refunded: money(refunded), netReceived: money(received - refunded),
    otherIncome: money(otherIncome), expenses: money(expenses),
    result: money(received - refunded + otherIncome - expenses),
    receivableInMonth: money(due), overdueTotal: money(late),
    counts: { payments: paidInMonth.length, transactions: transactions.length, dueInMonth: dueInMonth.length, overdue: overdue.length },
  };
}

module.exports = { monthBounds, nightsInRange, occupancy, cash };
