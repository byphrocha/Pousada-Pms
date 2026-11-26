// Parte do frontend da PMS (PMS-017). Carregado em ordem por index.html;
// todos os arquivos compartilham o escopo global, como o antigo script único.
// ─── CALENDÁRIO DE OCUPAÇÃO (PMS-019) ─────────────────────────────────────────
// Uma linha por quarto físico, uma coluna por NOITE. A reserva ocupa as noites
// [check_in, check_out): saída e entrada no mesmo dia não se sobrepõem.
// CF aparece como UMA barra nas 9 linhas e 11+12 como UMA barra nas 2 linhas,
// desde que o grupo esteja completo e com as mesmas datas; senão, barras soltas
// (mostra a verdade do banco em vez de esconder grupo quebrado).
let calStart = null;      // primeira noite exibida (YYYY-MM-DD)
let calDays  = 14;
const CAL_BLOCK_RE = /(not available|blocked|bloqueado|indispon|unavailable)/i;

function calAddDays(s, n) {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}
function calDiff(a, b) {
  return Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / 86400000);
}

function calendarLayout(list, start, days) {
  const end = calAddDays(start, days);
  const rowOf = Object.fromEntries(ROOMS.map((r, i) => [r.id, i]));
  const visible = (list || []).filter(r => r && r.status !== "cancelled" && rowOf[r.roomId] !== undefined &&
    r.checkIn && r.checkOut && r.checkIn < r.checkOut && r.checkIn < end && r.checkOut > start);

  const tagOf = r => {
    // Coluna de grupo (PMS-006) primeiro; reservas antigas: marcação nas notas.
    const g = String(r.groupId || "");
    if (g.startsWith("cf:")) return "[Casa toda:" + g + "]";
    if (g.startsWith("suite:")) return "[Suíte grupo:" + g + "]";
    const n = r.notes || "";
    const cf = n.match(/\[Casa toda:[^\]]+\]/);
    if (cf) return cf[0];
    const s = n.match(/\[Suíte grupo:[^\]]+\]/);
    return s ? s[0] : null;
  };
  const makeBar = (lead, ids, row, rowSpan, kind) => {
    const col = Math.max(0, calDiff(start, lead.checkIn));
    const endCol = Math.min(days, calDiff(start, lead.checkOut));
    return {
      id: lead.id, ids, row, rowSpan, kind, col, span: endCol - col,
      clipLeft: lead.checkIn < start, clipRight: lead.checkOut > end,
      pending: lead.status === "pending",
      block: lead.source === "airbnb" && CAL_BLOCK_RE.test(lead.guestName || ""),
      source: lead.source || "", guestName: lead.guestName || "",
      roomId: lead.roomId, checkIn: lead.checkIn, checkOut: lead.checkOut,
      conflict: false, lane: 0, lanes: 1,
    };
  };

  const groups = new Map();
  for (const r of visible) {
    const t = tagOf(r);
    if (!t) continue;
    if (!groups.has(t)) groups.set(t, []);
    groups.get(t).push(r);
  }
  const bars = [];
  const grouped = new Set();
  for (const [tag, rows] of groups) {
    const rooms = rows.map(r => r.roomId).sort();
    const first = rows[0];
    const same = rows.every(r => r.checkIn === first.checkIn && r.checkOut === first.checkOut &&
      (r.status || "confirmed") === (first.status || "confirmed"));
    const isCF = tag.startsWith("[Casa toda") && rooms.length === ROOMS.length && new Set(rooms).size === ROOMS.length;
    const isSuite = tag.startsWith("[Suíte") && rooms.length === 2 && rooms[0] === "11" && rooms[1] === "12";
    if (!same || !(isCF || isSuite)) continue;
    const lead = rows.slice().sort((a, b) => (Number(b.amount) || 0) - (Number(a.amount) || 0) || rowOf[a.roomId] - rowOf[b.roomId])[0];
    bars.push(makeBar(lead, rows.map(r => r.id), isCF ? 0 : rowOf["11"], isCF ? ROOMS.length : 2, isCF ? "cf" : "suite"));
    rows.forEach(r => grouped.add(r.id));
  }
  for (const r of visible) if (!grouped.has(r.id)) bars.push(makeBar(r, [r.id], rowOf[r.roomId], 1, "room"));

  // Conflitos: noite em que 2+ reservas que BLOQUEIAM (não pending) ocupam o mesmo quarto.
  const count = {};
  for (const b of bars) {
    if (b.pending) continue;
    for (let row = b.row; row < b.row + b.rowSpan; row++)
      for (let c = b.col; c < b.col + b.span; c++) count[row + ":" + c] = (count[row + ":" + c] || 0) + 1;
  }
  const conflicts = Object.entries(count).filter(([, n]) => n > 1)
    .map(([k]) => { const [row, col] = k.split(":").map(Number); return { row, col, roomId: ROOMS[row].id, date: calAddDays(start, col) }; });
  const conflictSet = new Set(conflicts.map(c => c.row + ":" + c.col));
  for (const b of bars) {
    if (b.pending) continue;
    outer: for (let row = b.row; row < b.row + b.rowSpan; row++)
      for (let c = b.col; c < b.col + b.span; c++) if (conflictSet.has(row + ":" + c)) { b.conflict = true; break outer; }
  }

  // Faixas: barras que se cruzam no mesmo quarto ficam uma em cima da outra, nunca escondidas.
  const touches = (a, b) => a.row < b.row + b.rowSpan && b.row < a.row + a.rowSpan &&
    a.col < b.col + b.span && b.col < a.col + a.span;
  const order = bars.slice().sort((a, b) => a.col - b.col || b.rowSpan - a.rowSpan || String(a.id).localeCompare(String(b.id)));
  const placed = [];
  for (const b of order) {
    const taken = new Set(placed.filter(p => touches(p, b)).map(p => p.lane));
    while (taken.has(b.lane)) b.lane++;
    placed.push(b);
  }
  for (const b of bars) b.lanes = 1 + Math.max(b.lane, ...bars.filter(o => o !== b && touches(o, b)).map(o => o.lane));

  return { start, days, end, bars, conflicts };
}

function calNav(delta) {
  if (delta === 0) calStart = calAddDays(todayStr(), -1);
  else calStart = calAddDays(calStart || calAddDays(todayStr(), -1), delta);
  render();
}
function calSetDays(n) { calDays = n === 31 ? 31 : 14; render(); }

function renderCalendario() {
  if (!calStart) calStart = calAddDays(todayStr(), -1);
  const L = calendarLayout(reservations, calStart, calDays);
  const COL = 38, LBL = 44, ROW = 38, HEAD = 34;
  const today = todayStr();
  const width = LBL + COL * calDays;
  const WEEK = ["dom", "seg", "ter", "qua", "qui", "sex", "sáb"];

  const controls = `<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:12px">
    <button class="btn" onclick="calNav(-7)" title="7 dias antes">◀ 7 dias</button>
    <button class="btn" onclick="calNav(0)">Hoje</button>
    <button class="btn" onclick="calNav(7)" title="7 dias depois">7 dias ▶</button>
    <select onchange="calSetDays(Number(this.value))" style="font-size:12px">
      <option value="14"${calDays === 14 ? " selected" : ""}>14 noites</option>
      <option value="31"${calDays === 31 ? " selected" : ""}>31 noites</option>
    </select>
    <span style="font-size:12px;color:var(--dm)">${esc(fmtDate(L.start))} → ${esc(fmtDate(L.end))} (saída)</span>
  </div>`;

  const conflictMsg = L.conflicts.length
    ? `<div style="font-size:12px;color:#ef4444;background:#ef444414;border:1px solid #ef444455;border-radius:8px;padding:8px 10px;margin-bottom:10px">
        ⚠️ ${L.conflicts.length} noite(s) com conflito neste período (quarto ${[...new Set(L.conflicts.map(c => c.roomId))].map(esc).join(", ")}). Veja em ⚠️ Alertas.</div>`
    : "";

  let head = `<div style="position:sticky;left:0;z-index:3;width:${LBL}px;height:${HEAD}px;background:var(--bg1)"></div>`;
  for (let c = 0; c < calDays; c++) {
    const d = calAddDays(L.start, c);
    const wd = new Date(d + "T12:00:00Z").getUTCDay();
    const isToday = d === today;
    head += `<div style="position:absolute;left:${LBL + c * COL}px;top:0;width:${COL}px;height:${HEAD}px;text-align:center;font-size:10px;line-height:1.3;
      color:${isToday ? "var(--bl)" : wd === 0 || wd === 6 ? "var(--dm)" : "var(--mu)"};font-weight:${isToday ? 800 : 500};padding-top:3px">
      ${WEEK[wd]}<br><b style="font-size:12px;color:${isToday ? "var(--bl)" : "var(--tx)"}">${Number(d.slice(8))}</b></div>`;
  }

  let grid = "";
  ROOMS.forEach((room, i) => {
    grid += `<div style="position:sticky;left:0;z-index:2;width:${LBL}px;height:${ROW}px;background:var(--bg1);border-bottom:1px solid var(--bd);
      display:flex;align-items:center;justify-content:center;font-weight:800;font-size:13px;color:var(--tx)">${esc(room.id)}</div>`;
  });
  for (let c = 0; c < calDays; c++) {
    const d = calAddDays(L.start, c);
    const wd = new Date(d + "T12:00:00Z").getUTCDay();
    const bg = d === today ? "#3b82f61a" : (wd === 0 || wd === 6) ? "#ffffff06" : "transparent";
    grid += `<div style="position:absolute;left:${LBL + c * COL}px;top:0;width:${COL}px;height:${ROW * ROOMS.length}px;background:${bg};border-left:1px solid var(--bd)"></div>`;
  }
  for (const k of L.conflicts)
    grid += `<div style="position:absolute;left:${LBL + k.col * COL}px;top:${k.row * ROW}px;width:${COL}px;height:${ROW}px;background:#ef444433"></div>`;

  for (const b of L.bars) {
    const color = b.block ? "#64748b" : (SRC_COLOR[b.source] || "#64748b");
    const h = (ROW * b.rowSpan - 6) / b.lanes;
    const top = b.row * ROW + 3 + b.lane * h;
    const left = LBL + b.col * COL + (b.clipLeft ? 0 : 3);
    const w = b.span * COL - (b.clipLeft ? 0 : 3) - (b.clipRight ? 0 : 3);
    const icon = b.kind === "cf" ? "🏡 " : b.kind === "suite" ? "🔗 " : "";
    const label = b.block ? "Bloqueio" : guestDisplay(b).text;
    const roomTxt = productName(b.kind === "cf" ? "CF" : b.kind === "suite" ? "11+12" : b.roomId, { cap: true });
    const tip = `${label} — ${roomTxt} — ${fmtDate(b.checkIn)} a ${fmtDate(b.checkOut)} (${nights(b.checkIn, b.checkOut)} noite(s))` +
      `${b.source ? " — " + b.source : ""}${b.pending ? " — pendente (não bloqueia)" : ""}${b.conflict ? " — CONFLITO" : ""}`;
    grid += `<div class="cal-bar" data-ids="${esc(b.ids.join(","))}" onclick="openEditModal('${esc(b.id)}')" title="${esc(tip)}"
      style="position:absolute;left:${left}px;top:${top}px;width:${Math.max(w, 8)}px;height:${Math.max(h - 2, 8)}px;cursor:pointer;overflow:hidden;
      background:${color}33;border:${b.pending ? "1px dashed" : "1px solid"} ${b.conflict ? "#ef4444" : color + "aa"};border-left:4px solid ${b.conflict ? "#ef4444" : color};
      border-radius:${b.clipLeft ? 0 : 4}px ${b.clipRight ? 0 : 4}px ${b.clipRight ? 0 : 4}px ${b.clipLeft ? 0 : 4}px;
      opacity:${b.pending ? .6 : 1};font-size:11px;color:var(--tx);padding:0 5px;white-space:nowrap;text-overflow:ellipsis;
      display:flex;align-items:${b.rowSpan > 1 ? "flex-start;padding-top:4px" : "center"}">${b.clipLeft ? "‹ " : ""}${b.conflict ? "⚠️ " : ""}${icon}${esc(label)}</div>`;
  }

  const legendItem = (color, txt, dashed) => `<span style="display:inline-flex;align-items:center;gap:5px;margin-right:12px">
    <span style="width:14px;height:10px;border-radius:2px;background:${color}33;border:1px ${dashed ? "dashed" : "solid"} ${color};border-left-width:4px"></span>${txt}</span>`;
  const legend = `<div style="font-size:11px;color:var(--dm);margin-top:10px;line-height:2">
    ${legendItem(SRC_COLOR.direto, "Direto")}${legendItem(SRC_COLOR.booking, "Booking")}${legendItem(SRC_COLOR.airbnb, "Airbnb")}
    ${legendItem("#64748b", "Bloqueio")}${legendItem("#94a3b8", "Pendente (não bloqueia)", true)}<span style="margin-right:12px">⚠️ + fundo vermelho = conflito</span>
    <br>🏡 Casa Fechada = uma barra nos 9 quartos · 🔗 11+12 = uma barra nos 2 quartos · cada coluna é uma noite; saída no dia seguinte à última coluna ocupada.</div>`;

  return `${controls}${conflictMsg}
    <div style="overflow-x:auto;-webkit-overflow-scrolling:touch;border:1px solid var(--bd);border-radius:12px;background:var(--bg1)">
      <div style="position:relative;width:${width}px;height:${HEAD}px;border-bottom:1px solid var(--bd)">${head}</div>
      <div style="position:relative;width:${width}px;height:${ROW * ROOMS.length}px">${grid}</div>
    </div>${legend}`;
}
