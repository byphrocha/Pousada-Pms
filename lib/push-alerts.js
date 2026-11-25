// Quais conflitos de sincronização merecem aviso no celular, e o texto do aviso.
// Só quarto, canal e datas: nunca nome, telefone ou observação de hóspede.
"use strict";
const { computeHealth, STALE_AFTER_MIN } = require("./sync-status");

const CHANNEL = { airbnb: "Airbnb", booking: "Booking" };
const productLabel = (id) => id === "CF" ? "Casa Fechada" : id === "11+12" ? "Suíte 11+12" : "quarto " + id;
const br = (d) => /^\d{4}-\d{2}-\d{2}$/.test(String(d)) ? `${d.slice(8, 10)}/${d.slice(5, 7)}` : String(d);

// Conflitos atuais do status salvo (lib/sync-status.mergeStatus).
function currentConflicts(status) {
  const out = [];
  for (const [feed, f] of Object.entries((status && status.feeds) || {}))
    for (const c of f.conflicts || [])
      out.push({ key: `${feed}|${c.room}|${c.checkIn}|${c.checkOut}`, feed, room: String(c.room), checkIn: c.checkIn, checkOut: c.checkOut });
  return out;
}

// Novos = ainda não avisados. "notified" volta a ser só o que existe agora:
// conflito resolvido sai da lista e, se voltar, avisa de novo.
function diffConflicts(status, notifiedKeys) {
  const seen = new Set(Array.isArray(notifiedKeys) ? notifiedKeys : []);
  const now = currentConflicts(status);
  return { fresh: now.filter(c => !seen.has(c.key)), notified: now.map(c => c.key) };
}

function conflictMessage(c) {
  const [source, product] = String(c.feed).split("/");
  return {
    title: "⚠️ Possível overbooking",
    body: `${CHANNEL[source] || source} ${productLabel(product || c.room)}: ${br(c.checkIn)} → ${br(c.checkOut)} já está ocupado na PMS. Confira na plataforma.`,
  };
}

// Calendário parado: sem leitura bem-sucedida há mais de STALE_AFTER_MIN.
// Calendário com conflito também fica sem "sucesso", mas esse já tem o próprio
// aviso: não entra aqui (evita dois avisos para a mesma coisa).
function staleFeeds(status, nowMs) {
  const h = computeHealth(status, nowMs); // sem nenhuma passada: stale vem vazio
  const withConflict = new Set(currentConflicts(status).map(c => c.feed));
  const problem = Object.fromEntries((h.failing || []).map(f => [f.feed, f.problem]));
  return (h.stale || []).filter(s => !withConflict.has(s.feed)).map(s => ({ key: `stale|${s.feed}`, feed: s.feed, problem: problem[s.feed] || null }));
}

function feedName(feed) {
  const [source, product] = String(feed).split("/");
  return `${CHANNEL[source] || source} ${productLabel(product)}`;
}
function staleMessage(s) {
  const horas = STALE_AFTER_MIN >= 60 ? `${STALE_AFTER_MIN / 60} h` : `${STALE_AFTER_MIN} min`;
  return {
    title: "⚠️ Calendário parado",
    body: `${feedName(s.feed)} sem atualizar há mais de ${horas}${s.problem ? ` (${s.problem})` : ""}. ` +
      "Reservas novas desse anúncio podem não estar na PMS: confira na plataforma.",
  };
}
function recoveredMessage(feed) {
  return { title: "✅ Calendário voltou", body: `${feedName(feed)} voltou a atualizar normalmente.` };
}

// Tudo o que merece aviso agora, comparado com o que já foi avisado.
// notified guarda as chaves atuais (conflitos e calendários parados).
function diffAlerts(status, nowMs, notifiedKeys) {
  const seen = new Set(Array.isArray(notifiedKeys) ? notifiedKeys : []);
  const conflicts = currentConflicts(status);
  const stale = staleFeeds(status, nowMs);
  const messages = [
    ...conflicts.filter(c => !seen.has(c.key)).map(conflictMessage),
    ...stale.filter(s => !seen.has(s.key)).map(staleMessage),
  ];
  // Voltou: estava avisado como parado, não está mais parado e o calendário
  // ainda existe sem problema (removido da configuração não gera aviso).
  const staleNow = new Set(stale.map(s => s.key));
  const feeds = (status && status.feeds) || {};
  for (const k of seen) {
    if (!k.startsWith("stale|") || staleNow.has(k)) continue;
    const feed = k.slice(6);
    if (feeds[feed] && !feeds[feed].problem) messages.push(recoveredMessage(feed));
  }
  return { messages, notified: [...conflicts.map(c => c.key), ...stale.map(s => s.key)] };
}

// Reservas que a sincronização cancelou por sumirem do calendário. CF/11+12
// viram uma mensagem por grupo. Bloqueio automático do Airbnb não avisa.
const AIRBNB_BLOCK = /(not available|blocked|bloqueado|indispon|unavailable)/i;
function cancelledMessages(rows, source, feedProduct) {
  const seen = new Set(), out = [];
  for (const r of rows || []) {
    if (String(r.source || source) === "airbnb" && AIRBNB_BLOCK.test(String(r.guest_name || ""))) continue;
    const key = r.group_id || r.id;
    if (seen.has(key)) continue;
    seen.add(key);
    const product = r.group_id ? feedProduct : r.room_id;
    out.push({
      title: "❌ Reserva saiu do calendário",
      body: `${CHANNEL[source] || source} ${productLabel(product)}: ${br(r.check_in)} → ${br(r.check_out)} sumiu do calendário e foi cancelada na PMS. ` +
        "Confira na plataforma se foi cancelada mesmo; se ela voltar, a PMS reativa sozinha.",
    });
  }
  return out;
}

module.exports = { cancelledMessages, currentConflicts, diffConflicts, conflictMessage, staleFeeds, staleMessage, recoveredMessage, diffAlerts };
