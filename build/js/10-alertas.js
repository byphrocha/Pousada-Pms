// Parte do frontend da PMS (PMS-017). Carregado em ordem por index.html;
// todos os arquivos compartilham o escopo global, como o antigo script único.
// ─── ALERTAS VIEW ─────────────────────────────────────────────────────────────
// Overbooking que ainda dá para resolver: mesmo quarto, noites em comum, e a
// última noite em comum é hoje ou depois. Sobreposição que já terminou (ex.:
// duplicatas antigas de importação do histórico) não vira alerta — era isso que
// fazia a tela mostrar 85 "conflitos", todos de estadias passadas. Mesma janela
// da constraint do banco (reservations_no_overlap). [check_in, check_out).
function findOverbookings(list = reservations, today = todayStr()) {
  const active = list.filter(r => occupies(r) && r.checkOut > today);
  const out = [];
  for (let i = 0; i < active.length; i++)
    for (let j = i + 1; j < active.length; j++) {
      const a = active[i], b = active[j];
      if (a.roomId !== b.roomId) continue;
      // As duas saem depois de hoje, então as noites em comum incluem hoje ou depois.
      if (a.checkIn >= b.checkOut || b.checkIn >= a.checkOut) continue;
      out.push({ key: [a.id, b.id].sort().join("|"), a, b });
    }
  return out;
}

function renderAlertas() {
  const confirmed = reservations.filter(occupies);
  const conflicts = findOverbookings();

  // Também detecta pré-reservas que conflitam com reservas confirmadas
  const preConflicts = [];
  for (const pre of prereservations) {
    if (!pre.check_in || !pre.check_out) continue;
    if (pre.check_out <= todayStr()) continue; // pré-reserva que já passou não é alerta
    if (pre.status === "recusado") continue;
    const norm = { roomId: pre.room_id, checkIn: pre.check_in, checkOut: pre.check_out };
    const clash = confirmed.find(r =>
      r.roomId === norm.roomId &&
      r.checkIn < norm.checkOut &&
      r.checkOut > norm.checkIn
    );
    if (clash) preConflicts.push({ pre, clash });
  }

  const total = conflicts.length + preConflicts.length;

  let html = (authRole === "admin" ? backupCardHtml() + pushCardHtml() : "") + `<div style="margin-bottom:20px">`;

  if (total === 0) {
    html += `<div style="text-align:center;padding:60px 0">
      <div style="font-size:48px;margin-bottom:12px">✅</div>
      <div style="font-size:16px;font-weight:700;color:#22c55e">Nenhum conflito detectado</div>
      <div style="font-size:13px;color:var(--mu);margin-top:6px">
        Nenhuma reserva de hoje em diante está sobreposta no mesmo quarto.
      </div>
    </div>`;
  } else {
    html += `<div style="background:#2b0f0f;border:1px solid #ef444466;border-radius:12px;
      padding:14px 18px;margin-bottom:20px;display:flex;align-items:center;gap:12px">
      <span style="font-size:28px">⚠️</span>
      <div>
        <div style="font-weight:700;color:#ef4444;font-size:14px">${total} conflito${total!==1?"s":""} encontrado${total!==1?"s":""}</div>
        <div style="font-size:12px;color:var(--mu);margin-top:2px">Verifique e resolva antes de aceitar novas reservas</div>
      </div>
    </div>`;
  }

  // Conflitos entre reservas confirmadas
  if (conflicts.length > 0) {
    html += `<div style="font-size:13px;color:#ef4444;font-weight:700;margin-bottom:12px">
      Overbooking entre reservas confirmadas</div>`;

    conflicts.forEach(({ a, b }) => {
      const srcA = SRC_COLOR[a.source] || "var(--mu)";
      const srcB = SRC_COLOR[b.source] || "var(--mu)";
      const room = ROOMS.find(r => r.id === a.roomId);
      const overlapStart = a.checkIn > b.checkIn ? a.checkIn : b.checkIn;
      const overlapEnd   = a.checkOut < b.checkOut ? a.checkOut : b.checkOut;
      html += `<div style="background:var(--bg2);border:1.5px solid #ef444444;border-radius:12px;
        padding:16px 18px;margin-bottom:12px">
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:14px">
          <div style="background:#2b0f0f;border:1px solid #ef4444;border-radius:8px;
            padding:6px 12px;font-weight:800;font-size:16px;color:#ef4444">${esc(a.roomId)}</div>
          <div>
            <div style="font-weight:700;font-size:13px;color:#ef4444">Overbooking no Quarto ${esc(a.roomId)}</div>
            <div style="font-size:11px;color:var(--mu);margin-top:2px">${room?.type||""} · Sobreposição: ${fmtRange(overlapStart, overlapEnd)}</div>
          </div>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
          ${[a,b].map((r,i) => `
          <div style="background:var(--bg0);border-radius:8px;padding:10px 12px;
            border-left:3px solid ${i===0?srcA:srcB}">
            <div style="font-size:12px;color:${i===0?srcA:srcB};font-weight:700;margin-bottom:4px">${esc(r.source)}</div>
            <div style="font-weight:700;font-size:13px">${esc(r.guestName)}</div>
            <div style="font-size:11px;color:var(--mu);margin-top:3px">${fmtRange(r.checkIn, r.checkOut)}</div>
            ${r.phone ? `<div style="font-size:11px;color:var(--dm);margin-top:2px">📞 ${esc(r.phone)}</div>` : ""}
            <button onclick="openEditModal('${esc(r.id)}')"
              style="margin-top:8px;font-size:10px;padding:4px 10px;border-radius:6px;
              border:1px solid var(--bd);background:var(--bg2);color:var(--tx);cursor:pointer;font-family:inherit">
              Ver reserva →
            </button>
          </div>`).join("")}
        </div>
      </div>`;
    });
  }

  // Pré-reservas conflitando com confirmadas
  if (preConflicts.length > 0) {
    html += `<div style="font-size:13px;color:#f59e0b;font-weight:700;
      margin:20px 0 12px">Pré-reservas com conflito</div>`;
    preConflicts.forEach(({ pre, clash }) => {
      const srcClr = SRC_COLOR[clash.source] || "var(--mu)";
      html += `<div style="background:var(--bg2);border:1.5px solid #f59e0b44;border-radius:12px;
        padding:16px 18px;margin-bottom:12px">
        <div style="font-size:10px;color:#f59e0b;font-weight:700;margin-bottom:10px">
          ⚠️ Pré-reserva × confirmada, quarto ${esc(pre.room_id||"")}</div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
          <div style="background:var(--bg0);border-radius:8px;padding:10px 12px;border-left:3px solid #f59e0b">
            <div style="font-size:10px;color:#f59e0b;font-weight:700;margin-bottom:4px">Pré-reserva</div>
            <div style="font-weight:700;font-size:13px">${esc(pre.guest_name||"")}</div>
            <div style="font-size:11px;color:var(--mu);margin-top:3px">${fmtRange(pre.check_in, pre.check_out)}</div>
            ${pre.phone ? `<div style="font-size:11px;color:var(--dm);margin-top:2px">📞 ${esc(pre.phone)}</div>` : ""}
            <button onclick="openPreReservaModal('${esc(pre.id)}')"
              style="margin-top:8px;font-size:10px;padding:4px 10px;border-radius:6px;
              border:1px solid #f59e0b44;background:var(--bg2);color:#f59e0b;cursor:pointer;font-family:inherit">
              Editar →
            </button>
          </div>
          <div style="background:var(--bg0);border-radius:8px;padding:10px 12px;border-left:3px solid ${srcClr}">
            <div style="font-size:10px;color:${srcClr};font-weight:700;margin-bottom:4px">${esc(clash.source)}: confirmada</div>
            <div style="font-weight:700;font-size:13px">${esc(clash.guestName)}</div>
            <div style="font-size:11px;color:var(--mu);margin-top:3px">${fmtRange(clash.checkIn, clash.checkOut)}</div>
            <button onclick="openEditModal('${esc(clash.id)}')"
              style="margin-top:8px;font-size:10px;padding:4px 10px;border-radius:6px;
              border:1px solid var(--bd);background:var(--bg2);color:var(--tx);cursor:pointer;font-family:inherit">
              Ver reserva →
            </button>
          </div>
        </div>
      </div>`;
    });
  }

  html += `</div>
  <div style="font-size:11px;color:var(--mu);text-align:center;padding-top:8px">
    Atualizado em tempo real com as reservas do sistema. Sincronize o iCal para verificar cancelamentos.
  </div>`;
  return html;
}
