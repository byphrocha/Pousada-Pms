// Parte do frontend da PMS (PMS-017). Carregado em ordem por index.html;
// todos os arquivos compartilham o escopo global, como o antigo script único.
// ─── RELATÓRIOS (PMS-022) ─────────────────────────────────────────────────────
// Ocupação e caixa do mês, calculados no servidor a partir das linhas do banco.
let reportMonth = todayStr().slice(0, 7);
let reportData = null;
let reportError = null;
async function loadReport(month) {
  reportMonth = month;
  reportError = null;
  const d = await api("GET", `/reports/monthly?month=${encodeURIComponent(month)}`);
  if (d && d.occupancy && d.cash && d.month === month) reportData = d;
  else reportError = apiErrorMessage(d) || "Não foi possível carregar o relatório.";
  if (currentView === "relatorios") render();
}
function shiftReportMonth(delta) {
  const [y, m] = reportMonth.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  loadReport(d.toISOString().slice(0, 7));
}
const ROOM_ORDER = ["10","11","12","20","21","22","23","24","25"];
function reportBar(label, value, max, valueText, tooltip) {
  const w = max > 0 ? Math.max(0, Math.min(100, (value / max) * 100)) : 0;
  return `<div title="${esc(tooltip)}" style="display:flex;align-items:center;gap:10px;padding:5px 0">
    <div style="width:64px;font-size:12px;color:var(--tx)">${esc(label)}</div>
    <div style="flex:1;height:10px;background:var(--bg0);border-radius:4px;overflow:hidden">
      <div style="width:${w}%;height:100%;background:var(--bl);border-radius:0 4px 4px 0"></div></div>
    <div style="width:118px;text-align:right;font-size:12px;color:var(--dm)">${esc(valueText)}</div></div>`;
}
function renderRelatorios() {
  const head = `<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:18px">
    <button class="btn" onclick="shiftReportMonth(-1)" aria-label="Mês anterior">‹</button>
    <div style="font-family:'Fraunces',serif;font-size:18px;font-weight:700">${esc((t => t.charAt(0).toUpperCase() + t.slice(1))(fmtMonth(reportMonth + "-01")))}</div>
    <button class="btn" onclick="shiftReportMonth(1)" aria-label="Próximo mês">›</button></div>`;
  if (reportError) return head + `<div style="color:#fca5a5">⚠️ ${esc(reportError)} <button class="btn" onclick="loadReport(reportMonth)">Tentar de novo</button></div>`;
  if (!reportData || reportData.month !== reportMonth) return head + `<div style="color:var(--mu)">Carregando…</div>`;
  const o = reportData.occupancy, c = reportData.cash;
  const tile = (label, value, sub, color) => `<div style="flex:1;min-width:150px;background:var(--bg1);border:1px solid var(--bd);border-radius:12px;padding:14px">
    <div style="font-size:12px;color:var(--mu);font-weight:700">${label}</div>
    <div style="font-size:clamp(18px,5vw,24px);font-weight:700;white-space:nowrap;color:${color || "var(--tx)"};margin-top:4px">${value}</div>
    <div style="font-size:11px;color:var(--mu);margin-top:2px">${sub}</div></div>`;
  const card = (title, body) => `<div style="background:var(--bg1);border:1px solid var(--bd);border-radius:12px;padding:16px;margin-bottom:16px">
    <div style="font-size:13px;color:var(--mu);font-weight:700;margin-bottom:10px">${title}</div>${body}</div>`;
  const chLabel = { direto: "Direto", airbnb: "Airbnb", booking: "Booking", outro: "Outro" };
  const chRows = Object.entries(o.channels).filter(([k, v]) => v > 0 || k !== "outro")
    .map(([k, v]) => reportBar(chLabel[k] || k, v, o.occupied, `${v} noites · ${o.occupied ? Math.round(v / o.occupied * 100) : 0}%`,
      `${chLabel[k] || k}: ${v} de ${o.occupied} noites ocupadas`)).join("");
  const roomRows = ROOM_ORDER.map(id => {
    const r = o.rooms[id] || { occupied: 0, pct: 0, conflicts: 0 };
    return reportBar(`Qto ${id}`, r.occupied, o.days, `${r.occupied}/${o.days} · ${String(r.pct).replace(".", ",")}%${r.conflicts ? " ⚠️" : ""}`,
      `Quarto ${id}: ${r.occupied} de ${o.days} noites com hóspede (${r.pct}%)` + (r.conflicts ? ` — ${r.conflicts} noite(s) com duas reservas` : ""));
  }).join("");
  const line = (label, value, strong, color) => `<tr><td style="padding:5px 0;color:${strong ? "var(--tx)" : "var(--dm)"};font-weight:${strong ? 700 : 400}">${label}</td>
    <td style="padding:5px 0;text-align:right;font-weight:${strong ? 700 : 400};color:${color || "var(--tx)"}">${value}</td></tr>`;
  return head + `
    <div style="display:flex;gap:12px;flex-wrap:wrap;margin-bottom:16px">
      ${tile("Ocupação", `${String(o.pct).replace(".", ",")}%`, `${o.occupied} de ${o.available} noites (9 quartos × ${o.days} dias)`)}
      ${tile("Resultado do mês", fmtMoney(c.result), "recebido − estornos + outras receitas − despesas", c.result < 0 ? "var(--rd)" : "var(--tx)")}
      ${c.paymentsOn ? tile("A receber no mês", fmtMoney(c.receivableInMonth), `${c.counts.dueInMonth} parcela(s) com vencimento no mês`) : ""}
      ${c.paymentsOn && c.overdueTotal > 0 ? tile("🔴 Vencidas", fmtMoney(c.overdueTotal), `${c.counts.overdue} parcela(s), todos os meses`, "var(--rd)") : ""}
    </div>
    ${card("Ocupação por quarto", roomRows +
      (o.conflicts ? `<div style="font-size:11px;color:var(--dm);margin-top:8px">⚠️ ${o.conflicts} noite(s) com duas reservas no mesmo quarto (contadas uma vez). Veja os Alertas.</div>` : ""))}
    ${card("Noites ocupadas por canal", chRows +
      `<div style="font-size:11px;color:var(--mu);margin-top:8px">No Booking toda linha importada se chama "CLOSED", inclusive datas fechadas manualmente: elas contam como ocupação.` +
      (o.blockedOnly ? ` Bloqueios do Airbnb sem hóspede (não contados): ${o.blockedOnly} noite(s).` : "") + `</div>`)}
    ${card("Caixa do mês", `<table style="width:100%;font-size:12px;border-collapse:collapse">
      ${line("Recebido de reservas diretas", fmtMoney(c.received))}
      ${line("(−) Estornos devolvidos", fmtMoney(c.refunded))}
      ${line("Outras receitas do Financeiro", fmtMoney(c.otherIncome))}
      ${line("(−) Despesas do Financeiro", fmtMoney(c.expenses))}
      ${line("= Resultado", fmtMoney(c.result), true, c.result < 0 ? "var(--rd)" : "var(--tx)")}
    </table>
    <div style="font-size:11px;color:var(--mu);margin-top:8px">Airbnb e Booking não entram no caixa do PMS (a plataforma repassa). ${c.counts.payments} pagamento(s) e ${c.counts.transactions} lançamento(s) neste mês.${c.paymentsOn ? "" : " Pagamentos ainda não ativados."}</div>`)}`;
}
