// Parte do frontend da PMS (PMS-017). Carregado em ordem por index.html;
// todos os arquivos compartilham o escopo global, como o antigo script único.
// ─── PRÉ-RESERVAS VIEW ────────────────────────────────────────────────────────
const PRE_STATUS = {
  aguardando: { label:"Aguardando",  color:"#f59e0b", bg:"#2b1e0a" },
  confirmado: { label:"Confirmado",  color:"#22c55e", bg:"#0f2b1a" },
  recusado:   { label:"Recusado",    color:"#ef4444", bg:"#2b0f0f" },
};

function renderPreReservas() {
  const today = todayStr();
  const active   = prereservations.filter(p => p.status !== "recusado" && (!p.check_out || p.check_out >= today));
  const past     = prereservations.filter(p => p.status === "recusado"  || (p.check_out && p.check_out < today));

  let html = `
  <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:20px;flex-wrap:wrap;gap:10px">
    <div style="font-size:13px;color:var(--mu)">
      Anote hóspedes interessados em datas específicas antes de confirmar a reserva.
    </div>
    <button class="btn btn-green" onclick="openPreReservaModal(null)">+ Nova Pré-reserva</button>
  </div>`;

  if (!prereservations.length) {
    html += `<div style="text-align:center;color:var(--mu);padding:48px 0;font-size:14px">
      Nenhuma pré-reserva cadastrada. Use para anotar leads e hóspedes interessados.
    </div>`;
    return html;
  }

  const renderGroup = (list, title, color) => {
    if (!list.length) return "";
    let s = `<div style="font-size:13px;color:${color};font-weight:700;margin:20px 0 10px">${title}</div>`;
    list.forEach(p => {
      const st = PRE_STATUS[p.status] || PRE_STATUS.aguardando;
      const room = ROOMS.find(r => r.id === p.room_id);
      const n = p.check_in && p.check_out ? Math.max(0,Math.round((new Date(p.check_out)-new Date(p.check_in))/86400000)) : 0;
      // Checa conflito com reservas confirmadas
      const hasConflict = p.check_in && p.check_out && p.status !== "recusado" &&
        reservations.some(r =>
          r.roomId === p.room_id && occupies(r) &&
          r.checkIn < p.check_out && r.checkOut > p.check_in
        );
      s += `<div style="background:var(--bg2);border:1.5px solid ${hasConflict?"#ef444466":st.color+"33"};
        border-radius:12px;padding:14px 16px;margin-bottom:8px;cursor:pointer;
        display:flex;align-items:flex-start;gap:14px"
        onclick="openPreReservaModal('${esc(p.id)}')">
        <div style="width:46px;height:46px;border-radius:10px;background:${st.bg};
          border:1px solid ${st.color}44;display:flex;align-items:center;justify-content:center;
          font-size:16px;font-weight:800;color:${st.color};flex-shrink:0">
          ${esc(p.room_id||"?")}
        </div>
        <div style="flex:1;min-width:0">
          <div style="font-weight:700;font-size:14px;display:flex;align-items:center;gap:8px">
            ${esc(p.guest_name||"Sem nome")}
            ${hasConflict ? `<span class="pill" style="background:#ef444422;color:#ef4444">⚠️ conflito</span>` : ""}
          </div>
          <div style="font-size:11px;color:var(--mu);margin-top:3px">
            ${room ? room.type+" · " : ""}
            ${p.check_in ? fmtDate(p.check_in)+" → "+fmtDate(p.check_out) : "Datas não definidas"}
            ${n > 0 ? ` · <b style="color:var(--dm)">${n} noite${n!==1?"s":""}</b>` : ""}
            ${p.phone ? ` · 📞 ${esc(p.phone)}` : ""}
          </div>
          ${p.notes ? `<div style="font-size:11px;color:var(--dm);margin-top:5px;padding:6px 10px;
            background:var(--bg0);border-radius:6px;white-space:pre-wrap">${esc(p.notes)}</div>` : ""}
        </div>
        <div style="flex-shrink:0;text-align:right">
          <span class="pill" style="background:${st.bg};color:${st.color}">${st.label}</span>
        </div>
      </div>`;
    });
    return s;
  };

  html += renderGroup(active, "Ativas ou aguardando", "#f59e0b");
  html += renderGroup(past,   "Passadas ou recusadas", "var(--mu)");
  return html;
}

function openPreReservaModal(id) {
  const p = id ? (prereservations.find(x => x.id === id) || {}) : {};
  const isEdit = !!id;
  const today  = todayStr();

  const roomOpts = [
    `<option value="">— Qualquer quarto —</option>`,
    `<option value="CF" ${p.room_id==="CF"?"selected":""}>🏡 CF — Casa Fechada (pousada toda)</option>`,
    `<option value="11+12" ${p.room_id==="11+12"?"selected":""}>🔗 11+12 — Suíte combinada</option>`,
    `<option disabled>──────────────</option>`,
    ...ROOMS.map(r => `<option value="${r.id}" ${p.room_id===r.id?"selected":""}>${r.id} – ${r.type}</option>`)
  ].join("");

  const statusOpts = Object.entries(PRE_STATUS).map(([k,v]) =>
    `<option value="${k}" ${(p.status||"aguardando")===k?"selected":""}>${v.label}</option>`
  ).join("");

  document.getElementById("modal-title").innerHTML =
    `${isEdit?"📝 Editar":"📝 Nova"} Pré-reserva <button onclick="closeModal()">×</button>`;
  document.getElementById("modal-body").innerHTML = `
    <div style="display:flex;flex-direction:column;gap:10px;margin-bottom:20px">
      <div class="row2">
        <div class="field"><label>Quarto de Interesse</label>
          <select id="pr-room">${roomOpts}</select></div>
        <div class="field"><label>Status</label>
          <select id="pr-status">${statusOpts}</select></div>
      </div>
      <div class="field"><label>Nome do Hóspede</label>
        <input id="pr-name" value="${esc(p.guest_name||"")}" placeholder="Nome ou apelido" autofocus></div>
      <div class="field"><label>Telefone / WhatsApp</label>
        <input id="pr-phone" value="${esc(p.phone||"")}" placeholder="(44) 99999-9999"></div>
      <div class="row2">
        <div class="field"><label>Check-in pretendido</label>
          <input type="date" id="pr-checkin" value="${esc(p.check_in||"")}"></div>
        <div class="field"><label>Check-out pretendido</label>
          <input type="date" id="pr-checkout" value="${esc(p.check_out||"")}"></div>
      </div>
      <div class="field"><label>Notas / Observações</label>
        <textarea id="pr-notes" style="height:90px">${esc(p.notes||"")}</textarea></div>
    </div>
    <div style="display:flex;gap:10px;justify-content:flex-end">
      ${isEdit?`<button class="btn btn-red" onclick="deletePreReserva('${esc(p.id)}')">Excluir</button>`:""}
      <button class="btn btn-green" onclick="savePreReserva(${isEdit?`'${esc(p.id)}'`:"null"})">
        ${isEdit?"Salvar Alterações":"Criar Pré-reserva"}
      </button>
    </div>`;
  document.getElementById("modal").style.display = "flex";
}

async function savePreReserva(id) {
  const get = i => document.getElementById(i)?.value || "";
  const body = {
    roomId:    get("pr-room"),
    guestName: get("pr-name").trim(),
    phone:     get("pr-phone").trim(),
    checkIn:   get("pr-checkin")  || null,
    checkOut:  get("pr-checkout") || null,
    notes:     get("pr-notes").trim(),
    status:    get("pr-status"),
  };
  if (!body.guestName) { alert("Informe ao menos o nome do hóspede."); return; }
  const ok = id ? await apiWrite("PUT",  "/prereservations/"+id, body, "salvar a pré-reserva")
               : await apiWrite("POST", "/prereservations", body, "salvar a pré-reserva");
  if (!ok) return;
  closeModal();
  await loadAll();
}

async function deletePreReserva(id) {
  if (!confirm("Excluir esta pré-reserva?")) return;
  if (!(await apiWrite("DELETE", "/prereservations/"+id, null, "excluir a pré-reserva"))) return;
  closeModal();
  await loadAll();
}
