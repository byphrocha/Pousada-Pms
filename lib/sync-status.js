// Situação das sincronizações iCal (PMS-011).
// Funções puras: resumem cada passada por calendário e dizem se os dados estão
// atrasados. Nunca guardam URL de feed nem mensagem de erro bruta (a URL leva o
// token do calendário); só categorias fixas.
"use strict";

// Sem sucesso há mais que isso → avisar na tela. O sync roda a cada 15 min
// enquanto o servidor está acordado; 60 min tolera três passadas perdidas.
const STALE_AFTER_MIN = 60;

/** Erro de um calendário → categoria curta e segura para mostrar e gravar. */
function classifyError(err) {
  const msg = String((err && err.message) || err || "");
  if (/timeout/i.test(msg)) return "tempo esgotado";
  const http = /HTTP (\d{3})/.exec(msg);
  if (http) return `HTTP ${http[1]}`;
  if (/excede/i.test(msg)) return "arquivo grande demais";
  if (/reservas|banco/i.test(msg)) return "falha ao ler o banco";
  if (/redirecionamento/i.test(msg)) return "redirecionamentos demais";
  if (/URL inv[áa]lida/i.test(msg)) return "endereço inválido";
  if (/n[ãa]o (é )?permitid/i.test(msg)) return "endereço não permitido";
  return "falha de rede";
}

/**
 * Junta o resultado de uma passada ao status anterior.
 * run.feeds: [{ key: "airbnb/21", ok: bool, problem: string|null, events: number }]
 * Calendários que não estão mais configurados saem do status.
 */
function mergeStatus(prev, run, nowIso) {
  const before = (prev && prev.feeds) || {};
  const feeds = {};
  for (const f of run.feeds || []) {
    const old = before[f.key] || {};
    feeds[f.key] = {
      lastAttemptAt: nowIso,
      lastSuccessAt: f.ok ? nowIso : (old.lastSuccessAt || null),
      problem:       f.ok ? null : (f.problem || "falha"),
      events:        f.ok ? (f.events || 0) : (old.events ?? null),
      // Reservas da plataforma recusadas por sobreposição: só quarto e datas.
      conflicts:     (f.conflicts || []).slice(0, 10).map(c => ({ room: String(c.room), checkIn: c.checkIn, checkOut: c.checkOut })),
    };
  }
  return {
    version: 1,
    lastRunAt: nowIso,
    lastRunOk: (run.feeds || []).every(f => f.ok),
    totals: {
      added: run.added || 0, updated: run.updated || 0,
      cancelled: run.cancelled || 0, failed: run.failed || 0,
    },
    feeds,
  };
}

/** Diz se é seguro confiar na disponibilidade importada. */
function computeHealth(status, nowMs, staleAfterMin = STALE_AFTER_MIN) {
  const limit = staleAfterMin * 60 * 1000;
  if (!status || !status.lastRunAt) {
    return { ok: false, neverRan: true, lastRunAt: null, failing: [], stale: [] };
  }
  const failing = [], stale = [];
  for (const [key, f] of Object.entries(status.feeds || {})) {
    if (f.problem) failing.push({ feed: key, problem: f.problem, lastSuccessAt: f.lastSuccessAt || null,
                                  conflicts: f.conflicts || [] });
    const last = f.lastSuccessAt ? Date.parse(f.lastSuccessAt) : NaN;
    if (!Number.isFinite(last) || nowMs - last > limit) stale.push({ feed: key, lastSuccessAt: f.lastSuccessAt || null });
  }
  const runAge = nowMs - Date.parse(status.lastRunAt);
  const runStale = !Number.isFinite(runAge) || runAge > limit;
  return {
    ok: failing.length === 0 && stale.length === 0 && !runStale,
    neverRan: false,
    lastRunAt: status.lastRunAt,
    runStale,
    failing,
    stale,
  };
}

module.exports = { STALE_AFTER_MIN, classifyError, mergeStatus, computeHealth };
