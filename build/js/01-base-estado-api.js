// Parte do frontend da PMS (PMS-017). Carregado em ordem por index.html;
// todos os arquivos compartilham o escopo global, como o antigo script único.
// ─── Sanitização XSS ──────────────────────────────────────────────────────────
// SEMPRE use esc() ao inserir dados do usuário em innerHTML
function esc(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/\x3c/g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}


const ROOMS = [
  {id:"10",type:"Triplo",climate:"AC",cap:3},
  {id:"11",type:"Triplo",climate:"Ventilador",cap:3},
  {id:"12",type:"Triplo",climate:"Ventilador",cap:3},
  {id:"20",type:"Quádruplo",climate:"AC",cap:4},
  {id:"21",type:"Triplo",climate:"AC",cap:3},
  {id:"22",type:"Casal+1 Soltr",climate:"AC",cap:3},
  {id:"23",type:"Casal+2 Soltr",climate:"AC",cap:4},
  {id:"24",type:"Duplo",climate:"AC",cap:2},
  {id:"25",type:"Casal+1 Soltr",climate:"AC",cap:3},
];

// ─── Suítes (quartos combinados) ─────────────────────────────────────────────
const SUITES = [
  { id:"11+12", label:"Suíte 11+12", rooms:["11","12"], type:"Triplo ×2 (Ventilador)", cap:6 }
];
const todayStr  = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
};
const fmtDate   = s => s ? new Date(s+"T12:00:00").toLocaleDateString("pt-BR") : "—";
const fmtMonth  = s => s ? new Date(s+"T12:00:00").toLocaleDateString("pt-BR",{month:"long",year:"numeric"}) : "";
const genId     = () => Math.random().toString(36).slice(2,10);
const nights    = (ci,co) => Math.max(0,Math.round((new Date(co)-new Date(ci))/86400000));
const isSameDay = (a,b) => a===b;

// ─── State ────────────────────────────────────────────────────────────────────
let reservations = [];
let guests        = [];
let guestSearch   = "";
let transactions  = [];
// PMS-007: pagamentos ativos quando a tabela existe no banco (o servidor informa).
let paymentsEnabled = false;
let receivables     = [];
let finMonth      = todayStr().slice(0,7); // YYYY-MM
let currentView  = "map";
let syncLog      = [];
let icalUrls     = {booking:{},airbnb:{}};
let filterTab    = "upcoming";
let searchQ      = "";
let dateFrom     = "";
let dateTo       = "";
let groupByDate  = true;          // agrupamento por data nas reservas
let prereservations = [];


let cleanedRooms   = new Set();   // quartos limpos hoje (antes nunca era declarada)
let checkedInRooms = new Set();   // quartos com check-in confirmado hoje

async function saveRoomStates() {
  try {
    await api("POST", "/room-states", {
      cleaned:   [...cleanedRooms],
      checkedIn: [...checkedInRooms],
    });
  } catch(e) { console.error("saveRoomStates:", e); }
}

async function loadRoomStates() {
  try {
    const data = await api("GET", "/room-states");
    cleanedRooms   = new Set(data.cleaned   || []);
    checkedInRooms = new Set(data.checkedIn || []);
  } catch(e) { console.error("loadRoomStates:", e); }
}

// saveClean/saveCheckedIn agora salvam no servidor (sincroniza entre dispositivos)
function saveClean()     { saveRoomStates(); }
function saveCheckedIn() { saveRoomStates(); }

// Qual marcação de hoje pode ser desfeita neste quarto (PMS-013), ou null.
function undoableMark(roomId) {
  const t = todayStr();
  const active = r => r.roomId === roomId && occupies(r); // mesma regra de getRoomStatus
  if (checkedInRooms.has(roomId) && reservations.some(r => active(r) && r.checkIn === t)) return "checkedIn";
  if (cleanedRooms.has(roomId) && reservations.some(r => active(r) && r.checkOut === t)) return "cleaned";
  return null;
}
const UNDO_LABEL = { checkedIn: "check-in", cleaned: "limpeza" };

// Desfaz uma marcação feita por engano. Pede confirmação; erro aparece na tela.
async function unmarkRoomState(roomId, kind, event) {
  if (event) event.stopPropagation();
  if (!confirm(`Desfazer a marcação de ${UNDO_LABEL[kind]} do quarto ${roomId}?`)) return;
  const res = await api("DELETE", `/room-states/${encodeURIComponent(roomId)}/${kind}`);
  if (res && Array.isArray(res.cleaned) && Array.isArray(res.checkedIn)) {
    cleanedRooms   = new Set(res.cleaned);
    checkedInRooms = new Set(res.checkedIn);
  } else {
    alert("Não foi possível desfazer a marcação do quarto " + roomId + ": " +
          (apiErrorMessage(res) || "verifique a conexão") + ".");
    await loadRoomStates();
  }
  render();
}

// Marca um quarto no servidor (uma marcação por vez, somada às dos outros aparelhos).
// Em caso de falha, avisa e recarrega o estado real, em vez de fingir que salvou.
async function markRoomState(roomId, kind) {
  const res = await api("POST", `/room-states/${encodeURIComponent(roomId)}/${kind}`);
  if (res && Array.isArray(res.cleaned) && Array.isArray(res.checkedIn)) {
    cleanedRooms   = new Set(res.cleaned);
    checkedInRooms = new Set(res.checkedIn);
  } else {
    alert("Não foi possível salvar a marcação do quarto " + roomId + ". Verifique a conexão e tente de novo.");
    await loadRoomStates();
  }
  render();
}

// ─── Auth state ──────────────────────────────────────────────────────────────
let authToken    = localStorage.getItem("pms_token") || "";
let authRole     = localStorage.getItem("pms_role")  || "";
let authUsername = localStorage.getItem("pms_user")  || "";

function setAuth(token, role, username) {
  authToken = token; authRole = role; authUsername = username;
  localStorage.setItem("pms_token",   token);
  localStorage.setItem("pms_role",    role);
  localStorage.setItem("pms_user",    username);
}
function clearAuth() {
  authToken = ""; authRole = ""; authUsername = "";
  localStorage.removeItem("pms_token");
  localStorage.removeItem("pms_role");
  localStorage.removeItem("pms_user");
}

// ─── API ──────────────────────────────────────────────────────────────────────
async function api(method, path, body) {
  const opts = {method, headers:{"Content-Type":"application/json",
    ...(authToken ? {"Authorization":"Bearer "+authToken} : {})}};
  if (body) opts.body = JSON.stringify(body);
  let r;
  try {
    r = await fetch(path, opts);
  } catch(e) {
    console.error("api error:", e);
    return { _networkError: true, error: "Erro de conexão" };
  }
  // Sessão expirada: volta ao login e NÃO conta como sucesso (antes devolvia {},
  // que apiErrorMessage lia como "salvo").
  if (r.status === 401) { clearAuth(); showLoginScreen(); return { error: "Sua sessão expirou. Entre de novo; nada foi salvo." }; }
  // Resposta que não é JSON (ex.: página 502 do Render durante deploy). Antes o
  // erro escapava do try (return sem await) e o clique simplesmente não fazia nada.
  try { return await r.json(); }
  catch(e) {
    return { error: `O servidor respondeu de forma inesperada (HTTP ${r.status}). Nada foi salvo; tente de novo em instantes.` };
  }
}

// Gravação que confere a resposta (PMS-012). Em erro: avisa o motivo e devolve
// false, para quem chamou NÃO fechar o formulário nem fingir que salvou.
async function apiWrite(method, path, body, what) {
  const res = await api(method, path, body);
  const err = apiErrorMessage(res);
  if (err) { alert(`Não foi possível ${what}: ${err}`); return false; }
  return true;
}

async function doLogin() {
  const username = document.getElementById("l-user")?.value.trim();
  const password = document.getElementById("l-pass")?.value;
  const errEl = document.getElementById("l-err");
  errEl.textContent = "";
  try {
    const res = await fetch("/login", {
      method:"POST", headers:{"Content-Type":"application/json"},
      body: JSON.stringify({username, password})
    });
    const data = await res.json();
    if (!res.ok) { errEl.textContent = data.error || "Erro ao entrar"; return; }
    setAuth(data.token, data.role, data.username);
    hideLoginScreen();
    applyRole();
    await loadAll();
    startAutoRefresh();
    render();
  } catch(e) { errEl.textContent = "Erro de conexão"; }
}

function showLoginScreen() {
  document.getElementById("login-screen").classList.remove("hidden");
}
function hideLoginScreen() {
  document.getElementById("login-screen").classList.add("hidden");
}

function applyRole() {
  // Esconde itens admin-only para staff
  document.querySelectorAll(".admin-only").forEach(el => {
    el.style.display = authRole === "admin" ? "" : "none";
  });
  // Se estava na view de sync e é staff, volta pro mapa
  if (authRole !== "admin" && ["sync", "alertas", "prereservas", "calendarios", "financeiro", "relatorios"].includes(currentView)) {
    currentView = "map";
  }
  // Atualiza tooltip do botão de usuário
  const btn = document.getElementById("user-nav-btn");
  if (btn) btn.title = authUsername + " — clique para sair";
}

function showUserMenu() {
  const isAdmin = authRole === "admin";
  document.getElementById("modal-title").innerHTML =
    `👤 Minha conta <button onclick="closeModal()">×</button>`;
  document.getElementById("modal-body").innerHTML = `
    <div style="margin-bottom:20px">
      <div style="font-size:15px;font-weight:700">${authUsername}</div>
      <div style="font-size:12px;color:var(--mu);margin-top:4px">
        ${isAdmin ? "👑 Administrador" : "👥 Funcionário"}
      </div>
    </div>
    ${isAdmin ? `
    <div style="margin-bottom:24px">
      <div style="font-size:13px;color:var(--mu);font-weight:700;margin-bottom:12px">
        Alterar senha
      </div>
      <input type="password" id="cp-cur" placeholder="Senha atual"
        style="width:100%;background:var(--bg0);border:1px solid var(--bd);border-radius:8px;
        padding:10px 12px;color:var(--tx);font-size:13px;margin-bottom:8px;outline:none;box-sizing:border-box">
      <input type="password" id="cp-new" placeholder="Nova senha"
        style="width:100%;background:var(--bg0);border:1px solid var(--bd);border-radius:8px;
        padding:10px 12px;color:var(--tx);font-size:13px;margin-bottom:8px;outline:none;box-sizing:border-box">
      <input type="password" id="cp-new2" placeholder="Confirmar nova senha"
        style="width:100%;background:var(--bg0);border:1px solid var(--bd);border-radius:8px;
        padding:10px 12px;color:var(--tx);font-size:13px;margin-bottom:8px;outline:none;box-sizing:border-box">
      <button class="btn btn-blue" style="width:100%" onclick="doChangePassword()">
        Salvar nova senha
      </button>
    </div>` : ""}
    <button class="btn btn-red" style="width:100%" onclick="doLogout()">
      🚪 Sair
    </button>`;
  document.getElementById("modal").style.display = "flex";
}

async function doChangePassword() {
  const cur  = document.getElementById("cp-cur")?.value;
  const nw   = document.getElementById("cp-new")?.value;
  const nw2  = document.getElementById("cp-new2")?.value;
  if (!cur || !nw) { alert("Preencha todos os campos"); return; }
  if (nw !== nw2)  { alert("As senhas não coincidem"); return; }
  if (nw.length < 6) { alert("Senha deve ter ao menos 6 caracteres"); return; }
  const res = await api("POST", "/change-password", {currentPassword:cur, newPassword:nw});
  if (res.ok) {
    // O servidor derruba as sessões antigas e devolve um token novo para este aparelho.
    if (res.token) setAuth(res.token, authRole, authUsername);
    alert("Senha alterada com sucesso! Os outros aparelhos vão pedir login de novo.");
    closeModal();
  }
  else alert(res.error || "Erro ao alterar senha");
}

function doLogout() {
  clearAuth();
  stopAutoRefresh();
  closeModal();
  currentView = "map";
  showLoginScreen();
}

const BLOCKED_NAMES = [
  /not available/i, /closed/i, /blocked/i,
  /bloqueado/i, /indispon/i, /unavailable/i,
];
// Só filtra bloqueios do Airbnb — no Booking "Closed" pode ser reserva real
const isAirbnbBlock = r => r.source === "airbnb" && BLOCKED_NAMES.some(p => p.test(r.guestName||""));

// Estado do último carregamento (PMS-012). Quando uma lista falha, a tela
// mantém o último dado válido e mostra um aviso — antes ela era trocada por []
// e parecia "sem reservas", induzindo a vender quarto ocupado.
let loadError    = null;   // texto do problema atual, ou null
let lastLoadedAt = null;   // Date do último carregamento completo de reservas
let reservationsLoaded = false;

async function loadAll() {
  const failed = [];
  try {
    const promises = [
      api("GET","/reservations"),
      api("GET","/guests"),
      api("GET","/room-states"),
      authRole === "admin" ? api("GET","/urls") : Promise.resolve(null),
      authRole === "admin" ? api("GET","/transactions?month="+finMonth) : Promise.resolve(null),
      authRole === "admin" ? api("GET","/prereservations") : Promise.resolve(null),
    ];
    const [res, gsts, states, urls, txns, preresvs] = await Promise.all(promises);
    if (Array.isArray(res)) {
      reservations = res.map(normalizeRes).filter(r => !isAirbnbBlock(r));
      reservationsLoaded = true;
      lastLoadedAt = new Date();
    } else failed.push("reservas");
    if (Array.isArray(gsts)) guests = gsts; else failed.push("hóspedes");
    if (states && Array.isArray(states.cleaned) && Array.isArray(states.checkedIn)) {
      cleanedRooms   = new Set(states.cleaned);
      checkedInRooms = new Set(states.checkedIn);
    } else if (!(states && !states.error && !states._networkError)) failed.push("limpeza/check-in");
    if (authRole === "admin") {
      if (urls && !urls.error && !urls._networkError) icalUrls = urls; else failed.push("calendários");
      if (Array.isArray(txns)) transactions = txns; else failed.push("financeiro");
      if (Array.isArray(preresvs)) prereservations = preresvs; else failed.push("pré-reservas");
    }
  } catch(e) { console.error(e); failed.push("conexão"); }
  if (authRole === "admin") {
    const ps = await api("GET", "/payments/status");
    if (ps && typeof ps.enabled === "boolean") paymentsEnabled = ps.enabled;
  }
  loadError = failed.length ? `Não foi possível atualizar: ${failed.join(", ")}.` : null;
  await refreshSyncStatus();
  render();
}

// Situação dos calendários Airbnb/Booking (PMS-011). Se estiverem atrasados ou
// com falha, a disponibilidade importada pode estar desatualizada: o aviso
// aparece no topo para todos. Enquanto houver problema, confere de novo em 1 min
// (ao acordar, o servidor sincroniza ~10 s depois de abrir).
let syncHealth = null;
let syncRecheckTimer = null;
async function refreshSyncStatus() {
  const st = await api("GET", "/sync/status");
  if (st && st.health && !st.error && !st._networkError) {
    syncHealth = { ...st.health, syncing: !!st.syncing };
  }
  if (syncRecheckTimer) { clearTimeout(syncRecheckTimer); syncRecheckTimer = null; }
  if (syncHealth && !syncHealth.ok) {
    syncRecheckTimer = setTimeout(async () => { syncRecheckTimer = null; await refreshSyncStatus(); render(); }, 60 * 1000);
  }
}

function feedLabel(key) {
  const [src, room] = String(key).split("/");
  const name = src === "airbnb" ? "Airbnb" : src === "booking" ? "Booking" : src;
  return `${name} ${room === "CF" ? "Casa Fechada" : room}`;
}

function fmtWhen(iso) {
  if (!iso) return "nunca";
  const d = new Date(iso);
  if (isNaN(d)) return "nunca";
  const sameDay = d.toDateString() === new Date().toDateString();
  const hm = d.toLocaleTimeString("pt-BR", { hour:"2-digit", minute:"2-digit" });
  return sameDay ? `às ${hm}` : `em ${d.toLocaleDateString("pt-BR", { day:"2-digit", month:"2-digit" })} ${hm}`;
}

// Fechamentos que a plataforma devolveu depois de ler o link da PMS (eco). Não
// é falha e não vai para o aviso do topo, mas fica visível em Sincronizar.
function echoNote(echoes) {
  if (!Array.isArray(echoes) || !echoes.length) return null;
  return "ℹ️ Datas que a plataforma devolveu fechadas depois de receber da PMS: " +
    echoes.map(e => `${feedLabel(e.feed).split(" ")[0]} ${e.room === "CF" ? "Casa Fechada" : e.room === "11+12" ? "suíte 11+12" : "quarto " + e.room}, ${fmtDate(e.checkIn)} → ${fmtDate(e.checkOut)}`).join("; ") +
    ". Já estão ocupadas na PMS, por isso não entram de novo. Se alguma for reserva de verdade no extranet, é overbooking: resolva na plataforma.";
}

// Texto do aviso de calendários, ou null se está tudo em dia.
function syncWarning() {
  const h = syncHealth;
  if (!h || h.ok) return null;
  if (h.neverRan) return "Os calendários do Airbnb/Booking ainda não foram sincronizados.";
  const parts = [];
  const conflicts = (h.failing || []).flatMap(f => (f.conflicts || []).map(c => ({ ...c, feed: f.feed })));
  if (conflicts.length)
    parts.push("⛔ Possível overbooking — reserva (ou mudança de datas) da plataforma NÃO foi aplicada no PMS porque há quarto ocupado: " +
      conflicts.map(c => `${feedLabel(c.feed).split(" ")[0]} ${c.room === "CF" ? "Casa Fechada" : c.room === "11+12" ? "suíte 11+12" : "quarto " + c.room}, ${fmtDate(c.checkIn)} → ${fmtDate(c.checkOut)}`).join("; ") +
      ". Confira na plataforma e resolva.");
  const otherFailing = (h.failing || []).filter(f => !(f.conflicts || []).length);
  if (otherFailing.length)
    parts.push("Calendário com falha: " + otherFailing.map(f => `${feedLabel(f.feed)} (${f.problem})`).join(", ") + ".");
  const stale = (h.stale || []).filter(s => !(h.failing || []).some(f => f.feed === s.feed));
  if (stale.length)
    parts.push("Sem atualizar: " + stale.map(s => `${feedLabel(s.feed)} (${fmtWhen(s.lastSuccessAt)})`).join(", ") + ".");
  if (!parts.length && h.runStale)
    parts.push(`Calendários do Airbnb/Booking sem atualizar desde ${fmtWhen(h.lastRunAt)}.`);
  if (h.syncing) parts.push("Atualizando agora…");
  return parts.join(" ");
}

// Aviso no topo quando os dados podem estar desatualizados ou incompletos.
function renderLoadBanner() {
  const el = document.getElementById("load-banner");
  if (!el) return;
  const sw = syncWarning();
  if (!loadError && !sw) { el.style.display = "none"; el.innerHTML = ""; return; }
  let html = "";
  if (loadError) {
    const when = lastLoadedAt
      ? `Dados de reservas da última atualização às ${lastLoadedAt.toLocaleTimeString("pt-BR",{hour:"2-digit",minute:"2-digit"})}.`
      : "As reservas ainda não foram carregadas nesta sessão.";
    html += `⚠️ <b>${esc(loadError)}</b> ${esc(when)} Não confirme disponibilidade sem atualizar.
    <button class="btn" style="margin-left:8px;font-size:11px;padding:4px 10px" onclick="loadAll()">Tentar de novo</button>`;
  }
  if (sw) {
    html += `${html ? "<br>" : ""}📅 <b>${esc(sw)}</b> Reservas novas do Airbnb/Booking podem não aparecer: confira na plataforma antes de confirmar datas.`;
  }
  el.innerHTML = html;
  el.style.display = "block";
}

function normalizeRes(r) {
  return {
    id:          r.id,
    roomId:      r.room_id    || r.roomId,
    guestName:   r.guest_name || r.guestName,
    checkIn:     r.check_in   || r.checkIn,
    checkOut:    r.check_out  || r.checkOut,
    source:      r.source     || "direto",
    adults:      r.adults     || 2,
    children:    r.children   || 0,
    phone:       r.phone      || "",
    notes:       r.notes      || "",
    status:      r.status     || "confirmed",
    externalUid: r.external_uid || r.externalUid || null,
    groupId:     r.group_id || r.groupId || null,
    createdAt:   r.created_at   || r.createdAt   || new Date().toISOString(),
    amount:      r.amount   || 0,
    payment:     r.payment  || "pix",
  };
}

// Extrai a mensagem de erro de uma resposta da API (formato antigo {error:"..."}
// ou novo {error:{code,message}}). Retorna null quando a resposta é sucesso.
function apiErrorMessage(res) {
  if (!res || res._networkError) return "Erro de conexão. Nada foi salvo; tente novamente.";
  if (!res.error) return null;
  if (typeof res.error === "string") return res.error;
  if (res.error.code === "ROOM_CONFLICT")
    return `Quarto indisponível no período${res.error.rooms ? " (quarto " + res.error.rooms.join(", ") + ")" : ""}. Nada foi salvo.`;
  return res.error.message || "Erro ao salvar.";
}

// Salva (cria ou edita) UMA linha de reserva.
// Retorna { ok:true, reservation } ou { ok:false, error }. Não recarrega a tela:
// quem chama decide quando chamar loadAll() (evita recarregar 9x numa Casa Fechada).
async function saveReservation(form) {
  const isExisting = form.id && reservations.find(r=>r.id===form.id);
  if (isExisting) {
    const res = await api("PUT",`/reservations/${form.id}`, form);
    const err = apiErrorMessage(res);
    if (err) return { ok:false, error: err };
    if (res && res.warning) alert(res.warning); // ex.: pagamento automático não registrado
    // Ajuste de valor em reserva direta: só ATUALIZA o lançamento já vinculado.
    // Não cria lançamento novo na edição (antes isso duplicava receita — F2).
    // Modo antigo (sem pagamentos): ajusta o lançamento vinculado. Com pagamentos
    // ativos, mudar o valor contratado NÃO mexe na receita (regra 6).
    if (!paymentsEnabled && form.amount > 0 && form.source === "direto" && authRole === "admin") {
      const linked = await api("GET", "/transactions?reservation_id=" + encodeURIComponent(form.id));
      const existing = Array.isArray(linked)
        ? linked.find(t => t.reservation_id === form.id && t.type === "income")
        : null;
      if (existing) {
        if (Number(existing.amount) !== Number(form.amount)) {
          await api("PUT", "/transactions/"+existing.id, {
            ...existing,
            amount: form.amount,
            description: `Reserva Qto ${form.roomId} — ${form.guestName}`,
          });
        }
      } else if (Array.isArray(linked) &&
                 !/\[(Casa toda|Suíte grupo):/.test(form.notes || "")) {
        // Em CF/11+12 o lançamento fica só na primeira linha; não avisar nas demais.
        alert("Reserva salva. Não há lançamento financeiro vinculado a ela; " +
              "se algum valor já foi recebido, registre no Financeiro.");
      }
    }
    return { ok:true };
  }
  // Nova reserva: mantém o id gerado por quem chamou (antes era trocado aqui,
  // deixando o lançamento financeiro apontando para um id inexistente — F1).
  const res = await api("POST","/reservations", {...form, id: form.id || genId()});
  const err = apiErrorMessage(res);
  if (err || !res.reservation) return { ok:false, error: err || "Erro ao salvar a reserva." };
  if (res.warning) alert(res.warning);
  reservations.push(normalizeRes(res.reservation));
  return { ok:true, reservation: res.reservation };
}

// Grava uma reserva composta (CF ou 11+12) numa única chamada ao servidor,
// que grava todas as linhas ou nenhuma (regra 5). Antes eram 9 chamadas
// seguidas: uma falha de rede no meio deixava a Casa Fechada pela metade.
async function saveReservationGroup(rows) {
  const ids = rows.map(r => r.id || genId());
  const res = await api("POST", "/reservations/group", {
    rows: rows.map((r, i) => ({ ...r, id: ids[i] })),
  });
  // Sem resposta, não dá para saber se o servidor gravou: avisar para conferir
  // antes de repetir (repetir criaria uma segunda Casa Fechada).
  if (res && res._networkError)
    return { ok:false, created: [], error: "Sem conexão com o servidor. Confira na tela se a reserva " +
      "aparece antes de tentar de novo — ela pode ter sido gravada." };
  const err = apiErrorMessage(res);
  if (err || !Array.isArray(res.reservations))
    return { ok:false, error: err || "Erro ao salvar a reserva. Nada foi salvo.", created: [] };
  if (res.warning) alert(res.warning);
  res.reservations.forEach(r => reservations.push(normalizeRes(r)));
  return { ok:true, created: rows.map((r, i) => ({ id: ids[i], roomId: r.roomId })) };
}

// Ocupa o quarto? Cancelada e "pending" não (decisão de 23/11/2026; mesma
// regra do servidor e do banco).
const occupies = r => r.status !== "cancelled" && r.status !== "pending";

// Capacidade (decisão de 23/11/2026: só AVISAR, nunca barrar — cama extra,
// criança de colo etc.). CF = soma dos 9 quartos; 11+12 = soma dos dois.
function capacityOf(roomId) {
  if (roomId === "CF") return ROOMS.reduce((s, r) => s + r.cap, 0);
  const suite = SUITES.find(x => x.id === roomId);
  if (suite) return suite.cap;
  const room = ROOMS.find(x => x.id === roomId);
  return room ? room.cap : null;
}
// Pergunta antes de salvar acima da capacidade. Na edição, só se o número de
// hóspedes AUMENTOU (não insiste a cada salvamento de uma cama extra combinada).
function confirmCapacity(roomId, adults, children, previous) {
  const cap = capacityOf(roomId);
  const n = (Number(adults) || 0) + (Number(children) || 0);
  if (!cap || n <= cap) return true;
  if (previous && n <= (Number(previous.adults) || 0) + (Number(previous.children) || 0)) return true;
  const where = roomId === "CF" ? "a Casa Fechada" : roomId === "11+12" ? "a suíte 11+12" : `o quarto ${roomId}`;
  return confirm(`Atenção: ${n} hóspedes para ${where}, que comporta ${cap}. Salvar mesmo assim?`);
}

// Checagem de conflito no navegador para os quartos físicos informados.
// Serve só para avisar cedo; a garantia real fica no servidor/banco.
function localConflict(roomIds, checkIn, checkOut, ignoreId) {
  return reservations.find(r =>
    r.id !== ignoreId &&
    roomIds.includes(r.roomId) &&
    occupies(r) &&
    r.checkIn < checkOut &&
    r.checkOut > checkIn
  );
}

// PMS-006: rótulo do grupo da reserva (Casa Fechada / 11+12), ou null.
function groupLabelOf(r) {
  if (!r) return null;
  const tag = r.groupId || "";
  if (tag.startsWith("cf:") || /\[Casa toda:/.test(r.notes || "")) return "Casa Fechada (9 quartos)";
  if (tag.startsWith("suite:") || /\[Suíte grupo:/.test(r.notes || "")) return "suíte 11+12 (2 quartos)";
  return null;
}

async function cancelReservation(id) {
  const r = reservations.find(x => x.id === id);
  // Com a coluna de grupo, o servidor cancela o grupo inteiro de uma vez.
  const grp = r && r.groupId ? groupLabelOf(r) : null;
  const msg = grp ? `Cancelar a ${grp} inteira? Todos os quartos do grupo serão cancelados juntos. Esta ação não pode ser desfeita.`
                  : "Cancelar esta reserva? Esta ação não pode ser desfeita.";
  if (!confirm(msg)) return;
  const res = await api("PUT",`/reservations/${id}`, {status:"cancelled"});
  const err = apiErrorMessage(res);
  if (err) { alert("Não foi possível cancelar: " + err); await loadAll(); return; }
  await loadAll();
  closeModal();
}
