// Usuários fictícios e tokens válidos para os testes de rota (PMS-015).
// O servidor confere no banco se o usuário existe, o papel e a "impressão" da
// senha; por isso o Supabase falso já traz estes usuários por padrão.
"use strict";
const jwt = require("jsonwebtoken");
const { passwordFingerprint } = require("../../lib/session");

// Hash bcrypt fictício (não corresponde a nenhuma senha usada em produção).
const FAKE_HASH = "$2a$04$abcdefghijklmnopqrstuuJ5yW6oQ8Wq9w6c0f1d3Yk7Fh2mJxW0e";

const TEST_USERS = Object.freeze([
  { id: "u1", username: "admin", role: "admin", password_hash: FAKE_HASH },
  { id: "u2", username: "staff", role: "staff", password_hash: FAKE_HASH },
]);

function tokenFor(user, extra = {}) {
  const secret = process.env.JWT_SECRET || "segredo-so-de-teste";
  return "Bearer " + jwt.sign(
    { userId: user.id, role: user.role, username: user.username, pv: passwordFingerprint(user.password_hash), ...extra },
    secret, { algorithm: "HS256" });
}

const ADMIN = () => tokenFor(TEST_USERS[0]);
const STAFF = () => tokenFor(TEST_USERS[1]);

module.exports = { TEST_USERS, FAKE_HASH, tokenFor, ADMIN, STAFF };
