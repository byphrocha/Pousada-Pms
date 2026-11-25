// Parte do frontend da PMS (PMS-017). Carregado em ordem por index.html;
// todos os arquivos compartilham o escopo global, como o antigo script único.
// ─── SYNC VIEW ────────────────────────────────────────────────────────────────
// ─── HÓSPEDES VIEW ────────────────────────────────────────────────────────────
// Reservas ligadas a um hóspede: mesmo nome (sem diferença de maiúsculas/espaços)
// ou mesmo telefone com pelo menos 8 dígitos. Antes, telefone vazio casava com
// todas as reservas sem telefone (as importadas), e a contagem ia a centenas.
const onlyDigits = s => String(s || "").replace(/\D/g, "");
const normName   = s => String(s || "").trim().toLowerCase().replace(/\s+/g, " ");
function reservationsOfGuest(g) {
  const name  = normName(g.name);
  const phone = onlyDigits(g.phone);
  if (!name && phone.length < 8) return [];
  return reservations.filter(r =>
    (name && normName(r.guestName) === name) ||
    (phone.length >= 8 && onlyDigits(r.phone) === phone));
}
// Conta estadias, não linhas: Casa Fechada (9 linhas) e 11+12 (2 linhas) contam uma vez.
function guestStayCount(g) {
  const keys = new Set();
  for (const r of reservationsOfGuest(g)) {
    if (r.status === "cancelled") continue;
    const m = (r.notes || "").match(/\[(Casa toda|Suíte grupo):([^\]]+)\]/);
    keys.add(m ? m[1] + ":" + m[2] : r.id);
  }
  return keys.size;
}

function renderHospedes() {
  const q = guestSearch.toLowerCase();
  const list = q
    ? guests.filter(g =>
        (g.name||"").toLowerCase().includes(q) ||
        (g.phone||"").includes(q) ||
        (g.cpf||"").includes(q) ||
        (g.email||"").toLowerCase().includes(q)
      )
    : guests;

  let html = `
  <div style="display:flex;gap:12px;align-items:center;margin-bottom:20px;flex-wrap:wrap">
    <input id="guest-search-input" value="${esc(guestSearch)}"
      placeholder="🔍 Buscar por nome, telefone, CPF ou e-mail..."
      style="flex:1;min-width:200px;background:var(--bg1);border:1px solid var(--bd);border-radius:10px;
      padding:10px 14px;color:var(--tx);font-size:13px;outline:none"
      oninput="guestSearch=this.value;render()">
    <button class="btn btn-green" onclick="openGuestModal(null)">+ Novo Hóspede</button>
  </div>`;

  if (!list.length) {
    html += `<div style="text-align:center;color:var(--mu);padding:48px 0;font-size:14px">
      ${q ? `Nenhum hóspede encontrado para "${guestSearch}"` : "Nenhum hóspede cadastrado ainda."}
    </div>`;
    return html;
  }

  html += `<div style="display:flex;flex-direction:column;gap:8px">`;
  list.forEach(g => {
    const resCount = guestStayCount(g);
    html += `<div style="background:var(--bg1);border:1px solid var(--bd);border-radius:12px;
      padding:14px 16px;display:flex;align-items:center;gap:14px;cursor:pointer"
      onclick="openGuestModal('${g.id}')">
      <div style="width:40px;height:40px;border-radius:50%;background:var(--bg3);
        display:flex;align-items:center;justify-content:center;font-size:18px;flex-shrink:0">
        👤
      </div>
      <div style="flex:1;min-width:0">
        <div style="font-weight:700;font-size:14px">${esc(g.name)}</div>
        <div style="font-size:11px;color:var(--mu);margin-top:3px">
          ${g.phone ? "📞 "+esc(g.phone) : ""}
          ${g.email ? " · ✉ "+esc(g.email) : ""}
          ${g.cpf   ? " · 🪪 "+esc(g.cpf)  : ""}
        </div>
      </div>
      <div style="flex-shrink:0;text-align:right">
        <div style="font-size:12px;color:var(--dm);font-weight:600">${resCount} reserva${resCount!==1?"s":""}</div>
        ${g.address?`<div style="font-size:10px;color:var(--mu);margin-top:2px">📍 ${esc(g.address)}</div>`:""}
      </div>
      <span style="color:var(--bd);font-size:20px">›</span>
    </div>`;
  });
  html += `</div>`;
  return html;
}

function openGuestModal(guestId) {
  const g = guestId ? (guests.find(x => x.id === guestId) || {}) : {};
  const isEdit = !!guestId;
  // reservas vinculadas a esse hóspede
  const guestRes = isEdit ? reservationsOfGuest(g) : [];

  document.getElementById("modal-title").innerHTML =
    `${isEdit?"👤 Editar Hóspede":"👤 Novo Hóspede"} <button onclick="closeModal()">×</button>`;
  document.getElementById("modal-body").innerHTML = `
    <div style="display:flex;flex-direction:column;gap:10px;margin-bottom:20px">
      <div class="field"><label>Nome *</label>
        <input id="g-name" value="${esc(g.name||"")}" placeholder="Nome completo"></div>
      <div class="row2">
        <div class="field"><label>Telefone / WhatsApp</label>
          <input id="g-phone" value="${esc(g.phone||"")}" placeholder="(44) 99999-9999"></div>
        <div class="field"><label>E-mail</label>
          <input id="g-email" value="${esc(g.email||"")}" placeholder="email@exemplo.com"></div>
      </div>
      <div class="row2">
        <div class="field"><label>CPF / Documento</label>
          <input id="g-cpf" value="${esc(g.cpf||"")}" placeholder="000.000.000-00"
            ${String(g.cpf||"").includes("*") ? 'readonly title="CPF visível só para o administrador"' : ""}></div>
        <div class="field"><label>Endereço / Cidade</label>
          <input id="g-address" value="${esc(g.address||"")}" placeholder="Cidade, Estado"></div>
      </div>
      <div class="field"><label>Observações</label>
        <textarea id="g-notes">${esc(g.notes||"")}</textarea></div>
    </div>
    ${guestRes.length ? `
    <div style="margin-bottom:20px">
      <div style="font-size:13px;color:var(--mu);font-weight:700;margin-bottom:10px">
        Histórico (${guestRes.length} reserva${guestRes.length!==1?"s":""})
      </div>
      ${guestRes.slice(0,5).map(r=>`
        <div style="background:var(--bg0);border-radius:8px;padding:8px 12px;margin-bottom:6px;
          font-size:12px;display:flex;justify-content:space-between;align-items:center">
          <span>Qto ${esc(r.roomId)} · ${fmtDate(r.checkIn)} → ${fmtDate(r.checkOut)}</span>
          <span style="color:var(--mu)">${esc(r.source)}</span>
        </div>`).join("")}
    </div>` : ""}
    <div style="display:flex;gap:10px;justify-content:flex-end">
      ${isEdit?`<button class="btn btn-red" onclick="deleteGuest('${g.id}')">Excluir</button>`:""}
      <button class="btn btn-green" onclick="saveGuest(${isEdit?`'${g.id}'`:"null"})">
        ${isEdit?"Salvar Alterações":"Cadastrar Hóspede"}
      </button>
    </div>`;
  document.getElementById("modal").style.display = "flex";
}

async function saveGuest(id) {
  const g = {
    id:      id || Math.random().toString(36).slice(2,10),
    name:    document.getElementById("g-name")?.value.trim(),
    phone:   document.getElementById("g-phone")?.value.trim(),
    email:   document.getElementById("g-email")?.value.trim(),
    cpf:     document.getElementById("g-cpf")?.value.trim(),
    address: document.getElementById("g-address")?.value.trim(),
    notes:   document.getElementById("g-notes")?.value.trim(),
  };
  if (!g.name) { alert("Nome é obrigatório"); return; }
  if (!(await apiWrite("POST", "/guests", g, "salvar o hóspede"))) return;
  closeModal();
  await loadAll();
}

async function deleteGuest(id) {
  if (!confirm("Excluir este hóspede? As reservas não serão afetadas.")) return;
  if (!(await apiWrite("DELETE", "/guests/"+id, null, "excluir o hóspede"))) return;
  closeModal();
  await loadAll();
}
