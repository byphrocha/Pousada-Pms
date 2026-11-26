// Parte do frontend da PMS (PMS-017). Carregado em ordem por index.html;
// todos os arquivos compartilham o escopo global, como o antigo script único.
// ─── Init ─────────────────────────────────────────────────────────────────────
// Se já tem token salvo, tenta carregar direto; senão mostra login
let autoRefreshInterval = null;

function startAutoRefresh() {
  if (autoRefreshInterval) clearInterval(autoRefreshInterval);
  autoRefreshInterval = setInterval(loadAll, 5 * 60 * 1000);
}

function stopAutoRefresh() {
  if (autoRefreshInterval) { clearInterval(autoRefreshInterval); autoRefreshInterval = null; }
}

// Ao voltar para o app (iPhone em segundo plano, troca de aba), recarrega os dados
// em vez de mostrar a tela de até 5 minutos atrás. Intervalo mínimo de 30 s.
let lastVisibleRefresh = 0;
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible" || !authToken) return;
  const now = Date.now();
  if (now - lastVisibleRefresh < 30 * 1000) return;
  lastVisibleRefresh = now;
  loadAll();
});
if (authToken) {
  // Login salvo: esconde a tela de login. Antes ela ficava por cima da PMS e
  // pedia usuário e senha a cada abertura do app. Se a sessão tiver expirado,
  // a primeira chamada responde 401 e api() mostra o login de novo.
  hideLoginScreen();
  applyRole();
  loadAll().catch(() => { clearAuth(); showLoginScreen(); });
  startAutoRefresh();
} else {
  showLoginScreen();
}
