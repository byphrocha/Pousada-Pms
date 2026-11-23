// Sessões (PMS-015). Sem mudança de esquema: o token leva uma "impressão" curta
// do hash de senha atual; trocar a senha muda a impressão e invalida todos os
// tokens antigos. A impressão é um SHA-256 truncado do hash bcrypt (que já tem
// sal): não ajuda a descobrir a senha.
"use strict";
const crypto = require("crypto");

function passwordFingerprint(passwordHash) {
  return crypto.createHash("sha256").update(String(passwordHash || "")).digest("base64url").slice(0, 16);
}

/** Cache curto de usuários por id, para não consultar o banco a cada pedido. */
function createSessionCache(ttlMs = 60 * 1000) {
  const map = new Map();
  return {
    get(id) {
      const hit = map.get(id);
      if (!hit) return undefined;
      if (Date.now() - hit.at > ttlMs) { map.delete(id); return undefined; }
      return hit.user;
    },
    set(id, user) { map.set(id, { at: Date.now(), user }); },
    delete(id) { map.delete(id); },
    clear() { map.clear(); },
  };
}

module.exports = { passwordFingerprint, createSessionCache };
