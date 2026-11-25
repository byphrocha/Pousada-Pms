// Parte do frontend da PMS (PMS-017). Carregado em ordem por index.html;
// todos os arquivos compartilham o escopo global, como o antigo script único.
// ─── Modals ───────────────────────────────────────────────────────────────────
function handleRoomClick(roomId) {
  const st = getRoomStatus(roomId);
  if (st==="cleaning") { openCleaningModal(roomId); return; }
  if (st==="checkin")  { openCheckinModal(roomId);  return; }
  const res = getRoomRes(roomId);
  if (res) openEditModal(res.id);
  else     openNewModal(roomId);
}

function openCheckinModal(roomId) {
  const room = ROOMS.find(r=>r.id===roomId);
  const res  = getRoomRes(roomId);
  document.getElementById("modal-title").innerHTML =
    `🔓 Quarto ${roomId} — Check-in <button onclick="closeModal()">×</button>`;
  document.getElementById("modal-body").innerHTML = `
    <div style="text-align:center;padding:16px 0">
      <div style="font-size:48px;margin-bottom:16px">🔓</div>
      <div style="font-size:18px;font-weight:700;margin-bottom:6px">${esc(res?.guestName||"Hóspede")}</div>
      <div style="font-size:13px;color:var(--mu);margin-bottom:28px">
        Check-in previsto hoje · ${room?.type||""}
      </div>
      <button class="btn btn-blue" style="width:100%;font-size:15px;padding:14px"
        onclick="markCheckedInFromModal('${roomId}')">
        ✓ Confirmar Check-in — Hóspede chegou
      </button>
      <div style="margin-top:10px">
        <button class="btn" style="width:100%;font-size:13px" onclick="closeModal();${res?`openEditModal('${res.id}')`:""}"
        >✏ Ver / Editar Reserva</button>
      </div>
    </div>`;
  document.getElementById("modal").style.display="flex";
}

function markCheckedInFromModal(roomId) {
  closeModal();
  return markCheckedIn(roomId);
}

function openCleaningModal(roomId) {
  const room = ROOMS.find(r=>r.id===roomId);
  document.getElementById("modal-title").innerHTML =
    `🧹 Quarto ${roomId} — Limpeza <button onclick="closeModal()">×</button>`;
  document.getElementById("modal-body").innerHTML = `
    <div style="text-align:center;padding:16px 0">
      <div style="font-size:48px;margin-bottom:16px">🧹</div>
      <div style="font-size:15px;color:var(--tx);margin-bottom:8px;font-weight:700">
        Quarto ${roomId} — ${room?.type}
      </div>
      <div style="font-size:13px;color:var(--mu);margin-bottom:28px">
        Check-out realizado hoje. Quarto aguardando limpeza.
      </div>
      <button class="btn btn-purple" style="width:100%;font-size:15px;padding:14px"
        onclick="markCleanFromModal('${roomId}')">
        ✓ Confirmar Limpeza — Liberar Quarto
      </button>
    </div>`;
  document.getElementById("modal").style.display="flex";
}

function markCleanFromModal(roomId) {
  closeModal();
  return markClean(roomId);
}

function openNewModal(roomId) {
  document.getElementById("modal-title").innerHTML =
    `Nova Reserva <button onclick="closeModal()">×</button>`;
  document.getElementById("modal-body").innerHTML = reservationForm({
    roomId: roomId||ROOMS[0].id, guestName:"", checkIn:todayStr(), checkOut:"",
    source:"direto", adults:2, children:0, phone:"", notes:""
  }, false);
  document.getElementById("modal").style.display="flex";
}

function openEditModal(id) {
  const r = reservations.find(x=>x.id===id);
  if (!r) return;
  document.getElementById("modal-title").innerHTML =
    `Editar Reserva <button onclick="closeModal()">×</button>`;
  const withPayments = paymentsEnabled && authRole === "admin" && r.source === "direto";
  const withHistory = authRole === "admin";
  const grp = r.groupId ? groupLabelOf(r) : null;
  document.getElementById("modal-body").innerHTML =
    (grp ? `<div class="group-note">🔗 Esta reserva faz parte da ${esc(grp)}. Datas, nome, telefone, canal e status mudam em todos os quartos juntos.</div>` : "") +
    reservationForm(r, true) +
    (withPayments ? `<div id="pay-box" style="margin-top:18px;border-top:1px solid var(--bd);padding-top:14px;font-size:12px;color:var(--mu)">Carregando pagamentos…</div>` : "") +
    (withHistory ? `<div id="hist-box" style="margin-top:14px;font-size:12px;color:var(--mu)"></div>` : "");
  document.getElementById("modal").style.display="flex";
  if (withPayments) loadPaymentsBox(id);
  if (withHistory) loadHistoryBox(id);
}

// ─── Histórico da reserva (PMS-014) ───────────────────────────────────────────
const AUDIT_ACTIONS = {
  "reserva.criar": "criou a reserva", "reserva.grupo": "criou a reserva do grupo", "reserva.editar": "editou",
  "reserva.cancelar": "cancelou", "reserva.reativar": "reativou", "reserva.apagar": "apagou",
  "pagamento.registrar": "registrou pagamento", "pagamento.receber": "marcou como recebido",
  "pagamento.editar": "alterou pagamento", "pagamento.excluir": "excluiu pagamento",
};
const AUDIT_FIELDS = {
  room_id: "quarto", check_in: "entrada", check_out: "saída", status: "status", source: "canal",
  amount: "valor", payment: "forma", adults: "adultos", children: "crianças",
  kind: "tipo", method: "forma", due_date: "vencimento", paid_at: "pago em", produto: "produto", quartos: "quartos",
};
function auditValue(field, v) {
  if (v === null || v === undefined) return "—";
  if (["amount"].includes(field)) return fmtMoney(v);
  if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v)) return fmtDate(v);
  if (Array.isArray(v)) return v.join(", ");
  return String(v);
}
function describeAuditChanges(ch) {
  const parts = [];
  for (const [k, v] of Object.entries(ch || {})) {
    if (k === "privados") { parts.push(`alterou ${v.join(", ")}`); continue; }
    const label = AUDIT_FIELDS[k] || k;
    if (Array.isArray(v) && v.length === 2 && !["quartos"].includes(k)) parts.push(`${label}: ${auditValue(k, v[0])} → ${auditValue(k, v[1])}`);
    else parts.push(`${label}: ${auditValue(k, v)}`);
  }
  return parts.join(" · ");
}
async function loadHistoryBox(resId) {
  const d = await api("GET", `/reservations/${encodeURIComponent(resId)}/history`);
  const box = document.getElementById("hist-box");
  if (!box || !d || !d.enabled || !Array.isArray(d.items)) return;
  box.innerHTML = renderHistoryBox(d.items);
}
function renderHistoryBox(items) {
  if (!items.length) return `<div style="font-size:11px;color:var(--mu)">🕘 Sem alterações registradas.</div>`;
  return `<details><summary style="cursor:pointer;font-size:13px;font-weight:700">🕘 Histórico (${items.length})</summary>
    <div style="display:flex;flex-direction:column;gap:4px;margin-top:8px">
      ${items.map(it => {
        const when = new Date(it.at);
        const ts = isNaN(when) ? "" : when.toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
        return `<div style="font-size:11px;padding:5px 8px;background:var(--bg0);border-radius:6px">
          <b style="color:var(--tx)">${esc(ts)}</b> · ${esc(it.username || "?")} ${esc(AUDIT_ACTIONS[it.action] || it.action)}
          <div style="color:var(--mu)">${esc(describeAuditChanges(it.changes))}</div></div>`;
      }).join("")}
    </div></details>`;
}

// ─── Pagamentos da reserva (PMS-007) ──────────────────────────────────────────
const PAY_KINDS = { sinal: "Sinal", parcela: "Parcela", pagamento: "Pagamento", estorno: "Estorno (devolução)" };
const PAY_METHODS = { pix: "PIX", dinheiro: "Dinheiro", cartao: "Cartão", transferencia: "Transferência" };

async function loadPaymentsBox(resId) {
  const box = document.getElementById("pay-box");
  if (!box) return;
  const d = await api("GET", `/reservations/${encodeURIComponent(resId)}/payments`);
  const box2 = document.getElementById("pay-box");
  if (!box2) return;
  if (!d || d.error || d._networkError || !d.summary) {
    box2.innerHTML = `<div style="color:#fca5a5">⚠️ Não foi possível carregar os pagamentos: ${esc(apiErrorMessage(d) || "erro")}</div>`;
    return;
  }
  box2.innerHTML = renderPaymentsBox(d, resId);
}

// Receita antiga no caixa ligada a esta reserva (lançada antes dos pagamentos).
// Decisão de 23/11/2026: só avisar, sem converter. Evita contar o valor duas vezes.
function legacyIncomeWarning(li) {
  const box = (msg) => `<div style="font-size:11px;color:#f59e0b;background:#f59e0b14;border:1px solid #f59e0b55;border-radius:8px;padding:8px 10px;margin-bottom:10px;line-height:1.5">${msg}</div>`;
  if (li === null) return box("⚠️ Não foi possível conferir se há receita antiga desta reserva no Financeiro. Confira antes de registrar pagamento.");
  if (!li || !li.count) return "";
  return box(`⚠️ Já existe ${li.count === 1 ? "1 receita lançada" : li.count + " receitas lançadas"} no Financeiro para esta reserva (${fmtMoney(li.total)}), pelo sistema antigo. ` +
    `Não registre aqui o mesmo valor, senão ele conta duas vezes no caixa.`);
}

function renderPaymentsBox(d, resId) {
  const s = d.summary;
  const today = todayStr();
  const methodOpts = Object.entries(PAY_METHODS).map(([k, v]) => `<option value="${k}">${v}</option>`).join("");
  const rows = (d.payments || []).map(p => {
    const paid = !!p.paid_at;
    const late = !paid && p.due_date && p.due_date < today;
    const status = paid ? `✅ pago ${fmtDate(p.paid_at)} · ${PAY_METHODS[p.method] || p.method || ""}`
                        : `${late ? "🔴 vencida" : "🕒 vence"} ${fmtDate(p.due_date)}`;
    return `<div style="display:flex;align-items:center;gap:8px;padding:7px 9px;background:var(--bg0);border-radius:8px;flex-wrap:wrap">
      <div style="flex:1;min-width:140px"><b style="color:var(--tx)">${esc(PAY_KINDS[p.kind] || p.kind)}</b>
        <span style="color:${p.kind === "estorno" ? "#ef4444" : "var(--tx)"}"> ${fmtMoney(p.amount)}</span>
        <div style="font-size:10px;color:${late ? "#ef4444" : "var(--mu)"}">${esc(status)}${p.notes ? " · " + esc(p.notes) : ""}</div></div>
      ${paid ? "" : `<select id="pm-${esc(p.id)}" style="font-size:11px">${methodOpts}</select>
        <button class="btn btn-green" style="font-size:11px;padding:4px 8px" onclick="markPaymentPaid('${esc(p.id)}','${esc(resId)}')">Recebido hoje</button>`}
      <button class="btn" style="font-size:11px;padding:4px 8px" title="Excluir" onclick="deletePayment('${esc(p.id)}','${esc(resId)}')">🗑</button>
    </div>`;
  }).join("");
  const kpi = (label, val, color) => `<div style="flex:1;min-width:90px;background:var(--bg0);border-radius:8px;padding:8px;text-align:center">
    <div style="font-size:11px;color:var(--mu)">${label}</div>
    <div style="font-size:14px;font-weight:700;color:${color}">${fmtMoney(val)}</div></div>`;
  return `
    <div style="font-size:13px;color:var(--mu);font-weight:700;margin-bottom:8px">💳 Pagamentos${d.label && d.label !== "" ? " — " + esc(d.label) : ""}</div>
    <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px">
      ${kpi("Contratado", s.contracted, "var(--tx)")}
      ${kpi("Recebido", s.net, "#22c55e")}
      ${kpi("Saldo", s.balance, s.balance > 0 ? "#f59e0b" : "#3b82f6")}
    </div>
    ${legacyIncomeWarning(d.legacyIncome)}
    ${s.contracted === 0 ? `<div style="font-size:11px;color:#f59e0b;margin-bottom:8px">Informe o "Valor Total" da reserva acima e salve para ver o saldo.</div>` : ""}
    ${s.overdue.length ? `<div style="font-size:11px;color:#ef4444;margin-bottom:8px">🔴 ${s.overdue.length} parcela(s) vencida(s)</div>` : ""}
    ${s.unscheduled > 0 && (d.payments || []).length ? `<div style="font-size:11px;color:var(--mu);margin-bottom:8px">Sem parcela cadastrada: ${fmtMoney(s.unscheduled)}</div>` : ""}
    <div style="display:flex;flex-direction:column;gap:6px;margin-bottom:12px">${rows || `<div style="color:var(--mu)">Nenhum pagamento registrado.</div>`}</div>
    <div style="background:var(--bg0);border-radius:8px;padding:10px">
      <div class="row2">
        <div class="field"><label>Tipo</label><select id="pay-kind">${Object.entries(PAY_KINDS).map(([k, v]) => `<option value="${k}">${v}</option>`).join("")}</select></div>
        <div class="field"><label>Valor (R$)</label><input type="number" id="pay-amount" min="0" step="0.01" placeholder="0,00"></div>
      </div>
      <div class="row2">
        <div class="field"><label>Situação</label><select id="pay-status">
          <option value="pago">Já recebido</option><option value="vence">A receber (vencimento)</option></select></div>
        <div class="field"><label>Data (recebido em / vence em)</label><input type="date" id="pay-date" value="${today}"></div>
      </div>
      <div class="row2">
        <div class="field"><label>Forma</label><select id="pay-method">${methodOpts}</select></div>
        <div class="field"><label>Observação</label><input id="pay-notes" placeholder="Ex: 2ª parcela do contrato"></div>
      </div>
      <button class="btn btn-green" style="width:100%" onclick="addPayment('${esc(resId)}')">+ Registrar</button>
    </div>`;
}

async function refreshAfterPayment(resId) {
  await loadPaymentsBox(resId);
  if (currentView === "financeiro") await loadTransactions(finMonth);
}

async function addPayment(resId) {
  const get = i => document.getElementById(i)?.value || "";
  const scheduled = get("pay-status") === "vence";
  const body = {
    kind: get("pay-kind"), amount: parseFloat(get("pay-amount")), notes: get("pay-notes"),
    ...(scheduled ? { dueDate: get("pay-date") } : { paidAt: get("pay-date"), method: get("pay-method") }),
  };
  const r = await api("POST", `/reservations/${encodeURIComponent(resId)}/payments`, body);
  const err = apiErrorMessage(r);
  if (err) { alert(err); return; }
  await refreshAfterPayment(resId);
}

async function markPaymentPaid(payId, resId) {
  const method = document.getElementById("pm-" + payId)?.value || "pix";
  const r = await api("PUT", `/payments/${encodeURIComponent(payId)}`, { paidAt: todayStr(), method });
  const err = apiErrorMessage(r);
  if (err) { alert(err); return; }
  await refreshAfterPayment(resId);
}

async function deletePayment(payId, resId) {
  if (!confirm("Excluir este pagamento? Se ele já foi recebido, sai também do Financeiro.")) return;
  const r = await api("DELETE", `/payments/${encodeURIComponent(payId)}`);
  const err = apiErrorMessage(r);
  if (err) { alert(err); return; }
  await refreshAfterPayment(resId);
}

function closeModal() {
  document.getElementById("modal").style.display="none";
}

function reservationForm(r, isEdit) {
  const isCF = r.roomId==="CF";
  const roomOpts = [
    `<option value="CF" ${isCF?"selected":""}>🏡 Casa Fechada — pousada toda</option>`,
    `<option disabled>──────────────</option>`,
    ...SUITES.map(s=>`<option value="${s.id}" ${s.id===r.roomId?"selected":""}>${s.id} – ${s.label} (até ${s.cap} pessoas)</option>`),
    ...ROOMS.map(rm=>`<option value="${rm.id}" ${rm.id===r.roomId?"selected":""}>${rm.id} – ${rm.type}</option>`)
  ].join("");
  const n = r.checkIn&&r.checkOut ? nights(r.checkIn,r.checkOut) : 0;
  return `
  <div class="row2">
    <div class="field"><label>Quarto</label>
      <select id="f-roomId"><option value="">—</option>${roomOpts}</select></div>
    <div class="field"><label>Canal</label>
      <select id="f-source">
        <option value="direto"   ${r.source==="direto"  ?"selected":""}>Direto</option>
        <option value="booking"  ${r.source==="booking" ?"selected":""}>Booking.com</option>
        <option value="airbnb"   ${r.source==="airbnb"  ?"selected":""}>Airbnb</option>
      </select></div>
  </div>
  <div class="field"><label>Nome do Hóspede</label>
    <div style="position:relative">
      <input id="f-guestName" value="${esc(r.guestName||"")}" placeholder="Nome completo" autofocus
        autocomplete="off"
        oninput="showGuestSuggestions(this.value)"
        onblur="setTimeout(()=>hideGuestSuggestions(),200)">
      <div id="guest-suggestions" style="display:none;position:absolute;top:100%;left:0;right:0;
        background:var(--bg1);border:1px solid var(--bl);border-radius:0 0 10px 10px;z-index:999;
        max-height:180px;overflow-y:auto;box-shadow:0 8px 24px #0006"></div>
    </div></div>
  <div class="row2">
    <div class="field"><label>Check-in</label>
      <input type="date" id="f-checkIn"  value="${r.checkIn||""}"></div>
    <div class="field"><label>Check-out</label>
      <input type="date" id="f-checkOut" value="${r.checkOut||""}"></div>
  </div>
  <div class="row2">
    <div class="field"><label>Adultos</label>
      <input type="number" id="f-adults"   value="${esc(r.adults||2)}"   min="1" max="6"></div>
    <div class="field"><label>Crianças</label>
      <input type="number" id="f-children" value="${esc(r.children||0)}" min="0" max="4"></div>
  </div>
  <div class="row2">
    <div class="field"><label>Telefone / WhatsApp</label>
      <input id="f-phone" value="${esc(r.phone||"")}" placeholder="(44) 99999-9999"></div>
    <div class="field"><label>E-mail</label>
      <input id="f-email" value="${esc(r.email||"")}" placeholder="email@exemplo.com"></div>
  </div>
  ${authRole === "admin" ? `<div class="row2">
    <div class="field"><label>Valor Total (R$)</label>
      <input type="number" id="f-amount" value="${esc(r.amount||"")}" min="0" step="0.01" placeholder="0,00"></div>
    <div class="field"><label>Forma de Pagamento</label>
      <select id="f-payment">
        <option value="pix"         ${(r.payment||"pix")==="pix"        ?"selected":""}>PIX</option>
        <option value="dinheiro"    ${r.payment==="dinheiro"             ?"selected":""}>Dinheiro</option>
        <option value="cartao"      ${r.payment==="cartao"               ?"selected":""}>Cartão</option>
        <option value="transferencia" ${r.payment==="transferencia"      ?"selected":""}>Transferência</option>
      </select></div>
  </div>` : ""}
  <div class="field"><label>Observações</label>
    <textarea id="f-notes">${esc(r.notes||"")}</textarea></div>
  ${n>0?`<div style="font-size:12px;color:var(--dm);margin-bottom:16px">📅 ${fmtDate(r.checkIn)} → ${fmtDate(r.checkOut)} · <b style="color:var(--tx)">${n} noite${n!==1?"s":""}</b></div>`:""}
  <div style="display:flex;gap:10px;justify-content:flex-end">
    ${isEdit?`<button class="btn btn-red" onclick="cancelReservation('${r.id}')">Cancelar Reserva</button>`:""}
    <button class="btn btn-green" onclick="submitForm(${isEdit?`'${r.id}'`:"null"})">
      ${isEdit?"Salvar Alterações":"Criar Reserva"}
    </button>
  </div>`;
}

function openCasaTodaModal() {
  document.getElementById("modal-title").innerHTML =
    `🏡 Reservar Casa Toda <button onclick="closeModal()">×</button>`;
  const n = ROOMS.length;
  document.getElementById("modal-body").innerHTML = `
    <div style="background:#0f1e2b;border:1px solid #3b82f644;border-radius:10px;padding:12px 16px;margin-bottom:18px;font-size:12px;color:#3b82f6">
      Cria reservas simultâneas para todos os <b>${n} quartos</b> da pousada com os mesmos dados.
    </div>
    <div class="field"><label>Canal</label>
      <select id="ct-source">
        <option value="direto">Direto</option>
        <option value="booking">Booking.com</option>
        <option value="airbnb">Airbnb</option>
      </select></div>
    <div class="field"><label>Nome do Hóspede / Grupo</label>
      <input id="ct-guestName" placeholder="Ex: Família Silva" autofocus></div>
    <div class="row2">
      <div class="field"><label>Check-in</label>
        <input type="date" id="ct-checkIn" value="${todayStr()}"></div>
      <div class="field"><label>Check-out</label>
        <input type="date" id="ct-checkOut"></div>
    </div>
    <div class="row2">
      <div class="field"><label>Adultos (total)</label>
        <input type="number" id="ct-adults" value="18" min="1" max="40"></div>
      <div class="field"><label>Crianças (total)</label>
        <input type="number" id="ct-children" value="0" min="0" max="20"></div>
    </div>
    <div class="field"><label>Telefone / WhatsApp</label>
      <input id="ct-phone" placeholder="(44) 99999-9999"></div>
    <div class="field"><label>Observações</label>
      <textarea id="ct-notes">Casa toda reservada</textarea></div>
    <div style="display:flex;gap:10px;justify-content:flex-end;margin-top:4px">
      <button class="btn btn-green" onclick="submitCasaToda()">
        🏡 Reservar ${n} Quartos
      </button>
    </div>`;
  document.getElementById("modal").style.display="flex";
}

async function submitCasaToda() {
  const get = i => document.getElementById(i)?.value||"";
  const guestName = get("ct-guestName").trim();
  const checkIn   = get("ct-checkIn");
  const checkOut  = get("ct-checkOut");
  const source    = get("ct-source");
  const adults    = +get("ct-adults")||18;
  const children  = +get("ct-children")||0;
  const phone     = get("ct-phone");
  const notes     = get("ct-notes");

  if (!guestName || !checkIn || !checkOut || checkOut <= checkIn) {
    alert("Preencha nome, check-in e check-out corretamente."); return;
  }
  if (!confirmCapacity("CF", adults, children, null)) return;

  const allRooms = ROOMS.map(r => r.id);
  const clash = localConflict(allRooms, checkIn, checkOut, null);
  if (clash) {
    alert(`⚠️ Conflito de datas!\nQuarto ${clash.roomId} já tem reserva de ${fmtDate(clash.checkIn)} a ${fmtDate(clash.checkOut)}.\nA Casa Fechada não foi criada.`);
    return;
  }

  const groupId = genId();
  const suiteGroupId = genId();

  // Desabilita botão
  const btn = document.querySelector(".modal .btn-green");
  if (btn) { btn.disabled = true; btn.textContent = "⏳ Criando..."; }

  const result = await saveReservationGroup(ROOMS.map(room => ({
    id:        genId(),
    roomId:    room.id,
    guestName,
    checkIn, checkOut, source, phone,
    adults:   Math.round(adults / ROOMS.length),
    children: Math.round(children / ROOMS.length),
    notes:    notes + ` [Casa toda:${groupId}]`
      + (room.id==="11"||room.id==="12" ? ` [Suíte grupo:${suiteGroupId}]` : ""),
    status: "confirmed",
  })));

  await loadAll();
  if (!result.ok) {
    alert(result.error);
    if (btn) { btn.disabled = false; btn.textContent = `🏡 Reservar ${ROOMS.length} Quartos`; }
    return;
  }
  closeModal();
}

function openSuiteModal() {
  document.getElementById("modal-title").innerHTML =
    `🔗 Reservar Suíte 11+12 <button onclick="closeModal()">×</button>`;
  document.getElementById("modal-body").innerHTML = reservationForm({
    roomId:"11+12", guestName:"", checkIn:todayStr(), checkOut:"",
    source:"direto", adults:4, children:0, phone:"", notes:"Suíte combinada (quartos 11 e 12)"
  }, false);
  document.getElementById("modal").style.display="flex";
}

async function submitForm(id) {
  const get = i => document.getElementById(i)?.value||"";
  const form = {
    id:        id||genId(),
    roomId:    get("f-roomId"),
    guestName: get("f-guestName").trim(),
    checkIn:   get("f-checkIn"),
    checkOut:  get("f-checkOut"),
    source:    get("f-source"),
    adults:    +get("f-adults")||2,
    children:  +get("f-children")||0,
    phone:     get("f-phone"),
    notes:     get("f-notes"),
    amount:    parseFloat(get("f-amount"))||0,
    payment:   get("f-payment")||"pix",
    status:    "confirmed",
  };
  // Funcionário não vê nem envia valores (o servidor também ignora).
  if (authRole !== "admin") { delete form.amount; delete form.payment; }
  // Edição não mexe no status: antes o formulário mandava sempre "confirmed" e
  // salvar uma correção reativava reserva cancelada ou confirmava pendente.
  // Status muda só pelos botões próprios (ex.: "Cancelar Reserva").
  if (id && reservations.some(r => r.id === id)) delete form.status;
  if (!form.guestName||!form.checkIn||!form.checkOut||form.checkOut<=form.checkIn) {
    alert("Preencha nome, check-in e check-out corretamente."); return;
  }
  const isComposite = form.roomId === "CF" || form.roomId === "11+12";
  if (!confirmCapacity(form.roomId, form.adults, form.children, id ? reservations.find(x => x.id === id) : null)) return;
  if (id && isComposite) {
    alert("Para transformar esta reserva em Casa Fechada ou 11+12, cancele-a e crie uma nova.");
    return;
  }
  const targetRooms = form.roomId === "CF"    ? ROOMS.map(r => r.id)
                    : form.roomId === "11+12" ? ["11","12"]
                    : [form.roomId];

  // Aviso antecipado de conflito, agora também para CF e 11+12 (D4).
  // A garantia real é do servidor; isto só evita uma ida e volta.
  const conflict = localConflict(targetRooms, form.checkIn, form.checkOut, form.id);
  if (conflict) {
    alert(`⚠️ Conflito de datas!\nQuarto ${conflict.roomId} já tem reserva de ${fmtDate(conflict.checkIn)} a ${fmtDate(conflict.checkOut)} (${conflict.guestName}).`);
    return;
  }

  // Reserva de grupo (CF/11+12) trocada para outro quarto: a estadia inteira
  // muda (realocação). O servidor mantém a linha do contrato e libera as outras.
  const orig = id ? reservations.find(x => x.id === id) : null;
  if (orig && orig.groupId && form.roomId !== orig.roomId) {
    const label = String(orig.groupId).startsWith("cf:") ? "Casa Fechada" : "Suíte 11+12";
    if (!confirm(`Mover a estadia da ${label} inteira para o quarto ${form.roomId}?\nOs outros quartos desta reserva ficam livres.`)) return;
    const mv = await api("POST", `/reservations/${encodeURIComponent(id)}/move`, { roomId: form.roomId });
    if (!mv || mv.error || !mv.ok) { alert("Não mudou de quarto: " + (apiErrorMessage(mv) || "erro") + ". Nada foi alterado."); return; }
    id = mv.id; form.id = mv.id;
  }

  // Auto-save hóspede apenas para reservas diretas (não iCal)
  if (form.source === "direto") {
    await autoSaveGuest(form.guestName, get("f-phone"), get("f-email"));
  }

  // Grava a reserva ANTES de qualquer lançamento financeiro (F1/F4).
  let result, linkId = form.id;
  if (isComposite) {
    const tag = form.roomId === "CF" ? "Casa toda" : "Suíte grupo";
    const groupId = genId();
    result = await saveReservationGroup(targetRooms.map(rid => ({
      ...form,
      id:     genId(),
      roomId: rid,
      notes:  (form.notes||"") + ` [${tag}:${groupId}]`,
    })));
    // O lançamento aponta para a primeira linha criada do grupo (antes apontava
    // para um id que nunca existia).
    if (result.ok) linkId = result.created[0].id;
  } else {
    result = await saveReservation(form);
  }

  if (!result.ok) {
    await loadAll();
    alert(result.error);
    return;
  }

  // PMS-007 ativo: nada de receita automática. Valor contratado não é dinheiro
  // recebido (regra 6); abre a reserva para registrar sinal/parcelas.
  if (paymentsEnabled && form.source === "direto" && !id && authRole === "admin") {
    await loadAll();
    openEditModal(linkId);
    return;
  }
  // Modo antigo (antes da migration): lançamento automático como era.
  if (!paymentsEnabled && form.amount > 0 && form.source === "direto" && !id && authRole === "admin") {
    const tx = await api("POST", "/transactions", {
      id:          genId(),
      type:        "income",
      category:    "reserva_direta",
      description: `Reserva Qto ${form.roomId === "CF" ? "Casa Fechada" : form.roomId} — ${form.guestName}`,
      amount:      form.amount,
      date:        form.checkIn,
      month:       form.checkIn.slice(0,7),
      reservation_id: linkId,
    });
    const txErr = apiErrorMessage(tx);
    if (txErr) alert("Reserva salva, mas o lançamento financeiro falhou: " + txErr +
                     "\nRegistre o valor manualmente no Financeiro.");
    if (finMonth === form.checkIn.slice(0,7)) await loadTransactions(finMonth);
  }

  await loadAll();
  closeModal();
}
