// Service worker da PMS: só avisos (Web Push). NÃO guarda cache de nada, para a
// tela nunca ficar desatualizada. O push chega vazio; o texto vem da PMS.
"use strict";
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

const GENERIC = { title: "⚠️ Aviso da PMS", body: "Há um aviso novo. Toque para abrir." };

async function fetchMessages() {
  try {
    const sub = await self.registration.pushManager.getSubscription();
    if (!sub) return [];
    const r = await fetch("/push/inbox", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ endpoint: sub.endpoint }), cache: "no-store" });
    if (!r.ok) return [];
    const j = await r.json();
    return Array.isArray(j.messages) ? j.messages : [];
  } catch { return []; }
}

self.addEventListener("push", (event) => {
  event.waitUntil((async () => {
    const msgs = await fetchMessages();
    // O iOS exige mostrar uma notificação para todo push: sem texto, vai a genérica.
    const list = msgs.length ? msgs : [GENERIC];
    for (const m of list) {
      await self.registration.showNotification(String(m.title || GENERIC.title), {
        body: String(m.body || GENERIC.body), icon: "/icons/icon-192.png", badge: "/icons/icon-192.png",
        tag: m.at ? "pms-" + m.at : undefined, data: { url: "/" },
      });
    }
  })());
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const w of wins) { if ("focus" in w) return w.focus(); }
    return self.clients.openWindow("/");
  })());
});
