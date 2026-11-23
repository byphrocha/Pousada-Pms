// Inventário de quem consulta os calendários exportados pelo PMS (PMS-010, passo 1).
// Regra 3: antes de trocar qualquer link cadastrado nas OTAs, saber QUAIS links
// elas usam. Guarda só família do visitante, variante do feed, quarto, contagem
// e último acesso — nunca o token, a URL nem o User-Agent completo.
"use strict";

function agentFamily(ua) {
  const s = String(ua || "");
  if (/airbnb/i.test(s)) return "Airbnb";
  if (/booking\.com|bookingcom|\bbooking\b/i.test(s)) return "Booking";
  if (/vrbo|expedia|homeaway/i.test(s)) return "Vrbo/Expedia";
  if (/google/i.test(s)) return "Google";
  if (/dataaccessd|calendaragent|ical|apple|macos|iphone|ipad/i.test(s)) return "Apple";
  if (/outlook|microsoft/i.test(s)) return "Microsoft";
  if (/curl|wget|python|node-fetch|axios|go-http/i.test(s)) return "script";
  if (/mozilla|chrome|safari|firefox|edge/i.test(s)) return "navegador";
  return "outro";
}

/** Soma um acesso ao inventário (objeto simples, serializável em jsonb). */
function addAccess(inv, { variant, room, agent, status, at }) {
  const key = `${variant}:${room}`;
  const feed = (inv[key] ||= { variant, room, agents: {} });
  const a = (feed.agents[agent] ||= { count: 0, firstAt: at, lastAt: at, lastStatus: status });
  a.count += 1;
  if (at < a.firstAt) a.firstAt = at;
  if (at >= a.lastAt) { a.lastAt = at; a.lastStatus = status; }
  return inv;
}

/** Junta inventário guardado + acessos novos (para gravar sem perder contagem). */
function mergeInventory(stored, pending) {
  const out = JSON.parse(JSON.stringify(stored || {}));
  for (const [key, feed] of Object.entries(pending || {})) {
    for (const [agent, a] of Object.entries(feed.agents || {})) {
      const f = (out[key] ||= { variant: feed.variant, room: feed.room, agents: {} });
      const cur = f.agents[agent];
      if (!cur) { f.agents[agent] = { ...a }; continue; }
      cur.count += a.count;
      if (a.firstAt < cur.firstAt) cur.firstAt = a.firstAt;
      if (a.lastAt >= cur.lastAt) { cur.lastAt = a.lastAt; cur.lastStatus = a.lastStatus; }
    }
  }
  return out;
}

module.exports = { agentFamily, addAccess, mergeInventory };
