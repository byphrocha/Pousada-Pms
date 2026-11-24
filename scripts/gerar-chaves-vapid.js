#!/usr/bin/env node
// Gera o par de chaves VAPID para os avisos no celular. Rode UMA vez e cole os
// dois valores nas variáveis do Render (VAPID_PUBLIC_KEY e VAPID_PRIVATE_KEY).
// A privada é segredo: não coloque em código, issue, chat ou log.
"use strict";
const { generateVapidKeys } = require("../lib/webpush");
const k = generateVapidKeys();
console.log("VAPID_PUBLIC_KEY=" + k.publicKey);
console.log("VAPID_PRIVATE_KEY=" + k.privateKey);
