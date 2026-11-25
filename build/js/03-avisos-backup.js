// Parte do frontend da PMS (PMS-017). Carregado em ordem por index.html;
// todos os arquivos compartilham o escopo global, como o antigo script único.
// ─── AVISOS NO CELULAR (Web Push) ─────────────────────────────────────────────
// No iPhone só funciona com a PMS aberta pelo ícone da tela de início (iOS 16.4+).
let pushState = { state: "idle", enabled: false, publicKey: null, subscribed: false, error: null };
function pushSupported() {
  return typeof navigator !== "undefined" && !!navigator.serviceWorker &&
    typeof window !== "undefined" && "PushManager" in window && "Notification" in window;
}
function isStandalone() {
  try { return !!(window.matchMedia && window.matchMedia("(display-mode: standalone)").matches) || navigator.standalone === true; }
  catch { return false; }
}
async function loadPushState() {
  if (!pushSupported()) { pushState = { ...pushState, state: "unsupported" }; if (currentView === "alertas") render(); return; }
  const r = await api("GET", "/push/config");
  if (!r || r.error) { pushState = { ...pushState, state: "error", error: apiErrorMessage(r) || "não foi possível consultar" }; }
  else {
    let subscribed = false;
    try { const reg = await navigator.serviceWorker.getRegistration(); const sub = reg && await reg.pushManager.getSubscription(); subscribed = !!sub; } catch {}
    pushState = { state: "ok", enabled: !!r.enabled, publicKey: r.publicKey || null, subscribed, error: null };
  }
  if (currentView === "alertas") render();
}
function b64uToBytes(s) {
  const b = atob(String(s).replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));
  return Uint8Array.from(b, c => c.charCodeAt(0));
}
async function enablePush() {
  try {
    if (await Notification.requestPermission() !== "granted") { alert("Avisos não permitidos. Para ativar depois: Ajustes do iPhone → Notificações → Pousada."); return; }
    const reg = await navigator.serviceWorker.register("/sw.js");
    await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64uToBytes(pushState.publicKey) });
    const r = await api("POST", "/push/subscribe", { endpoint: sub.endpoint });
    if (!r || r.error) { await sub.unsubscribe().catch(() => {}); alert("Não ativou: " + (apiErrorMessage(r) || "erro")); return; }
    pushState = { ...pushState, subscribed: true };
    render();
  } catch (e) { alert("Não ativou os avisos neste aparelho (" + (e && e.message || "erro") + ")."); }
}
async function disablePush() {
  try {
    const reg = await navigator.serviceWorker.getRegistration();
    const sub = reg && await reg.pushManager.getSubscription();
    if (sub) { await api("POST", "/push/unsubscribe", { endpoint: sub.endpoint }); await sub.unsubscribe(); }
  } catch {}
  pushState = { ...pushState, subscribed: false };
  render();
}
async function testPush() {
  const r = await api("POST", "/push/test");
  if (!r || r.error) alert("Teste não enviado: " + (apiErrorMessage(r) || "erro"));
  else if (!r.sent) alert("Nenhum aparelho recebeu o teste. Desative e ative de novo os avisos.");
}
function pushCardHtml() {
  const st = pushState;
  let line, actions = "";
  if (st.state === "unsupported" || (st.state === "ok" && !isStandalone() && !st.subscribed))
    line = "Para receber avisos no iPhone, abra a PMS pelo ícone da tela de início (Compartilhar → Adicionar à Tela de Início).";
  else if (st.state === "error") line = "Não foi possível consultar os avisos (" + st.error + ").";
  else if (st.state !== "ok") line = "Consultando…";
  else if (!st.enabled) line = "Avisos ainda não configurados no servidor.";
  else if (st.subscribed) {
    line = "Ativos neste aparelho: você recebe um aviso quando um calendário trouxer uma reserva que bate com outra já na PMS.";
    actions = `<button class="btn" onclick="testPush()">Enviar teste</button><button class="btn" onclick="disablePush()">Desativar</button>`;
  } else {
    line = "Receba um aviso no celular quando surgir possível overbooking (só quarto e datas, sem dados de hóspede).";
    actions = `<button class="btn" onclick="enablePush()">Ativar avisos</button>`;
  }
  return `<div style="background:var(--bg2);border:1px solid var(--bd);border-radius:12px;padding:14px 16px;margin-bottom:20px;display:flex;gap:12px;align-items:center;flex-wrap:wrap">
    <div style="flex:1;min-width:200px"><div style="font-size:13px;font-weight:700">🔔 Avisos no celular</div>
    <div style="font-size:12px;color:var(--dm);margin-top:4px;line-height:1.5">${esc(line)}</div></div>
    <div style="display:flex;gap:8px;flex-wrap:wrap">${actions}</div></div>`;
}

// ─── BACKUP (Supabase Free não faz backup automático) ─────────────────────────
// O admin baixa um arquivo com todas as tabelas e guarda em lugar privado.
// O aviso fica amarelo depois de BACKUP_MAX_DAYS dias sem backup.
const BACKUP_MAX_DAYS = 7;
let backupStatus = { state: "idle", lastAt: null, error: null };
async function loadBackupStatus() {
  backupStatus = { ...backupStatus, state: "loading" };
  const r = await api("GET", "/admin/backup/status");
  backupStatus = r && !r.error && "lastAt" in r
    ? { state: "ok", lastAt: r.lastAt, error: null }
    : { state: "error", lastAt: null, error: apiErrorMessage(r) || "não foi possível consultar" };
  if (currentView === "alertas") render();
}
function backupAgeDays(lastAt, now = Date.now()) {
  if (!lastAt) return null;
  const t = Date.parse(lastAt);
  return Number.isFinite(t) ? Math.floor((now - t) / 86400000) : null;
}
function backupCardHtml() {
  const st = backupStatus;
  const days = backupAgeDays(st.lastAt);
  const late = st.state === "ok" && (days === null || days >= BACKUP_MAX_DAYS);
  const line = st.state === "loading" ? "Consultando…"
    : st.state === "error" ? "Não foi possível consultar a data do último backup (" + st.error + ")."
    : st.state !== "ok" ? ""
    : days === null ? "Nenhum backup feito pela PMS ainda."
    : `Último backup: ${new Date(st.lastAt).toLocaleDateString("pt-BR")} (${days === 0 ? "hoje" : days === 1 ? "ontem" : "há " + days + " dias"}).`;
  const color = late || st.state === "error" ? "#f59e0b" : "var(--dm)";
  return `<div style="background:var(--bg2);border:1px solid ${late ? "#f59e0b66" : "var(--bd)"};border-radius:12px;padding:14px 16px;margin-bottom:20px;display:flex;gap:12px;align-items:center;flex-wrap:wrap">
    <div style="flex:1;min-width:200px">
      <div style="font-size:13px;font-weight:700">💾 Backup do banco</div>
      <div style="font-size:12px;color:${color};margin-top:4px;line-height:1.5">${esc(line)}${late ? " Faça um agora." : ""}</div>
      <div style="font-size:11px;color:var(--mu);margin-top:4px;line-height:1.5">O arquivo tem dados de hóspedes: guarde fora do celular, em lugar privado. Não envie por WhatsApp nem e-mail.</div>
    </div>
    <button class="btn" id="backup-btn" onclick="downloadBackup()">Baixar backup</button>
  </div>`;
}
async function downloadBackup() {
  const btn = document.getElementById("backup-btn");
  if (btn) { btn.disabled = true; btn.textContent = "Gerando…"; }
  const r = await api("GET", "/admin/backup");
  if (!r || r.error || r.format !== "pms-backup") {
    alert("Backup não gerado: " + (apiErrorMessage(r) || "resposta inesperada") + ". Nada foi baixado.");
    if (btn) { btn.disabled = false; btn.textContent = "Baixar backup"; }
    return;
  }
  const blob = new Blob([JSON.stringify(r)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = `pms-backup-${r.createdAt.slice(0, 10)}.json`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
  await loadBackupStatus();
}
