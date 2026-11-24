// Quais conflitos de sincronização merecem aviso no celular, e o texto do aviso.
// Só quarto, canal e datas: nunca nome, telefone ou observação de hóspede.
"use strict";

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

module.exports = { currentConflicts, diffConflicts, conflictMessage };
