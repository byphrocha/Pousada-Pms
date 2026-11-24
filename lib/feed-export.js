// PMS-010 passo 2: calendários que o Airbnb e o Booking vão importar do PMS.
// Funções puras. Regras (decididas em 24/11/2026 com base nos dados reais):
//  * ocupa = status não cancelado/pendente, intervalo [check_in, check_out);
//  * produto CF soma os 9 quartos; 11+12 soma 11 e 12; quarto = só ele;
//  * NUNCA exporta bloqueio "Not available" do Airbnb: é consequência (o próprio
//    Airbnb fecha a CF quando vende a suíte, ou é fechamento manual espelhando
//    outra reserva que já está no PMS). Exportar fecharia quartos livres em cadeia;
//  * sem eco: o calendário de um anúncio não devolve as reservas que vieram
//    daquele mesmo anúncio (se o hóspede cancelar lá, a data reabre na hora);
//  * reserva do Booking "CLOSED - Not available" É exportada (pode ser real);
//  * nenhum dado de hóspede no arquivo (achado I6): só "Reservado".
"use strict";

const ALL_ROOMS = ["10", "11", "12", "20", "21", "22", "23", "24", "25"];
const CHANNELS = ["airbnb", "booking"];
const BLOCK_RE = /(not available|closed|blocked|bloqueado|indispon|unavailable)/i; // = constraint

function roomsOf(product) {
  if (product === "CF") return ALL_ROOMS.slice();
  if (product === "11+12") return ["11", "12"];
  return ALL_ROOMS.includes(product) ? [product] : null;
}

// De qual anúncio a linha veio (só faz sentido para linhas importadas).
function originProduct(r) {
  const n = String(r.notes || ""), g = String(r.group_id || "");
  if (g.startsWith("cf:cf-") || n.startsWith("Importado via iCal (Casa Fechada)")) return "CF";
  if (g.startsWith("suite:ical-") || n === "Importado via iCal (Suíte 11+12)") return "11+12";
  return String(r.room_id);
}

const isAirbnbBlock = (r) => r.source === "airbnb" && BLOCK_RE.test(String(r.guest_name || ""));
const occupies = (r) => !["cancelled", "pending"].includes(r.status || "confirmed");

function feedRows(rows, { channel, product }) {
  const rooms = roomsOf(product);
  if (!rooms) return [];
  return (rows || []).filter(r =>
    occupies(r) && rooms.includes(String(r.room_id)) && !isAirbnbBlock(r) &&
    !(channel && r.source === channel && r.external_uid && originProduct(r) === product));
}

// Um evento por período (linhas de quartos diferentes com as mesmas datas viram um só).
function buildCalendar(rows, { channel, product, now = new Date() }) {
  const stamp = now.toISOString().replace(/[-:.]/g, "").slice(0, 15) + "Z";
  const periods = new Map();
  for (const r of rows) {
    const ci = String(r.check_in).slice(0, 10), co = String(r.check_out).slice(0, 10);
    if (!(ci < co)) continue;
    periods.set(`${ci}|${co}`, [ci, co]);
  }
  const slug = String(product).replace(/[^0-9A-Za-z]/g, "");
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", `PRODID:-//PMS Pousada//${channel}//${slug}//PT`,
    "CALSCALE:GREGORIAN", "METHOD:PUBLISH", "X-WR-TIMEZONE:America/Sao_Paulo"];
  for (const [ci, co] of [...periods.values()].sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]))) {
    lines.push("BEGIN:VEVENT", `UID:pms-${slug}-${ci.replace(/-/g, "")}-${co.replace(/-/g, "")}@pousada`,
      `DTSTAMP:${stamp}`, `DTSTART;VALUE=DATE:${ci.replace(/-/g, "")}`, `DTEND;VALUE=DATE:${co.replace(/-/g, "")}`,
      "SUMMARY:Reservado", "STATUS:CONFIRMED", "TRANSP:OPAQUE", "END:VEVENT");
  }
  lines.push("END:VCALENDAR");
  return lines.join("\r\n");
}

module.exports = { ALL_ROOMS, CHANNELS, roomsOf, originProduct, isAirbnbBlock, feedRows, buildCalendar };
