// Parte do frontend da PMS (PMS-017). Carregado em ordem por index.html;
// todos os arquivos compartilham o escopo global, como o antigo script único.
// ─── RESERVAS VIEW ────────────────────────────────────────────────────────────
function renderReservas() {
  const t = todayStr();

  let list = reservations.filter(r=>{
    if (filterTab==="upcoming")  return r.checkIn>=t   && r.status!=="cancelled";
    if (filterTab==="active")    return r.checkIn<=t   && r.checkOut>t && r.status!=="cancelled";
    if (filterTab==="past")      return r.checkOut<t   && r.status!=="cancelled";
    if (filterTab==="checkins")  return r.checkIn===t  && r.status!=="cancelled";
    if (filterTab==="checkouts") return r.checkOut===t && r.status!=="cancelled";
    return true;
  })
  .filter(r=>!searchQ || r.guestName.toLowerCase().includes(searchQ.toLowerCase()) || r.roomId.includes(searchQ))
  .filter(r=>{
    if (dateFrom && r.checkIn < dateFrom) return false;
    if (dateTo   && r.checkIn > dateTo)   return false;
    return true;
  })
  .sort((a,b)=>a.checkIn.localeCompare(b.checkIn));

  // Deduplica Casa Fechada PRIMEIRO → 1 linha CF (antes de checar suíte)
  list = groupCasaFechada(list);
  // Agrupa suíte 11+12 em uma linha só (apenas reservas não-CF)
  list = groupSuiteReservations(list);

  // Mesma regra do Mapa: uma por estadia (CF e 11+12 contam uma vez); pendente não conta.
  const todayCheckins  = oneStayPerGroup(reservations.filter(r=>occupies(r)&&r.checkIn===t)).length;
  const todayCheckouts = oneStayPerGroup(reservations.filter(r=>occupies(r)&&r.checkOut===t)).length;

  let html=`
  <div class="filter-bar">
    <input id="search-inp" placeholder="🔍 Buscar hóspede ou quarto..." value="${esc(searchQ)}"
      oninput="searchQ=this.value;render()">
    <div style="display:flex;gap:6px;flex-wrap:wrap">`;

  [
    ["upcoming","Futuras"],
    ["active","Ativas"],
    ["checkins",  `✈ Check-ins${todayCheckins   ? ` <span style="background:#3b82f633;color:#3b82f6;border-radius:99px;padding:1px 6px;font-size:9px">${todayCheckins}</span>`   :""}`],
    ["checkouts", `🧹 Check-outs${todayCheckouts ? ` <span style="background:#f59e0b33;color:#f59e0b;border-radius:99px;padding:1px 6px;font-size:9px">${todayCheckouts}</span>` :""}`],
    ["past","Passadas"],
    ["all","Todas"],
  ].forEach(([v,l])=>{
    html+=`<button class="tab-btn${filterTab===v?" active":""}" onclick="filterTab='${v}';render()">${l}</button>`;
  });

  html+=`</div>
    <div style="display:flex;gap:8px;margin-left:auto">
      <button class="btn btn-green dup-new" onclick="openNewModal()">+ Nova Reserva</button>
      <button class="btn" style="background:#1e3a5f;border-color:#3b82f6;color:#3b82f6" onclick="openCasaTodaModal()">🏡 Casa Toda</button>
    </div>
  </div>

  <div class="date-filter">
    <label>De</label>
    <input type="date" value="${esc(dateFrom)}" onchange="dateFrom=this.value;render()">
    <label>Até</label>
    <input type="date" value="${esc(dateTo)}"   onchange="dateTo=this.value;render()">
    ${dateFrom||dateTo?`<button class="clear-btn" onclick="dateFrom='';dateTo='';render()">✕ Limpar datas</button>`:""}
    <div style="margin-left:auto;display:flex;align-items:center;gap:8px">
      <span style="font-size:10px;color:var(--mu)">Agrupar por mês</span>
      <div onclick="groupByDate=!groupByDate;render()" style="width:36px;height:20px;border-radius:10px;cursor:pointer;position:relative;
        background:${groupByDate?"#166534":"var(--bg3)"};border:1px solid ${groupByDate?"#166534":"var(--bd)"};transition:background .2s">
        <div style="position:absolute;top:2px;width:14px;height:14px;border-radius:50%;background:#fff;
          transition:left .2s;left:${groupByDate?"18px":"2px"}"></div>
      </div>
    </div>
  </div>

  ${filterTab==="checkins"  ? `<div style="background:#0f1e2b;border:1px solid #3b82f644;border-radius:10px;padding:12px 16px;margin-bottom:16px;font-size:12px;color:#3b82f6">
    ✈ Check-ins de hoje — ${new Date().toLocaleDateString("pt-BR",{weekday:"long",day:"numeric",month:"long"})}
    ${todayCheckins===0?"· <b>Nenhum check-in hoje</b>":""}</div>` : ""}
  ${filterTab==="checkouts" ? `<div style="background:#2b1e0a;border:1px solid #f59e0b44;border-radius:10px;padding:12px 16px;margin-bottom:16px;font-size:12px;color:#f59e0b">
    🧹 Check-outs de hoje — ${new Date().toLocaleDateString("pt-BR",{weekday:"long",day:"numeric",month:"long"})}
    ${todayCheckouts===0?"· <b>Nenhum check-out hoje</b>":""}</div>` : ""}
  `;

  if (!list.length) {
    html+=`<div style="text-align:center;color:var(--bd);padding:48px;font-size:15px">Nenhuma reserva encontrada</div>`;
    return html;
  }

  if (groupByDate) {
    const groups = {};
    list.forEach(r=>{
      const key = r.checkIn.slice(0,7);
      if (!groups[key]) groups[key]=[];
      groups[key].push(r);
    });
    Object.entries(groups).sort(([a],[b])=>a.localeCompare(b)).forEach(([key,rows])=>{
      const label = new Date(key+"-01T12:00:00").toLocaleDateString("pt-BR",{month:"long",year:"numeric"});
      html+=`<div class="date-group-header">
        <div class="date-group-badge">${label.charAt(0).toUpperCase()+label.slice(1)} · ${rows.length} reserva${rows.length!==1?"s":""}</div>
        <div class="date-group-line"></div>
      </div>`;
      rows.forEach(r=>{ html+=resRow(r); });
    });
  } else {
    list.forEach(r=>{ html+=resRow(r); });
  }
  return html;
}

function isSuiteRes(r) {
  if (r.roomId!=="11" && r.roomId!=="12") return false;
  // 0) coluna de grupo (PMS-006)
  if (String(r.groupId || "").startsWith("suite:")) return true;
  // 1) marcado explicitamente nas notas
  if (r.notes && (r.notes.includes("[Suíte grupo:") || r.notes.includes("Suíte 11+12"))) return true;
  return false;
}

// Deduplica reservas de Casa Fechada — mostra 1 linha com "CF"
function groupCasaFechada(list) {
  const seen = new Set();
  return list.reduce((acc, r) => {
    if (isCasaFechadaRes(r)) {
      // Pela coluna de grupo (PMS-006); sem ela, por hóspede+datas (reservas antigas)
      const key = r.groupId ? `cf-g-${r.groupId}` : `cf-${r.guestName}-${r.checkIn}-${r.checkOut}`;
      if (seen.has(key)) return acc;
      seen.add(key);
      acc.push({ ...r, roomId: "CF", _isCFRow: true });
    } else {
      acc.push(r);
    }
    return acc;
  }, []);
}

// Retorna chave de agrupamento para um quarto 11 ou 12
function suiteKey(r) {
  // prioridade: ID de grupo explícito nas notas
  const m = (r.notes||"").match(/\[Suíte grupo:([^\]]+)\]/);
  if (m) return "grp-" + m[1];
  // fallback: mesmo hóspede + mesmas datas (cobre importações iCal)
  return `pair-${r.guestName}-${r.checkIn}-${r.checkOut}`;
}

// Agrupa reservas de suíte para exibir como uma linha só
function groupSuiteReservations(list) {
  const grouped = [];
  const seen = new Set();

  list.forEach(r=>{
    if (r.roomId!=="11" && r.roomId!=="12") {
      grouped.push(r); return;
    }
    // Se é Casa Fechada, não agrupa como suíte — já será deduplicado abaixo
    if (isCasaFechadaRes(r)) {
      grouped.push(r); return;
    }
    // Quarto 11 ou 12 — verifica se existe par no mesmo período
    const hasPair = list.some(o =>
      o.id !== r.id &&
      ((r.roomId==="11" && o.roomId==="12") || (r.roomId==="12" && o.roomId==="11")) &&
      o.checkIn === r.checkIn && o.checkOut === r.checkOut &&
      o.status === r.status
    );

    if (hasPair) {
      // Agrupa como suíte — mostra apenas uma linha
      const key = suiteKey(r) || `pair-${r.guestName}-${r.checkIn}-${r.checkOut}`;
      if (seen.has(key)) return;
      seen.add(key);
      grouped.push({ ...r, roomId:"11+12", _isSuiteRow:true });
    } else {
      // Quarto 11 ou 12 reservado individualmente — mostra normal
      grouped.push(r);
    }
  });
  return grouped;
}

function resRow(r) {
  const isCasaToda = r._isCFRow || (r.notes && r.notes.includes("[Casa toda:"));
  const isSuite  = !isCasaToda && (r._isSuiteRow || isSuiteRes(r));
  const roomLabel= isCasaToda ? "CF" : isSuite ? "11+12" : r.roomId;
  const room     = isCasaToda ? {type:"Casa Fechada — pousada toda"}
                 : isSuite    ? {type:"Suíte (Triplo ×2, Ventilador)"}
                 : ROOMS.find(rm=>rm.id===r.roomId);
  const n        = nights(r.checkIn, r.checkOut);
  const srcClr   = SRC_COLOR[r.source]||"var(--mu)";
  const cancelled= r.status==="cancelled";
  return `<div class="res-row" style="opacity:${cancelled?.45:1}" onclick="openEditModal('${r.id}')">
    <div class="res-id" style="${isCasaToda?"border:1px solid #3b82f655;color:#3b82f6;font-size:13px;background:#0f1e2b":isSuite?"border:1px solid #f59e0b55;color:#f59e0b;font-size:13px":""}">${roomLabel}</div>
    <div style="flex:1;min-width:0">
      <div style="font-weight:700;font-size:14px;display:flex;align-items:center;gap:7px">
        ${esc(r.guestName)}
        ${isCasaToda?`<span class="pill" style="background:#3b82f622;color:#3b82f6">🏡 CF</span>`:""}
        ${isSuite?`<span class="pill" style="background:#f59e0b22;color:#f59e0b">🔗 suíte</span>`:""}
      </div>
      <div style="font-size:11px;color:var(--mu);margin-top:3px">
        ${room?.type||""} · ${fmtRange(r.checkIn, r.checkOut)}
        · <b style="color:var(--dm)">${n} noite${n!==1?"s":""}</b>
        ${r.phone?` · ${esc(r.phone)}`:""}    
      </div>
    </div>
    <div style="display:flex;gap:7px;align-items:center;flex-shrink:0">
      <span class="pill" style="background:${srcClr}28;color:${srcClr}">${r.source}</span>
      ${cancelled?`<span class="pill" style="background:#ef444428;color:#ef4444">cancelado</span>`:""}
      <span style="color:var(--bd);font-size:20px">›</span>
    </div>
  </div>`;
}
