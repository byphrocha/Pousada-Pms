// Reconciliação de calendários iCal (PMS-009, achados I1/I2).
// Funções puras: recebem o que veio do feed e o que está no banco e devolvem
// um PLANO (o que atualizar, o que cancelar). Quem aplica é o server.js,
// conforme ICAL_RECONCILE (report | apply | off).
"use strict";

const { resolveRooms } = require("./availability");

// Como a importação marca as linhas (texto gravado em notes por runSync).
// É um identificador provisório; o modelo definitivo é uma tabela de eventos
// por feed (PMS-009 completo). Linhas cujo notes foi editado à mão não casam
// com nenhum feed e ficam fora da reconciliação (lado seguro).
function feedKindOfRow(notes) {
  const n = String(notes ?? "");
  if (n.startsWith("Importado via iCal (Casa Fechada) [Casa toda:cf-")) return "CF";
  if (n === "Importado via iCal (Suíte 11+12)") return "11+12";
  if (n === "Importado via iCal") return "individual";
  return null;
}

function feedKind(feedRoomId) {
  return feedRoomId === "CF" || feedRoomId === "11+12" ? feedRoomId : "individual";
}

function rowKey(source, room, uid) {
  return `${source}-${room}-${uid}`;
}

/**
 * Monta o plano de reconciliação de UM feed.
 *
 * events: [{ uid, checkIn, checkOut }] vindos do feed nesta execução (já sem erro de rede).
 * rows:   linhas do banco desta origem, nos quartos do feed, status confirmed,
 *         com check_out >= today: { id, room_id, external_uid, check_in, check_out, notes }.
 * missingCounts: Map id → nº de execuções seguidas em que a linha não apareceu no feed.
 * threshold: quantas ausências seguidas antes de propor o cancelamento (padrão 2),
 *            para não cancelar tudo por um feed que veio vazio ou incompleto uma vez.
 *
 * Regras de segurança:
 *  - Feed sem nenhum evento → não propõe nada (pode ser falha do provedor).
 *  - Só olha reservas que ainda não terminaram (check_out >= today): o feed das
 *    OTAs deixa de listar estadias passadas, e isso não é cancelamento (I1).
 *  - Linhas com UID vazio ficam de fora.
 */
function planReconcile({ source, feedRoomId, events, rows, today, missingCounts, threshold = 2 }) {
  const plan = { updates: [], cancels: [], pending: [], skipped: null, nextCounts: new Map(missingCounts || []) };
  const rooms = resolveRooms(feedRoomId);
  if (!rooms) { plan.skipped = "feed com quarto desconhecido"; return plan; }
  if (!events || events.length === 0) { plan.skipped = "feed sem eventos"; return plan; }

  const kind = feedKind(feedRoomId);
  const byKey = new Map();
  for (const ev of events) {
    if (!ev.uid) continue;
    for (const room of rooms) byKey.set(rowKey(source, room, ev.uid), ev);
  }

  for (const r of rows || []) {
    if (feedKindOfRow(r.notes) !== kind) continue;
    if (String(r.check_out).slice(0, 10) < today) continue;
    // Quarto de ORIGEM pelo identificador (source-quarto-uid), não pelo quarto
    // atual: uma reserva realocada (ex.: suíte → quarto 23) continua seguindo o
    // calendário de onde veio.
    const ext = String(r.external_uid || "");
    const origin = rooms.find(room => ext.startsWith(rowKey(source, room, "")));
    if (!origin) continue;
    const uid = ext.slice(rowKey(source, origin, "").length);
    if (!uid) continue;

    const ev = byKey.get(String(r.external_uid));
    if (ev) {
      plan.nextCounts.delete(r.id);
      const curIn = String(r.check_in).slice(0, 10), curOut = String(r.check_out).slice(0, 10);
      if (curIn !== ev.checkIn || curOut !== ev.checkOut)
        plan.updates.push({ id: r.id, room_id: String(r.room_id), from: [curIn, curOut], to: [ev.checkIn, ev.checkOut] });
      continue;
    }
    const n = (plan.nextCounts.get(r.id) || 0) + 1;
    plan.nextCounts.set(r.id, n);
    if (n >= threshold) plan.cancels.push({ id: r.id, room_id: String(r.room_id) });
    else plan.pending.push({ id: r.id, room_id: String(r.room_id), ausencias: n });
  }
  return plan;
}

module.exports = { feedKindOfRow, feedKind, rowKey, planReconcile };
