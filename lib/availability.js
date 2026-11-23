// Regras de disponibilidade da pousada (PMS-004).
// Funções puras, sem acesso a banco ou rede: fáceis de testar e de reutilizar
// no servidor, no frontend e, no futuro, em outra linguagem.
//
// Convenção de datas: "YYYY-MM-DD" (data de negócio, sem fuso).
// Uma estadia ocupa o intervalo [check_in, check_out): a noite do check-out
// não é ocupada, então saída e entrada no mesmo dia não conflitam.
"use strict";

// Quartos físicos e capacidade nominal (mesmos valores de ROOMS em build/index.html).
const ROOMS = Object.freeze([
  { id: "10", cap: 3 }, { id: "11", cap: 3 }, { id: "12", cap: 3 },
  { id: "20", cap: 4 }, { id: "21", cap: 3 }, { id: "22", cap: 3 },
  { id: "23", cap: 4 }, { id: "24", cap: 2 }, { id: "25", cap: 3 },
]);
const ROOM_IDS = Object.freeze(ROOMS.map(r => r.id));

// Produtos compostos → quartos físicos ocupados.
const PRODUCTS = Object.freeze({
  "CF":    ROOM_IDS,
  "11+12": Object.freeze(["11", "12"]),
});

// Status que NÃO ocupam o quarto. Decisão do Paulo (23/11/2026): "pending"
// (aguardando confirmação) não bloqueia datas — só reserva confirmada ocupa.
// A mesma regra está na constraint do banco (20261123_01) e na tela.
const NON_BLOCKING_STATUSES = Object.freeze(["cancelled", "pending"]);

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** true se s é uma data de calendário real no formato YYYY-MM-DD (rejeita 2026-02-31). */
function isBusinessDate(s) {
  if (typeof s !== "string") return false;
  const m = DATE_RE.exec(s);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (y < 2000 || y > 2100) return false;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

/** Quarto físico ou produto → lista de quartos físicos; null se desconhecido. */
function resolveRooms(roomOrProduct) {
  const k = String(roomOrProduct ?? "");
  if (PRODUCTS[k]) return [...PRODUCTS[k]];
  if (ROOM_IDS.includes(k)) return [k];
  return null;
}

function isPhysicalRoom(id) {
  return ROOM_IDS.includes(String(id ?? ""));
}

/** Intervalos [aIn, aOut) e [bIn, bOut) se sobrepõem? Strings YYYY-MM-DD comparam em ordem. */
function overlaps(aIn, aOut, bIn, bOut) {
  return aIn < bOut && bIn < aOut;
}

function isBlocking(status) {
  return !NON_BLOCKING_STATUSES.includes(String(status ?? ""));
}

// Linhas importadas do Airbnb que são indisponibilidade, não reserva
// (ex.: "Airbnb (Not available)"). A tela já as esconde (isAirbnbBlock em
// build/index.html); a checagem do servidor segue a mesma regra para não
// barrar reservas diretas por bloqueios de meses. Mesma lista do frontend.
// No Booking, "CLOSED" pode ser reserva real, então não entra aqui.
const AIRBNB_BLOCK_PATTERNS = Object.freeze([
  /not available/i, /closed/i, /blocked/i, /bloqueado/i, /indispon/i, /unavailable/i,
]);
function isCalendarBlock(row) {
  return String(row?.source ?? "") === "airbnb" &&
    AIRBNB_BLOCK_PATTERNS.some(p => p.test(String(row?.guest_name ?? "")));
}

/**
 * Encontra reservas existentes que conflitam com a estadia pedida.
 * existing: linhas no formato do banco { id, room_id, check_in, check_out, status }.
 * Retorna [{ id, room_id }] — só identificadores, nunca dados do hóspede.
 */
function findConflicts(existing, { rooms, checkIn, checkOut, ignoreIds = [] }) {
  const ignore = new Set(ignoreIds.map(String));
  return (existing || [])
    .filter(r =>
      !ignore.has(String(r.id)) &&
      rooms.includes(String(r.room_id)) &&
      isBlocking(r.status) &&
      !isCalendarBlock(r) &&
      overlaps(String(r.check_in).slice(0, 10), String(r.check_out).slice(0, 10), checkIn, checkOut))
    .map(r => ({ id: r.id, room_id: String(r.room_id) }));
}

/**
 * Valida datas de uma estadia. Retorna null se ok, ou a mensagem de erro (para HTTP 400).
 */
function validateStay(checkIn, checkOut) {
  if (!isBusinessDate(checkIn) || !isBusinessDate(checkOut))
    return "checkIn e checkOut devem ser datas válidas no formato YYYY-MM-DD";
  if (checkOut <= checkIn)
    return "checkOut deve ser após checkIn";
  return null;
}

/** Corpo padrão do HTTP 409. Lista só os quartos; nada sobre o outro hóspede. */
function conflictError(rooms) {
  const uniq = [...new Set(rooms.map(String))].sort();
  return { error: { code: "ROOM_CONFLICT", message: "Quarto indisponível no período", rooms: uniq } };
}

module.exports = {
  ROOMS, ROOM_IDS, PRODUCTS, NON_BLOCKING_STATUSES,
  isBusinessDate, resolveRooms, isPhysicalRoom, overlaps, isBlocking, isCalendarBlock,
  findConflicts, validateStay, conflictError,
};
