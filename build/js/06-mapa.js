// Parte do frontend da PMS (PMS-017). Carregado em ordem por index.html;
// todos os arquivos compartilham o escopo global, como o antigo script único.
// ─── MAP VIEW ─────────────────────────────────────────────────────────────────
// Grupo da reserva (PMS-006: group_id; reservas antigas: marcação nas notas).
const isCasaFechadaRes = r => String(r.groupId || "").startsWith("cf:") || /\[Casa toda:/.test(r.notes || "");
// Uma entrada por estadia: CF e 11+12 viram uma linha só, com o nome do produto.
function oneStayPerGroup(list) {
  const seen = new Set(), out = [];
  for (const r of list) {
    const tag = r.groupId || ((r.notes || "").match(/\[(?:Casa toda|Suíte grupo):([^\]]+)\]/) || [])[1] ||
      (isSuiteRes(r) ? `suite|${r.source}|${r.checkIn}|${r.checkOut}` : null);
    const key = tag ? "g:" + tag : "r:" + r.id;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ res: r, label: isCasaFechadaRes(r) ? "CF" : isSuiteRes(r) ? "11+12" : r.roomId });
  }
  return out;
}
const cfToday = pred => reservations.find(r => occupies(r) && isCasaFechadaRes(r) && pred(r, todayStr())) || null;
function getCasaFechadaToday()    { return cfToday((r, t) => r.checkIn <= t && r.checkOut > t); }
function getCasaFechadaCheckin()  { return cfToday((r, t) => r.checkIn === t); }
function getCasaFechadaCheckout() { return cfToday((r, t) => r.checkOut === t); }

// Cartão de quarto: superfície neutra, faixa e etiqueta na cor do estado (o estado
// vem escrito, não só pela cor), hóspede e data de saída. Um desenho só para
// todos os quartos, inclusive 11 e 12 dentro da suíte.
// Nome para exibir. O iCal do Airbnb/Booking não traz o nome do hóspede: chega
// "Reserved", "CLOSED - Not available" etc. Mostra o canal em vez do texto do feed.
// Só exibição: o dado no banco não muda.
const SRC_LABEL = { direto: "Direto", booking: "Booking", airbnb: "Airbnb" };
function guestDisplay(r) {
  const n = String((r && r.guestName) || "").trim();
  const src = SRC_LABEL[r && r.source] || "";
  if (r && r.source === "airbnb" && CAL_BLOCK_RE.test(n)) return { text: "Bloqueio Airbnb", generic: true };
  if (!n || GENERIC_NAMES.test(n)) return { text: src ? `${src} · sem nome` : "Sem nome", generic: true };
  return { text: n, generic: false };
}

function roomCardHtml(room, st, res, cf) {
  const s = STATUS[st] || STATUS.free;
  const g = res ? guestDisplay(res) : null;
  const src = res && SRC_LABEL[res.source] ? ` · ${SRC_LABEL[res.source]}` : "";
  const out = res && res.checkOut ? `<div class="rc-out">sai ${esc(fmtDate(res.checkOut).slice(0, 5))}${esc(src)}</div>` : "";
  return `<div class="room-card st-${esc(st)}" style="--sc:${s.color}" onclick="handleRoomClick('${esc(room.id)}')"
    title="Quarto ${esc(room.id)} — ${esc(s.label)}${g ? " — " + esc(g.text) : ""}">
    <div class="rc-top"><span class="room-num">${esc(room.id)}</span><span class="rc-chip">${s.icon} ${esc(s.label)}</span></div>
    <div class="room-type">${esc(room.type)} · <span class="nw">${room.climate === "AC" ? "❄ AC" : "💨 Vent."}</span></div>
    ${res ? `<div class="rc-guest${g.generic ? " rc-empty" : ""}">${esc(g.text)}</div>${out}` : ""}
    ${!cf && st === "checkin" ? `<button class="clean-btn rc-act" onclick="markCheckedIn('${esc(room.id)}',event)">✓ Check-in feito</button>` : ""}
    ${!cf && st === "cleaning" ? `<button class="clean-btn rc-act" onclick="markClean('${esc(room.id)}',event)">✓ Limpo</button>` : ""}
    ${(() => { const k = !cf && undoableMark(room.id); return k
      ? `<button class="rc-undo" onclick="unmarkRoomState('${esc(room.id)}','${k}',event)">↩ Desfazer ${UNDO_LABEL[k]}</button>` : ""; })()}
  </div>`;
}

function renderMap() {
  const t        = todayStr();
  const cfAtiva    = getCasaFechadaToday();
  const cfCheckin  = getCasaFechadaCheckin();
  const cfCheckout = getCasaFechadaCheckout();

  // Se há Casa Fechada, todos os quartos são contados como ocupados
  // Quartos físicos ocupados (um quarto com duas linhas conta uma vez).
  const occupied = cfAtiva
    ? ROOMS.map(r => ({roomId: r.id}))  // virtual: todos ocupados
    : [...new Set(reservations.filter(r=>occupies(r)&&r.checkIn<=t&&r.checkOut>t).map(r=>r.roomId))].map(roomId=>({roomId}));

  // Chegadas e saídas: uma por estadia (CF e 11+12 contam uma vez). Pendente fica à parte.
  const checkins  = oneStayPerGroup(reservations.filter(r=>occupies(r)&&r.checkIn===t));
  const checkouts = oneStayPerGroup(reservations.filter(r=>occupies(r)&&r.checkOut===t));
  const toConfirm = oneStayPerGroup(reservations.filter(r=>r.status==="pending"&&r.checkIn===t));
  const cleaning  = cfAtiva ? [] : ROOMS.filter(r=>getRoomStatus(r.id)==="cleaning");

  // KPIs
  let html = `<div class="kpi-grid">`;
  [
    [cfAtiva ? ROOMS.length : occupied.length, "#ef4444","Ocupados"],
    [checkins.length,  "#3b82f6","Check-ins"],
    [checkouts.length, "#f59e0b","Check-outs"],
    [cfAtiva ? 0 : cleaning.length, "#a855f7","Em Limpeza"],
    [cfAtiva ? 0 : ROOMS.length - occupied.length - cleaning.length, "#22c55e","Disponíveis"],
  ].forEach(([v,c,l])=>{
    html+=`<div class="kpi" style="--kc:${c}"><div class="val">${v}</div><div class="lbl"><span class="legend-dot" style="background:${c}"></span>${l}</div></div>`;
  });
  html+=`</div>`;

  // Banner Casa Fechada
  if (cfAtiva) {
    html+=`<div style="background:#0f1e2b;border:1px solid #3b82f644;border-radius:10px;padding:12px 18px;
      margin-bottom:16px;display:flex;align-items:center;gap:12px">
      <span style="font-size:24px">🏡</span>
      <div>
        <div style="font-size:13px;font-weight:700;color:#3b82f6">Casa Fechada</div>
        <div class="meta-tight">
          ${esc(cfAtiva.guestName)} · ${fmtRange(cfAtiva.checkIn, cfAtiva.checkOut)}
        </div>
      </div>
      <span class="pill" style="background:#3b82f622;color:#3b82f6;margin-left:auto">CF</span>
    </div>`;
  }

  // Legend
  html+=`<div class="legend">`;
  Object.entries(STATUS).forEach(([k,v])=>{
    html+=`<div class="legend-item"><div class="legend-dot" style="background:${v.color}"></div>${v.label}</div>`;
  });
  html+=`</div>`;

  // Room grid — quartos 11 e 12 aparecem agrupados como suíte
  html+=`<div class="room-grid">`;
  ROOMS.forEach(room=>{
    // Quarto 11 → abre o bloco da suíte
    if (room.id==="11") {
      const st11 = cfAtiva ? "occupied" : getRoomStatus("11");
      const st12 = cfAtiva ? "occupied" : getRoomStatus("12");
      const res11= cfAtiva ? cfAtiva : getRoomRes("11");
      const res12= cfAtiva ? cfAtiva : getRoomRes("12");
      const suiteOccupied = ["11","12"].every(id=>["occupied","checkin"].includes(getRoomStatus(id)));
      const bothFree      = ["11","12"].every(id=>getRoomStatus(id)==="free");

      html+=`<div class="suite-group">
        <div class="suite-label">🔗 Suíte 11+12</div>
        <div class="suite-rooms">
          ${roomCardHtml(ROOMS.find(r=>r.id==="11"), st11, res11, !!cfAtiva)}
          ${roomCardHtml(ROOMS.find(r=>r.id==="12"), st12, res12, !!cfAtiva)}
        </div>
        ${bothFree
          ? `<button class="suite-join-btn" onclick="openSuiteModal()">+ Reservar Suíte 11+12 juntos</button>`
          : suiteOccupied
            ? `<div style="font-size:12px;color:#f59e0b;text-align:center;padding:4px 0;opacity:.8">Suíte ocupada em conjunto</div>`
            : ""}
      </div>`;
      return; // pula o render individual do 11
    }
    if (room.id==="12") return; // já renderizado dentro da suíte

    // Casa Fechada: todos os quartos ocupados
    const st  = cfAtiva ? "occupied" : getRoomStatus(room.id);
    const s   = STATUS[st];
    const res = cfAtiva ? cfAtiva : getRoomRes(room.id);
    html+=roomCardHtml(room, st, res, !!cfAtiva);
  });
  html+=`</div>`;

  // Hoje agenda
  if (checkins.length||checkouts.length||toConfirm.length) {
    html+=`<div class="agenda"><div class="section-title">Hoje</div>
    <div class="agenda-grid">`;
    const cols = [["Chegadas (check-in)",checkins,"#3b82f6","#0f1e2b"],["Saídas (check-out)",checkouts,"#f59e0b","#2b1e0a"]];
    // Pendente não ocupa o quarto: aparece à parte até ser confirmada.
    if (toConfirm.length) cols.push(["⏳ A confirmar (pendente)",toConfirm,"#94a3b8","transparent"]);
    cols.forEach(([lbl,list,clr,bg])=>{
      html+=`<div><div class="agenda-lbl" style="color:${clr}">${lbl}</div>`;
      if (!list.length) { html+=`<div style="color:var(--mu);font-size:13px">Nenhuma hoje</div>`; }
      list.forEach(({res:r,label})=>{
        // Pendente: o quarto está livre, então o toque abre a própria reserva para confirmar.
        const act = r.status==="pending" ? `openEditModal('${esc(r.id)}')` : `handleRoomClick('${esc(r.roomId)}')`;
        html+=`<div class="agenda-row" style="background:${bg};border:1px solid ${clr}44" onclick="${act}">
          <span class="agenda-room" style="color:${clr}">${esc(label)}</span>
          <div>
            <div style="color:var(--tx);font-size:13px;font-weight:600">${esc(guestDisplay(r).text)}</div>
            <div style="color:var(--dm);font-size:12px">${r.adults} adulto(s)${r.children>0?` + ${r.children} criança(s)`:""}</div>
          </div>
        </div>`;
      });
      html+=`</div>`;
    });
    html+=`</div></div>`;
  }
  return html;
}
