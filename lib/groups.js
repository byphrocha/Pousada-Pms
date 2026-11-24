// PMS-006 (caminho escolhido em 24/11/2026: coluna de grupo). Funções puras.
// Casa Fechada e 11+12 continuam sendo uma linha por quarto físico, ligadas pela
// coluna reservations.group_id. Editar datas/status/nome/telefone/canal de uma
// linha do grupo vale para o grupo inteiro, num único UPDATE (tudo ou nada).
"use strict";

// Campos que valem para o grupo todo. Os demais (adultos, crianças, observações,
// valor, forma de pagamento) são da linha editada. Valor fica só na 1ª linha (F3).
const GROUP_FIELDS = ["check_in", "check_out", "status", "guest_name", "phone", "source"];

// Mesma regra do backfill da migration 20261124_01: CF primeiro (as linhas 11/12
// de uma CF manual também levam a marca de suíte).
function groupIdFromNotes(notes) {
  const n = String(notes ?? "");
  const cf = n.match(/\[Casa toda:([^\]]+)\]/);
  if (cf) return "cf:" + cf[1];
  const s = n.match(/\[Suíte grupo:([^\]]+)\]/);
  if (s) return "suite:" + s[1];
  return null;
}

// Importação iCal: CF já leva a marca [Casa toda:cf-<uid>] nas notas; 11+12 não
// leva marca, então o grupo vem da origem + UID do evento (igual ao backfill).
function groupIdForImport(source, feedRoomId, uid) {
  if (!uid) return null;
  if (feedRoomId === "CF") return "cf:cf-" + uid;
  if (feedRoomId === "11+12") return `suite:ical-${source}-${uid}`;
  return null;
}

function splitGroupUpdate(row) {
  const group = {}, own = {};
  for (const [k, v] of Object.entries(row || {})) (GROUP_FIELDS.includes(k) ? group : own)[k] = v;
  return { group, own };
}

module.exports = { GROUP_FIELDS, groupIdFromNotes, groupIdForImport, splitGroupUpdate };
