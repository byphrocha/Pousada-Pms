// Web Push sem biblioteca nova: o servidor manda um push VAZIO (sem conteúdo,
// portanto sem a criptografia do RFC 8291), autenticado com VAPID (RFC 8292,
// JWT ES256). Ao receber, o service worker do app busca o texto na PMS
// (POST /push/inbox com o próprio endpoint) e mostra a notificação.
"use strict";
const crypto = require("crypto");

const b64u = (buf) => Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fromB64u = (s) => Buffer.from(String(s).replace(/-/g, "+").replace(/_/g, "/"), "base64");

// Par VAPID no formato usual: pública = ponto P-256 não comprimido (65 bytes),
// privada = escalar (32 bytes), ambos em base64url.
function generateVapidKeys() {
  const ecdh = crypto.createECDH("prime256v1");
  ecdh.generateKeys();
  return { publicKey: b64u(ecdh.getPublicKey()), privateKey: b64u(ecdh.getPrivateKey()) };
}

function privateKeyObject(publicKey, privateKey) {
  const pub = fromB64u(publicKey), d = fromB64u(privateKey);
  if (pub.length !== 65 || pub[0] !== 4 || d.length !== 32) throw new Error("chaves VAPID inválidas");
  return crypto.createPrivateKey({ format: "jwk", key: {
    kty: "EC", crv: "P-256", d: b64u(d), x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33)) } });
}

// Valida o par (a pública corresponde à privada) sem enviar nada.
function vapidKeysValid(publicKey, privateKey) {
  try {
    privateKeyObject(publicKey, privateKey); // formato
    const ecdh = crypto.createECDH("prime256v1");
    ecdh.setPrivateKey(fromB64u(privateKey));
    return ecdh.getPublicKey().equals(fromB64u(publicKey)); // pública derivada da privada
  } catch { return false; }
}

// Cabeçalho Authorization do VAPID para um endpoint de push.
function vapidAuthorization(endpoint, { publicKey, privateKey, subject, now = Date.now() }) {
  const aud = new URL(endpoint).origin;
  const header = b64u(JSON.stringify({ typ: "JWT", alg: "ES256" }));
  const claims = b64u(JSON.stringify({ aud, exp: Math.floor(now / 1000) + 12 * 3600, sub: subject }));
  const sig = crypto.sign("sha256", Buffer.from(`${header}.${claims}`),
    { key: privateKeyObject(publicKey, privateKey), dsaEncoding: "ieee-p1363" });
  return `vapid t=${header}.${claims}.${b64u(sig)}, k=${publicKey}`;
}

// Endpoint aceitável: https e de um serviço de push conhecido (evita que a PMS
// seja usada para fazer requisições a endereços arbitrários).
const PUSH_HOSTS = [/\.push\.apple\.com$/, /^fcm\.googleapis\.com$/, /\.notify\.windows\.com$/,
  /^updates\.push\.services\.mozilla\.com$/, /\.push\.services\.mozilla\.com$/];
function endpointAllowed(endpoint) {
  try {
    const u = new URL(endpoint);
    return u.protocol === "https:" && PUSH_HOSTS.some(re => re.test(u.hostname));
  } catch { return false; }
}

// Envia um push vazio. Resultado: "ok", "gone" (assinatura não existe mais:
// apagar) ou "erro" (tentar de novo depois). Nunca lança.
async function sendEmptyPush(endpoint, vapid, fetchImpl = fetch) {
  if (!endpointAllowed(endpoint)) return "gone";
  try {
    const r = await fetchImpl(endpoint, { method: "POST", headers: {
      Authorization: vapidAuthorization(endpoint, vapid), TTL: "86400", Urgency: "high", "Content-Length": "0" } });
    if (r.status === 404 || r.status === 410) return "gone";
    return r.status >= 200 && r.status < 300 ? "ok" : "erro";
  } catch { return "erro"; }
}

module.exports = { b64u, fromB64u, generateVapidKeys, vapidKeysValid, vapidAuthorization, endpointAllowed, sendEmptyPush };
