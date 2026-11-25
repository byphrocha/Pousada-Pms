// Parte do frontend da PMS (PMS-017). Carregado em ordem por index.html;
// todos os arquivos compartilham o escopo global, como o antigo script único.
// ─── Auto-save hóspede ────────────────────────────────────────────────────────
const GENERIC_NAMES = /^(reserved|blocked|closed|not available|unavailable|bloqueado|airbnb|booking)/i;

// ─── Autocomplete hóspede ─────────────────────────────────────────────────────
function showGuestSuggestions(query) {
  const box = document.getElementById("guest-suggestions");
  if (!box) return;
  const q = query.trim().toLowerCase();
  if (q.length < 2) { box.style.display="none"; return; }
  const matches = guests.filter(g =>
    g.name.toLowerCase().includes(q) ||
    (g.phone||"").includes(q)
  ).slice(0, 6);
  if (!matches.length) { box.style.display="none"; return; }
  box.innerHTML = matches.map(g => `
    <div onmousedown="fillGuestFromSuggestion('${g.id}')"
      style="padding:10px 14px;cursor:pointer;border-bottom:1px solid var(--bd);
      display:flex;align-items:center;gap:10px"
      onmouseover="this.style.background='var(--bg3)'"
      onmouseout="this.style.background=''">
      <span style="font-size:16px">👤</span>
      <div>
        <div style="font-size:13px;font-weight:600">${esc(g.name)}</div>
        <div style="font-size:10px;color:var(--mu)">${esc(g.phone||"")}${g.phone&&g.email?" · ":""}${esc(g.email||"")}</div>
      </div>
    </div>`).join("");
  box.style.display = "block";
}

function hideGuestSuggestions() {
  const box = document.getElementById("guest-suggestions");
  if (box) box.style.display = "none";
}

function fillGuestFromSuggestion(guestId) {
  const g = guests.find(x => x.id === guestId);
  if (!g) return;
  const nameEl  = document.getElementById("f-guestName");
  const phoneEl = document.getElementById("f-phone");
  const emailEl = document.getElementById("f-email");
  if (nameEl)  nameEl.value  = g.name;
  if (phoneEl) phoneEl.value = g.phone  || "";
  if (emailEl) emailEl.value = g.email  || "";
  hideGuestSuggestions();
}
async function autoSaveGuest(name, phone, email) {
  if (!name || GENERIC_NAMES.test(name.trim())) return;
  // Procura por nome exato ou telefone
  const existing = guests.find(g =>
    g.name === name || (phone && g.phone === phone)
  );
  if (existing) {
    // Atualiza phone/email se vieram preenchidos e estavam vazios
    const needsUpdate =
      (phone && !existing.phone) || (email && !existing.email);
    if (needsUpdate) {
      await api("PUT", "/guests/"+existing.id, {
        ...existing,
        phone: phone || existing.phone,
        email: email || existing.email,
      });
    }
  } else {
    // Cadastra novo hóspede
    await api("POST", "/guests", {
      id:    genId(),
      name, phone: phone||"", email: email||"",
      cpf:"", address:"", notes:"",
    });
  }
}
