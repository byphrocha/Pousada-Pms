// Parte do frontend da PMS (PMS-017). Carregado em ordem por index.html;
// todos os arquivos compartilham o escopo global, como o antigo script único.
// ─── Room helpers ─────────────────────────────────────────────────────────────
function getRoomStatus(roomId) {
  const t = todayStr();
  // Pendente não ocupa (decisão de 23/11/2026): só reservas que ocupam contam.
  const hasCheckoutToday = reservations.some(r=>
    r.roomId===roomId && occupies(r) && r.checkOut===t
  );
  const hasCheckinToday = reservations.some(r=>
    r.roomId===roomId && occupies(r) && r.checkIn===t
  );

  // Se tem checkout hoje e ainda não limpou → roxo (limpeza obrigatória antes do próximo check-in)
  if (hasCheckoutToday && !cleanedRooms.has(roomId)) return "cleaning";

  // Quarto limpo (ou sem checkout hoje) — verifica check-in
  if (hasCheckinToday) {
    if (checkedInRooms.has(roomId)) return "occupied"; // check-in confirmado → vermelho
    return "checkin";                                   // check-in pendente → azul
  }

  // Ocupado (hóspede já dentro, sem movimento hoje)
  const isOccupied = reservations.some(r=>
    r.roomId===roomId && occupies(r) && r.checkIn<t && r.checkOut>t
  );
  if (isOccupied) return "occupied";

  return "free";
}

function getRoomRes(roomId) {
  const t = todayStr();
  return reservations.find(r=>
    r.roomId===roomId && occupies(r) && r.checkIn<=t && r.checkOut>t
  );
}

function markCheckedIn(roomId, event) {
  if (event) event.stopPropagation();
  checkedInRooms.add(roomId);
  render();
  return markRoomState(roomId, "checkedIn");
}

function markClean(roomId, event) {
  if (event) event.stopPropagation();
  cleanedRooms.add(roomId);
  render();
  return markRoomState(roomId, "cleaned");
}

const STATUS = {
  free:    {label:"Livre",    color:"#22c55e", bg:"#0f2b1a", icon:"🚪"},
  occupied:{label:"Ocupado",  color:"#ef4444", bg:"#2b0f0f", icon:"🔒"},
  checkin: {label:"Check-in", color:"#3b82f6", bg:"#0f1e2b", icon:"🔓"},
  checkout:{label:"Check-out",color:"#f59e0b", bg:"#2b1e0a", icon:"🧹"},
  cleaning:{label:"Limpeza",  color:"#a855f7", bg:"#1e0f2b", icon:"🧹"},
};
const SRC_COLOR = {direto:"#8b5cf6",booking:"#0066cc",airbnb:"#ff5a5f"};

// ─── Render engine ────────────────────────────────────────────────────────────
function render() {
  renderLoadBanner();
  const titles = {map:"Mapa de Quartos", reservas:"Reservas",
    hospedes:"Hóspedes", financeiro:"Financeiro",
    alertas:"⚠️ Alertas de Overbooking", prereservas:"📝 Pré-reservas & Leads",
    calendarios:"📅 Calendários iCal — Exportar para Booking/Airbnb",
    sync:"Sincronizar iCal", relatorios:"📈 Relatórios", calendario:"🗓️ Calendário de ocupação"};
  document.getElementById("view-title").textContent  = titles[currentView] || "";
  document.getElementById("today-label").textContent =
    new Date().toLocaleDateString("pt-BR",{weekday:"long",day:"numeric",month:"long",year:"numeric"});
  document.getElementById("nav-more-btn")?.classList.toggle("active", !NAV_MAIN.includes(currentView));
  document.querySelectorAll(".nav-btn[data-view]").forEach(b=>{
    b.classList.toggle("active", b.dataset.view===currentView);
  });
  const el = document.getElementById("content");
  if (currentView==="map")         el.innerHTML = renderMap();
  if (currentView==="reservas")    el.innerHTML = renderReservas();
  if (currentView==="hospedes")    el.innerHTML = renderHospedes();
  if (currentView==="financeiro")  el.innerHTML = renderFinanceiro();
  if (currentView==="alertas")     el.innerHTML = renderAlertas();
  if (currentView==="prereservas") el.innerHTML = renderPreReservas();
  if (currentView==="calendarios")  el.innerHTML = renderCalendarios();
  if (currentView==="sync")         el.innerHTML = renderSync();
  if (currentView==="relatorios")   el.innerHTML = renderRelatorios();
  if (currentView==="calendario")   el.innerHTML = renderCalendario();

  // Badge de alerta no botão ⚠️
  if (authRole === "admin") {
    const alertCount = findOverbookings().length;
    navAlertCount = alertCount;
    document.querySelector('.nav-btn[data-view="alertas"]')?.classList.toggle("has-alert", alertCount > 0);
    document.getElementById("nav-more-btn")?.classList.toggle("has-alert", alertCount > 0 && authRole === "admin");
  }
}

// ─── Menu "Mais" (celular): o que não cabe na barra, separado por grupo ──────
const NAV_MAIN = ["map", "reservas", "calendario", "hospedes"];
let navAlertCount = 0;
// Mesma lista e mesmos nomes do menu lateral (um teste garante que batem).
const NAV_EXTRA = [
  { view: "financeiro",  ico: "💰", lbl: "Financeiro",   group: "Dinheiro", admin: true },
  { view: "relatorios",  ico: "📈", lbl: "Relatórios",   group: "Dinheiro", admin: true },
  { view: "alertas",     ico: "⚠️", lbl: "Alertas",      group: "Canais",   admin: true },
  { view: "prereservas", ico: "📝", lbl: "Pré-reservas", group: "Canais",   admin: true },
  { view: "calendarios", ico: "📅", lbl: "Links iCal",   group: "Canais",   admin: true },
  { view: "sync",        ico: "🔄", lbl: "Sincronizar",  group: "Canais",   admin: true },
];
function moreMenuHtml() {
  const groups = {};
  for (const it of NAV_EXTRA.filter(i => authRole === "admin" || !i.admin))
    (groups[it.group] = groups[it.group] || []).push(it);
  const item = (it) => `<button class="more-item${it.view === currentView ? " active" : ""}${it.view === "alertas" && navAlertCount > 0 ? " has-alert" : ""}"` +
    ` onclick="closeModal();showView('${it.view}')"><span class="ico">${it.ico}</span>${esc(it.lbl)}</button>`;
  let html = "";
  for (const [g, list] of Object.entries(groups))
    html += `<div class="more-group">${esc(g)}</div><div class="more-grid">${list.map(item).join("")}</div>`;
  html += `<div class="more-group">Conta</div><div class="more-grid">
    <button class="more-item" onclick="showUserMenu()"><span class="ico">👤</span>Minha conta</button></div>`;
  return html;
}
function openMoreMenu() {
  document.getElementById("modal-title").innerHTML = `Mais opções <button onclick="closeModal()">×</button>`;
  document.getElementById("modal-body").innerHTML = moreMenuHtml();
  document.getElementById("modal").style.display = "flex";
}

function showView(v) {
  // Sai da tela de sync: na próxima visita as URLs são buscadas de novo.
  if (v !== "sync" && calUrlsState !== "loading") calUrlsState = "idle";
  currentView = v;
  render();
  if (v === "relatorios" && authRole === "admin") loadReport(reportMonth);
  if (v === "alertas" && authRole === "admin") { loadBackupStatus(); loadPushState(); }
}
