// Parte do frontend da PMS (PMS-017). Carregado em ordem por index.html;
// todos os arquivos compartilham o escopo global, como o antigo script único.
// ─── FINANCEIRO VIEW ──────────────────────────────────────────────────────────
const FIN_CATEGORIES = {
  // Entradas
  reserva_direta: { label:"Reserva Direta",   icon:"🏡", type:"income"  },
  airbnb:         { label:"Airbnb (mensal)",   icon:"🔴", type:"income"  },
  booking:        { label:"Booking (mensal)",  icon:"🔵", type:"income"  },
  outro_ingresso: { label:"Outra Receita",     icon:"💵", type:"income"  },
  // Saídas
  conta_fixa:     { label:"Conta Fixa",        icon:"💡", type:"expense" },
  manutencao:     { label:"Manutenção",        icon:"🔧", type:"expense" },
  compras:        { label:"Compras",           icon:"🛒", type:"expense" },
  funcionario:    { label:"Funcionários",      icon:"👷", type:"expense" },
  outro_gasto:    { label:"Outra Despesa",     icon:"📦", type:"expense" },
  estorno_reserva:{ label:"Estorno de Reserva", icon:"↩️", type:"expense", auto:true },
};

function fmtMoney(v) {
  return "R$ " + Number(v||0).toLocaleString("pt-BR",{minimumFractionDigits:2,maximumFractionDigits:2});
}
function fmtMonthLabel(m) {
  const [y,mo] = m.split("-");
  const months = ["Jan","Fev","Mar","Abr","Mai","Jun","Jul","Ago","Set","Out","Nov","Dez"];
  return months[+mo-1]+" "+y;
}

async function loadTransactions(month) {
  if (authRole !== "admin") return;
  const data = await api("GET", "/transactions?month="+month);
  if (Array.isArray(data)) transactions = data;
  else loadError = "Não foi possível carregar o financeiro deste mês.";
  if (paymentsEnabled) {
    const rec = await api("GET", "/payments/receivable");
    if (Array.isArray(rec)) receivables = rec;
  }
  render();
}

function renderFinanceiro() {
  const income   = transactions.filter(t=>t.type==="income");
  const expense  = transactions.filter(t=>t.type==="expense");
  const totIn    = income.reduce((s,t)=>s+Number(t.amount),0);
  const totOut   = expense.reduce((s,t)=>s+Number(t.amount),0);
  const balance  = totIn - totOut;

  // Month navigator
  const [y,m]    = finMonth.split("-").map(Number);
  const prevMonth = new Date(y,m-2,1).toISOString().slice(0,7);
  const nextMonth = new Date(y,m,1).toISOString().slice(0,7);
  const isCurrentMonth = finMonth === new Date().toISOString().slice(0,7);

  let html = `
  <!-- Navegação de mês -->
  <div style="display:flex;align-items:center;gap:12px;margin-bottom:20px;flex-wrap:wrap">
    <button class="btn" style="padding:8px 14px" onclick="changeFinMonth('${prevMonth}')">‹</button>
    <div style="font-size:17px;font-weight:700;flex:1;text-align:center">${fmtMonthLabel(finMonth)}</div>
    <button class="btn" style="padding:8px 14px" ${isCurrentMonth?"disabled":""} onclick="changeFinMonth('${nextMonth}')">›</button>
    <button class="btn btn-green" onclick="openTransactionModal(null)">+ Lançamento</button>
  </div>

  <!-- KPIs -->
  <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-bottom:24px">
    <div style="background:var(--bg1);border:1px solid #22c55e44;border-radius:12px;padding:16px;text-align:center">
      <div style="font-size:13px;color:#22c55e;font-weight:700;margin-bottom:6px">Receitas</div>
      <div class="fin-kpi" style="font-weight:700;color:#22c55e;font-family:'Fraunces',serif">${fmtMoney(totIn)}</div>
    </div>
    <div style="background:var(--bg1);border:1px solid #ef444444;border-radius:12px;padding:16px;text-align:center">
      <div style="font-size:13px;color:#ef4444;font-weight:700;margin-bottom:6px">Despesas</div>
      <div class="fin-kpi" style="font-weight:700;color:#ef4444;font-family:'Fraunces',serif">${fmtMoney(totOut)}</div>
    </div>
    <div style="background:var(--bg1);border:1px solid ${balance>=0?"#3b82f6":"#f59e0b"}44;border-radius:12px;padding:16px;text-align:center">
      <div style="font-size:13px;color:${balance>=0?"#3b82f6":"#f59e0b"};font-weight:700;margin-bottom:6px">Saldo</div>
      <div class="fin-kpi" style="font-weight:700;color:${balance>=0?"#3b82f6":"#f59e0b"};font-family:'Fraunces',serif">${fmtMoney(balance)}</div>
    </div>
  </div>

  ${paymentsEnabled ? renderReceivables() : ""}

  <!-- Gráfico de barras por categoria -->
  ${renderFinChart(income, expense)}

  <!-- Listas -->
  <div class="fin-lists" style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-top:24px">
    ${renderFinList("income", income)}
    ${renderFinList("expense", expense)}
  </div>`;

  return html;
}

// Parcelas a receber de reservas diretas (PMS-007), vencidas primeiro.
function renderReceivables() {
  const list = receivables.filter(p => !p.cancelled);
  if (!list.length) return "";
  const total = list.reduce((s, p) => s + Number(p.amount), 0);
  const late = list.filter(p => p.overdue);
  return `<div style="background:var(--bg1);border:1px solid ${late.length ? "#ef444466" : "var(--bd)"};border-radius:12px;padding:16px;margin-bottom:24px">
    <div style="display:flex;justify-content:space-between;margin-bottom:10px">
      <div style="font-size:13px;color:#f59e0b;font-weight:700">A receber${late.length ? ` · <span style="color:#ef4444">${late.length} vencida(s)</span>` : ""}</div>
      <div style="font-size:13px;font-weight:700;color:#f59e0b">${fmtMoney(total)}</div>
    </div>
    <div style="display:flex;flex-direction:column;gap:6px">
      ${list.map(p => `<div style="display:flex;gap:10px;padding:7px 10px;background:var(--bg0);border-radius:8px;cursor:pointer;align-items:center"
          onclick="openEditModal('${esc(p.reservation_id)}')">
        <div style="font-size:11px;width:78px;color:${p.overdue ? "#ef4444" : "var(--mu)"};font-weight:${p.overdue ? 700 : 400}">${p.overdue ? "🔴 " : ""}${fmtDate(p.due_date)}</div>
        <div style="flex:1;min-width:0;font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">
          ${esc(PAY_KINDS[p.kind] || p.kind)} · Qto ${esc(p.group || p.room_id || "?")} · ${esc(p.guest_name)}</div>
        <div style="font-size:12px;font-weight:700">${fmtMoney(p.amount)}</div>
      </div>`).join("")}
    </div>
  </div>`;
}

function renderFinChart(income, expense) {
  // Agrega por categoria
  const incByCat = {}, expByCat = {};
  income.forEach(t  => { incByCat[t.category] = (incByCat[t.category]||0)+Number(t.amount); });
  expense.forEach(t => { expByCat[t.category] = (expByCat[t.category]||0)+Number(t.amount); });

  const allInc = Object.entries(incByCat).sort((a,b)=>b[1]-a[1]);
  const allExp = Object.entries(expByCat).sort((a,b)=>b[1]-a[1]);
  const maxVal = Math.max(...allInc.map(x=>x[1]), ...allExp.map(x=>x[1]), 1);

  if (!allInc.length && !allExp.length) return "";

  const bar = (cat, val, color) => {
    const pct = Math.round((val/maxVal)*100);
    const info = FIN_CATEGORIES[cat] || {label:cat, icon:"•"};
    return `<div style="display:flex;align-items:center;gap:10px;margin-bottom:8px">
      <div style="font-size:13px;width:20px;text-align:center">${info.icon}</div>
      <div style="font-size:11px;color:var(--mu);width:120px;flex-shrink:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${info.label}</div>
      <div style="flex:1;background:var(--bg0);border-radius:4px;height:16px;overflow:hidden">
        <div style="height:100%;width:${pct}%;background:${color};border-radius:4px;transition:width .3s"></div>
      </div>
      <div style="font-size:11px;font-weight:600;color:var(--tx);width:90px;text-align:right;flex-shrink:0">${fmtMoney(val)}</div>
    </div>`;
  };

  return `<div style="background:var(--bg1);border:1px solid var(--bd);border-radius:12px;padding:16px">
    <div style="font-size:13px;color:var(--mu);font-weight:700;margin-bottom:14px">Distribuição do mês</div>
    ${allInc.length ? `<div style="font-size:12px;color:#22c55e;font-weight:700;margin-bottom:8px">Entradas</div>
      ${allInc.map(([k,v])=>bar(k,v,"#22c55e")).join("")}` : ""}
    ${allExp.length ? `<div style="font-size:12px;color:#ef4444;font-weight:700;margin:12px 0 8px">Saídas</div>
      ${allExp.map(([k,v])=>bar(k,v,"#ef4444")).join("")}` : ""}
  </div>`;
}

function renderFinList(type, list) {
  const isIncome = type === "income";
  const color    = isIncome ? "#22c55e" : "#ef4444";
  const title    = isIncome ? "Entradas" : "Saídas";

  if (!list.length) return `
    <div style="background:var(--bg1);border:1px solid var(--bd);border-radius:12px;padding:16px">
      <div style="font-size:13px;color:${color};font-weight:700;margin-bottom:12px">${title}</div>
      <div style="text-align:center;color:var(--mu);padding:24px 0;font-size:13px">Nenhum lançamento</div>
    </div>`;

  return `
    <div style="background:var(--bg1);border:1px solid var(--bd);border-radius:12px;padding:16px">
      <div style="font-size:13px;color:${color};font-weight:700;margin-bottom:12px">${title}</div>
      <div style="display:flex;flex-direction:column;gap:6px">
        ${list.map(t => {
          const cat  = FIN_CATEGORIES[t.category] || {label:t.category, icon:"•"};
          // Pagamentos de reserva (PMS-007) são somente leitura aqui: edita-se na reserva.
          const click = t.readonly
            ? (reservations.some(r => r.id === t.reservation_id) ? `onclick="openEditModal('${esc(t.reservation_id)}')"` : "")
            : `onclick="openTransactionModal('${esc(t.id)}')"`;
          return `<div style="display:flex;align-items:center;gap:10px;padding:8px 10px;
            background:var(--bg0);border-radius:8px;cursor:pointer" ${click}>
            <span style="font-size:16px">${cat.icon}</span>
            <div style="flex:1;min-width:0">
              <div style="font-size:12px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${t.readonly ? "💳 " : ""}${esc(t.description)}</div>
              <div style="font-size:10px;color:var(--mu);margin-top:1px">${esc(cat.label)} · ${esc(fmtDate(t.date))}${t.readonly ? " · via reserva" : ""}</div>
            </div>
            <div style="font-size:13px;font-weight:700;color:${color};flex-shrink:0">${fmtMoney(t.amount)}</div>
          </div>`;
        }).join("")}
      </div>
    </div>`;
}

function changeFinMonth(month) {
  finMonth = month;
  loadTransactions(month);
}

function openTransactionModal(id) {
  const t = id ? (transactions.find(x=>x.id===id)||{}) : {};
  const isEdit = !!id;
  const today  = new Date().toISOString().split("T")[0];

  const incCats = Object.entries(FIN_CATEGORIES).filter(([,v])=>v.type==="income");
  const expCats = Object.entries(FIN_CATEGORIES).filter(([,v])=>v.type==="expense");

  document.getElementById("modal-title").innerHTML =
    `${isEdit?"✏️ Editar":"➕ Novo"} Lançamento <button onclick="closeModal()">×</button>`;
  document.getElementById("modal-body").innerHTML = `
    <div style="display:flex;flex-direction:column;gap:12px;margin-bottom:20px">
      <div class="row2">
        <div class="field"><label>Tipo</label>
          <select id="ft-type" onchange="updateFinCatOptions()">
            <option value="income"  ${(!t.type||t.type==="income") ?"selected":""}>💵 Entrada</option>
            <option value="expense" ${t.type==="expense"?"selected":""}>💸 Saída</option>
          </select></div>
        <div class="field"><label>Categoria</label>
          <select id="ft-cat"></select></div>
      </div>
      <div class="field"><label>Descrição</label>
        <input id="ft-desc" value="${esc(t.description||"")}" placeholder="Ex: Conta de luz de março"></div>
      <div class="row2">
        <div class="field"><label>Valor (R$)</label>
          <input type="number" id="ft-amount" value="${esc(t.amount||"")}" min="0" step="0.01" placeholder="0,00"></div>
        <div class="field"><label>Data</label>
          <input type="date" id="ft-date" value="${esc(t.date||today)}"></div>
      </div>
    </div>
    <div style="display:flex;gap:10px;justify-content:flex-end">
      ${isEdit?`<button class="btn btn-red" onclick="deleteTransaction('${t.id}')">Excluir</button>`:""}
      <button class="btn btn-green" onclick="saveTransaction(${isEdit?`'${t.id}'`:"null"})">
        ${isEdit?"Salvar":"Registrar"}
      </button>
    </div>`;
  document.getElementById("modal").style.display = "flex";

  // Preenche opções de categoria
  updateFinCatOptions(t.category);
}

function updateFinCatOptions(selectedCat) {
  const type = document.getElementById("ft-type")?.value;
  const sel  = document.getElementById("ft-cat");
  if (!sel) return;
  sel.innerHTML = Object.entries(FIN_CATEGORIES)
    .filter(([,v])=>v.type===type)
    .map(([k,v])=>`<option value="${k}" ${k===selectedCat?"selected":""}>${v.icon} ${v.label}</option>`)
    .join("");
}

async function saveTransaction(id) {
  const t = {
    id:          id || Math.random().toString(36).slice(2,10),
    type:        document.getElementById("ft-type")?.value,
    category:    document.getElementById("ft-cat")?.value,
    description: document.getElementById("ft-desc")?.value.trim(),
    amount:      parseFloat(document.getElementById("ft-amount")?.value)||0,
    date:        document.getElementById("ft-date")?.value,
  };
  if (!t.description) { alert("Preencha a descrição"); return; }
  if (!t.amount || t.amount <= 0) { alert("Valor deve ser maior que zero"); return; }
  if (!t.date) { alert("Selecione a data"); return; }
  t.month = t.date.slice(0,7);

  const ok = id ? await apiWrite("PUT",  "/transactions/"+id, t, "salvar o lançamento")
               : await apiWrite("POST", "/transactions", t, "salvar o lançamento");
  if (!ok) return;
  closeModal();
  await loadTransactions(finMonth);
}

async function deleteTransaction(id) {
  if (!confirm("Excluir este lançamento?")) return;
  if (!(await apiWrite("DELETE", "/transactions/"+id, null, "excluir o lançamento"))) return;
  closeModal();
  await loadTransactions(finMonth);
}
