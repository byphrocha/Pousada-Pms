// Parte do frontend da PMS (PMS-017). Carregado em ordem por index.html;
// todos os arquivos compartilham o escopo global, como o antigo script único.
// ─── URLs de exportação (PMS-012: nunca ficar em "Carregando…" para sempre) ───
// Estado explícito: idle → loading → ok | error. Erro sempre vira mensagem na tela.
let calUrlsState = "idle";
let calUrls = null;
let calUrlsError = null;
let calChannels = null; // PMS-010 passo 2: { airbnb: {anúncio: url}, booking: {...} }
async function loadCalUrls() {
  if (calUrlsState === "loading") return;
  calUrlsState = "loading";
  const r = await api("GET", "/calendar-urls");
  if (r && r.urls && typeof r.urls === "object") {
    calUrls = r.urls; calChannels = r.channels || null; calUrlsError = null; calUrlsState = "ok";
  } else {
    calUrls = null; calUrlsState = "error";
    if (r && r.code === "CALENDAR_TOKEN_MISSING") {
      calUrlsError = "As URLs novas (com token) ainda não estão ativas: falta a variável CALENDAR_TOKEN no Render. " +
        "As URLs que já estão cadastradas no Booking/Airbnb continuam funcionando. " +
        "Não troque nada nas plataformas agora: a troca faz parte do plano de transição (PMS-010).";
    } else {
      calUrlsError = apiErrorMessage(r) || "Não foi possível carregar as URLs de exportação.";
    }
  }
  const el = document.getElementById("cal-urls-section");
  if (el) el.innerHTML = renderCalUrls();
}

function renderCalUrls() {
  if (calUrlsState === "idle") loadCalUrls();
  if (calUrlsState === "error") {
    return `<div style="color:#f59e0b;font-size:12px;padding:8px 0;line-height:1.6">
      ⚠️ ${calUrlsError}
      <div style="margin-top:8px"><button class="btn" onclick="calUrlsState='idle';document.getElementById('cal-urls-section').innerHTML=renderCalUrls()">Tentar de novo</button></div>
    </div>`;
  }
  if (calUrlsState !== "ok" || !calUrls) {
    return `<div style="color:var(--mu);font-size:12px">Carregando URLs…</div>`;
  }
  return calUrlRowsHtml(calChannels) + calGeneralUrlsHtml(calUrls);
}

// Links gerais (todas as origens) continuam existindo para não quebrar nada já
// cadastrado (regra 3), mas ficam recolhidos: num anúncio de OTA eles devolvem
// as reservas do próprio anúncio.
function calGeneralUrlsHtml(urls) {
  const order = ["CF", "11+12", "10", "11", "12", "20", "21", "22", "23", "24", "25"];
  const rows = order.filter(id => urls[id]).map(id => `<div style="display:flex;align-items:center;gap:8px">
      <div style="width:96px;font-size:12px;font-weight:700;color:var(--bl);flex-shrink:0">${esc(CAL_PRODUCT_LABEL[id] || "Qto " + id)}</div>
      <input readonly value="${esc(urls[id])}" style="flex:1;min-width:0;background:var(--bg0);border:1px solid var(--bd);border-radius:6px;
        color:var(--dm);padding:5px 10px;font-size:10px;outline:none;font-family:var(--mono);cursor:pointer"
        onclick="this.select()" title="Clique para selecionar">
      <button class="btn" onclick="copyCalUrl('${esc(urls[id])}')">Copiar</button>
    </div>`).join("");
  if (!rows) return "";
  return `<details style="margin-top:14px"><summary style="cursor:pointer;font-size:12px;color:var(--dm)">Links gerais por quarto (todas as origens)</summary>
    <div style="font-size:12px;color:var(--dm);margin:8px 0;line-height:1.6">Para uso fora das plataformas. Não cole estes links num anúncio do Booking ou do Airbnb: eles incluem as reservas do próprio anúncio.</div>
    <div style="display:flex;flex-direction:column;gap:6px">${rows}</div></details>`;
}

// Uma linha por anúncio que existe em cada plataforma (Booking: 20, 22, 24;
// Airbnb: os anúncios cadastrados em Sincronizar). Cada link já vem sem eco e
// sem os bloqueios automáticos do Airbnb (lib/feed-export.js).
const CAL_PRODUCT_LABEL = { CF: "🏡 Casa Fechada", "11+12": "🔗 Suíte 11+12" };
function calUrlRowsHtml(channels) {
  if (!channels) return `<div style="color:var(--mu);font-size:12px">Nenhum link disponível.</div>`;
  const row = (id, url) => `<div style="display:flex;align-items:center;gap:8px">
      <div style="width:96px;font-size:12px;font-weight:700;color:var(--bl);flex-shrink:0">${esc(CAL_PRODUCT_LABEL[id] || "Quarto " + id)}</div>
      <input readonly value="${esc(url)}" style="flex:1;min-width:0;background:var(--bg0);border:1px solid var(--bd);border-radius:6px;
        color:var(--dm);padding:5px 10px;font-size:10px;outline:none;font-family:var(--mono);cursor:pointer"
        onclick="this.select()" title="Clique para selecionar">
      <button class="btn" onclick="copyCalUrl('${esc(url)}')">Copiar</button>
    </div>`;
  let s = "";
  for (const [ch, title] of [["booking", "Para colar no Booking"], ["airbnb", "Para colar no Airbnb"]]) {
    const list = Object.entries(channels[ch] || {});
    s += `<div style="font-size:13px;font-weight:700;margin:12px 0 8px">${title}</div>`;
    s += list.length ? `<div style="display:flex;flex-direction:column;gap:6px">${list.map(([id, url]) => row(id, url)).join("")}</div>`
                     : `<div style="color:var(--mu);font-size:12px">Nenhum anúncio desta plataforma cadastrado em Sincronizar.</div>`;
  }
  s += `<div style="font-size:12px;color:var(--dm);margin-top:12px;line-height:1.6">
    Cada link fecha no anúncio as datas ocupadas por <b>outros</b> canais e pelas reservas diretas.
    Ele não devolve as reservas do próprio anúncio nem os bloqueios automáticos do Airbnb.
    <b>Não troque links já cadastrados nas plataformas sem o plano de transição (PMS-010).</b>
  </div>`;
  return s;
}

function copyCalUrl(url) {
  navigator.clipboard.writeText(url).then(() => {
    alert("URL copiada!\n\n" + url);
  }).catch(() => {
    prompt("Copie a URL abaixo:", url);
  });
}

// ─── CALENDÁRIOS VIEW ─────────────────────────────────────────────────────────
function renderCalendarios() {
  const BASE = window.location.origin;
  const ROOMS_CAL = [
    {id:"10", type:"Triplo AC"},
    {id:"11", type:"Triplo Vent."},
    {id:"12", type:"Triplo Vent."},
    {id:"20", type:"Quádruplo AC"},
    {id:"21", type:"Triplo AC"},
    {id:"22", type:"Casal+1 AC"},
    {id:"23", type:"Casal+2 AC"},
    {id:"24", type:"Duplo AC"},
    {id:"25", type:"Casal+1 AC"},
  ];

  const urlFor = (roomId) => `${BASE}/calendar/${roomId}.ics`;

  const copyBtn = (url) =>
    `<button onclick="navigator.clipboard.writeText('${esc(url)}').then(()=>{this.textContent='✅ Copiado!';setTimeout(()=>this.textContent='📋 Copiar',2000)})"
      style="font-size:10px;padding:4px 10px;border-radius:6px;border:1px solid var(--bd);
      background:var(--bg3);color:var(--tx);cursor:pointer;font-family:inherit;
      white-space:nowrap;flex-shrink:0">📋 Copiar</button>`;

  let html = `
  <!-- Info -->
  <div style="background:#0f1e2b;border:1px solid #3b82f644;border-radius:12px;
    padding:16px 20px;margin-bottom:24px;line-height:1.7;font-size:13px;color:var(--dm)">
    <b style="color:var(--tx)">Como funciona:</b> Cada quarto tem uma URL iCal única.
    Você cola essa URL no Booking.com e no Airbnb — quando uma reserva direta for feita
    no PMS, as plataformas bloqueiam automaticamente aquelas datas, evitando overbooking. <br>
    <span style="color:var(--mu);font-size:11px">
      ⚠️ As URLs são públicas por padrão. Para protegê-las com token,
      adicione a variável <b>ICAL_TOKEN</b> nas variáveis de ambiente do Render.
    </span>
  </div>

  <!-- URLs por quarto -->
  <div style="font-size:13px;color:var(--mu);font-weight:700;margin-bottom:12px">
    URLs por quarto
  </div>
  <div style="display:flex;flex-direction:column;gap:8px;margin-bottom:28px">`;

  for (const r of ROOMS_CAL) {
    const url = urlFor(r.id);
    html += `
    <div style="background:var(--bg2);border:1px solid var(--bd);border-radius:10px;
      padding:10px 14px;display:flex;align-items:center;gap:12px">
      <div style="width:34px;height:34px;background:var(--bg0);border-radius:8px;
        display:flex;align-items:center;justify-content:center;font-weight:800;
        font-size:14px;color:var(--bl);flex-shrink:0">${r.id}</div>
      <div style="flex:1;min-width:0">
        <div style="font-size:11px;color:var(--mu);margin-bottom:3px">${r.type}</div>
        <div style="font-size:11px;color:var(--dm);overflow:hidden;text-overflow:ellipsis;
          white-space:nowrap">${esc(url)}</div>
      </div>
      ${copyBtn(url)}
    </div>`;
  }

  // URL "todos os quartos" — útil para bloquear tudo de uma vez (Casa Fechada)
  const urlAll = urlFor("all");
  html += `
    <div style="background:#0f2b1a;border:1px solid #22c55e44;border-radius:10px;
      padding:10px 14px;display:flex;align-items:center;gap:12px">
      <div style="width:34px;height:34px;background:var(--bg0);border-radius:8px;
        display:flex;align-items:center;justify-content:center;font-weight:800;
        font-size:12px;color:#22c55e;flex-shrink:0">ALL</div>
      <div style="flex:1;min-width:0">
        <div style="font-size:11px;color:#22c55e;margin-bottom:3px">Todos os quartos (Casa Fechada)</div>
        <div style="font-size:11px;color:var(--dm);overflow:hidden;text-overflow:ellipsis;
          white-space:nowrap">${esc(urlAll)}</div>
      </div>
      ${copyBtn(urlAll)}
    </div>
  </div>

  <!-- Passo a passo Booking -->
  <div style="font-size:13px;color:#0066cc;font-weight:700;margin-bottom:12px">
    Passo a passo no Booking.com
  </div>
  <div style="background:var(--bg2);border:1px solid #0066cc33;border-radius:12px;
    padding:18px 20px;margin-bottom:20px;font-size:13px;line-height:1.9;color:var(--dm)">
    <b style="color:var(--tx)">1.</b> Acesse a Extranet do Booking.com →
      <b style="color:var(--tx)">Calendário</b><br>
    <b style="color:var(--tx)">2.</b> No canto superior direito clique em
      <b style="color:var(--tx)">"Sincronizar calendário"</b> ou
      <b style="color:var(--tx)">"iCal"</b><br>
    <b style="color:var(--tx)">3.</b> Escolha
      <b style="color:var(--tx)">"Importar calendário externo"</b><br>
    <b style="color:var(--tx)">4.</b> Cole a URL do quarto correspondente
      (ex: quarto 24 → URL do 24)<br>
    <b style="color:var(--tx)">5.</b> Dê um nome (ex: "PMS - Qto 24") e salve<br>
    <b style="color:var(--tx)">6.</b> Repita para cada quarto que você anuncia no Booking<br>
    <div style="background:#1e2d45;border-radius:8px;padding:10px 14px;margin-top:10px;
      font-size:12px;color:var(--mu)">
      ⏱️ O Booking atualiza o calendário importado a cada
      <b style="color:var(--tx)">2 a 4 horas</b>. Uma reserva direta feita no PMS
      ficará bloqueada no Booking em até 4h.
    </div>
  </div>

  <!-- Passo a passo Airbnb -->
  <div style="font-size:13px;color:#ff5a5f;font-weight:700;margin-bottom:12px">
    Passo a passo no Airbnb
  </div>
  <div style="background:var(--bg2);border:1px solid #ff5a5f33;border-radius:12px;
    padding:18px 20px;margin-bottom:20px;font-size:13px;line-height:1.9;color:var(--dm)">
    <b style="color:var(--tx)">1.</b> Acesse o Airbnb →
      <b style="color:var(--tx)">Anúncios → Selecione o quarto → Calendário</b><br>
    <b style="color:var(--tx)">2.</b> Clique em
      <b style="color:var(--tx)">"Disponibilidade"</b> →
      <b style="color:var(--tx)">"Sincronizar calendários"</b><br>
    <b style="color:var(--tx)">3.</b> Clique em
      <b style="color:var(--tx)">"Importar calendário"</b><br>
    <b style="color:var(--tx)">4.</b> Cole a URL do quarto correspondente<br>
    <b style="color:var(--tx)">5.</b> Dê um nome (ex: "PMS - Qto 24") e salve<br>
    <b style="color:var(--tx)">6.</b> Repita para cada anúncio no Airbnb<br>
    <div style="background:#2b1e0a;border-radius:8px;padding:10px 14px;margin-top:10px;
      font-size:12px;color:var(--mu)">
      ⏱️ O Airbnb atualiza o calendário importado a cada
      <b style="color:var(--tx)">1 a 2 horas</b>. Uma reserva direta feita no PMS
      ficará bloqueada no Airbnb em até 2h.
    </div>
  </div>

  <!-- Como funciona no total -->
  <div style="font-size:13px;color:var(--mu);font-weight:700;margin-bottom:12px">
    Como o PMS evita overbooking
  </div>
  <div style="background:var(--bg2);border:1px solid var(--bd);border-radius:12px;
    padding:18px 20px;font-size:12px;line-height:2;color:var(--dm)">
    🔵 <b style="color:var(--tx)">Booking → PMS:</b>
      iCal do Booking é lido pelo PMS a cada 15min (já configurado na aba Sincronizar)<br>
    🔴 <b style="color:var(--tx)">Airbnb → PMS:</b>
      iCal do Airbnb é lido pelo PMS a cada 15min (já configurado na aba Sincronizar)<br>
    🟣 <b style="color:var(--tx)">PMS → Booking:</b>
      URL iCal do PMS importada no Booking — bloqueia datas de reservas diretas<br>
    🟣 <b style="color:var(--tx)">PMS → Airbnb:</b>
      URL iCal do PMS importada no Airbnb — bloqueia datas de reservas diretas<br>
    <div style="margin-top:10px;padding:10px 14px;background:var(--bg0);border-radius:8px;
      color:#22c55e;font-size:12px">
      ✅ Com tudo configurado: qualquer reserva em qualquer canal bloqueia automaticamente
      os outros em até 15 minutos (PMS) ou 2-4 horas (plataformas externas).
    </div>
  </div>`;

  return html;
}



function renderSync() {
  let html = `
  <!-- ── Seção: URLs de exportação do calendário ── -->
  <div style="background:var(--bg2);border:1px solid var(--bd);border-radius:12px;padding:16px 18px;margin-bottom:24px">
    <div style="font-size:12px;color:#22c55e;font-weight:700;margin-bottom:12px">
      📤 Exportar o calendário do PMS para Booking e Airbnb
    </div>
    <div style="font-size:12px;color:var(--dm);margin-bottom:14px;line-height:1.6">
      Cole estas URLs no Booking e Airbnb para que eles bloqueiem automaticamente
      as datas já reservadas no PMS (reservas diretas, etc).
    </div>
    <div id="cal-urls-section">${renderCalUrls()}</div>
  </div>

  <div class="sync-info">
    <b style="color:var(--tx)">Como usar o iCal (importar Booking/Airbnb → PMS):</b> Cole o link iCal do
    <b style="color:#0066cc">Booking.com</b> e do <b style="color:#ff5a5f">Airbnb</b> para cada quarto.
    O servidor busca as reservas e evita overbooking.<br><br>
    <b style="color:var(--tx)">Booking:</b> Extranet → Propriedade → Calendário → Exportar iCal<br>
    <b style="color:var(--tx)">Airbnb:</b> Calendário → Exportar → Copiar link
  </div>`;

  // iCal pousada toda (Airbnb)
  const cfUrl = (icalUrls["airbnb"]||{})["CF"]||"";
  html+=`<div style="margin-bottom:22px;background:#0f1e2b;border:1px solid #3b82f644;border-radius:12px;padding:14px">
    <div style="font-size:12px;color:#3b82f6;font-weight:700;margin-bottom:10px">
      🏡 Pousada toda: Casa Fechada (Airbnb)
    </div>
    <div style="display:flex;gap:10px;align-items:center">
      <div style="width:42px;color:#3b82f6;font-weight:800;font-size:12px;text-align:center;
        background:#0f1e2b;border-radius:6px;padding:4px 2px;border:1px solid #3b82f644">CF</div>
      <input style="flex:1;background:var(--bg0);border:1px solid ${cfUrl?"#3b82f655":"var(--bd)"};border-radius:8px;
        color:${cfUrl?"var(--tx)":"var(--bd)"};padding:8px 12px;font-size:11px;outline:none;font-family:inherit"
        value="${esc(cfUrl)}" placeholder="URL iCal do anúncio da pousada toda (Airbnb)"
        oninput="setIcalUrl('airbnb','CF',this.value)">
    </div>
    <div style="font-size:10px;color:var(--mu);margin-top:6px;padding-left:52px">
      Importa como Casa Fechada — bloqueia todos os ${ROOMS.length} quartos automaticamente.
    </div>
  </div>`;

  [["booking","🔵 Booking.com","#0066cc"],["airbnb","🔴 Airbnb","#ff5a5f"]].forEach(([src,label,clr])=>{
    html+=`<div style="margin-bottom:22px">
      <div style="font-size:12px;color:${clr};font-weight:700;margin-bottom:12px">${label}</div>`;

    // Airbnb: suíte 11+12 tem um único link — mostra campo combinado em vez de dois separados
    const roomsToShow = src==="airbnb"
      ? ROOMS.filter(r=>r.id!=="11"&&r.id!=="12")
      : ROOMS;

    if (src==="airbnb") {
      const val = (icalUrls["airbnb"]||{})["11+12"]||"";
      html+=`<div style="margin-bottom:10px">
        <div style="font-size:12px;color:#f59e0b;font-weight:700;margin-bottom:6px">
          🔗 Suíte 11+12 (anúncio combinado)
        </div>
        <div style="display:flex;gap:10px;align-items:center">
          <div style="width:42px;color:#f59e0b;font-weight:800;font-size:12px;text-align:center;
            background:#2b1e0a;border-radius:6px;padding:4px 2px;border:1px solid #f59e0b44">11+12</div>
          <input style="flex:1;background:var(--bg0);border:1px solid ${val?"#f59e0b55":"var(--bd)"};border-radius:8px;
            color:${val?"var(--tx)":"var(--bd)"};padding:8px 12px;font-size:11px;outline:none;font-family:inherit"
            value="${esc(val)}" placeholder="URL iCal única do anúncio Suíte 11+12 no Airbnb"
            oninput="setIcalUrl('airbnb','11+12',this.value)">
        </div>
        <div style="font-size:10px;color:var(--mu);margin-top:4px;padding-left:52px">
          Esta URL criará reservas automaticamente nos quartos 11 e 12 simultaneamente.
        </div>
      </div>
      <div style="border-top:1px solid var(--bd);margin:12px 0 10px"></div>
      <div style="font-size:12px;color:var(--mu);font-weight:700;margin-bottom:8px">Quartos individuais</div>`;
    }

    roomsToShow.forEach(r=>{
      const val = (icalUrls[src]||{})[r.id]||"";
      html+=`<div style="display:flex;gap:10px;align-items:center;margin-bottom:6px">
        <div style="width:32px;color:var(--bl);font-weight:800;font-size:14px;text-align:center">${r.id}</div>
        <input style="flex:1;background:var(--bg0);border:1px solid var(--bd);border-radius:8px;
          color:${val?"var(--tx)":"var(--bd)"};padding:8px 12px;font-size:11px;outline:none;font-family:inherit"
          value="${esc(val)}" placeholder="URL iCal — Qto ${r.id} (${r.type})"
          oninput="setIcalUrl('${src}','${r.id}',this.value)">
      </div>`;
    });
    html+=`</div>`;
  });

  if (syncHealth) {
    const okLine = syncHealth.neverRan ? "Nenhuma sincronização registrada ainda."
      : syncHealth.ok ? `✅ Última sincronização ${fmtWhen(syncHealth.lastRunAt)}: todos os calendários em dia.`
      : `⚠️ ${syncWarning()}`;
    html+=`<div style="font-size:12px;color:var(--dm);margin-bottom:12px">${esc(okLine)}</div>`;
    const echo = echoNote(syncHealth.echoes);
    if (echo) html+=`<div style="font-size:12px;color:var(--dm);margin:-4px 0 12px;line-height:1.6">${esc(echo)}</div>`;
  }
  html+=`<div style="display:flex;gap:10px;margin-bottom:16px;flex-wrap:wrap">
    <button class="btn btn-green" onclick="saveUrls()">💾 Salvar URLs</button>
    <button class="btn btn-blue" id="sync-btn" onclick="doSync()">🔄 Sincronizar Agora</button>
    <button class="btn" id="clean-btn" onclick="doCleanup()" title="Marca como cancelados os bloqueios do Airbnb que já terminaram. Nada é apagado; bloqueios atuais e futuros ficam.">🧹 Arquivar bloqueios antigos</button>
  </div>`;

  if (syncLog.length) {
    html+=`<div class="log-box" id="log-box">${syncLog.map(l=>`<div>${l}</div>`).join("")}</div>`;
  }
  html += renderFeedInventory();
  return html;
}

// ─── Quem consulta os calendários do PMS (PMS-010, passo 1) ───────────────────
// Inventário para decidir com segurança a troca de links (regra 3).
let feedInventory = null;
async function loadFeedInventory() {
  const d = await api("GET", "/calendar/inventory");
  feedInventory = d && Array.isArray(d.feeds) ? d.feeds : [];
  render();
}
// Nome de cada tipo de link no inventário. Desconhecido aparece como veio
// (nunca como "antigo", que levaria a conclusão errada na troca de links).
function feedVariantLabel(v) {
  return { legado: "🔓 antigo (sem token)", token: "🔒 geral com token",
           "canal-booking": "🔒 link do Booking", "canal-airbnb": "🔒 link do Airbnb" }[v] || String(v);
}
function renderFeedInventory() {
  const head = `<div style="margin-top:20px;font-size:13px;color:var(--mu);font-weight:700">Quem consulta os calendários do PMS</div>`;
  if (feedInventory === null)
    return `${head}<button class="btn" style="margin-top:8px" onclick="loadFeedInventory()">📋 Ver inventário de acessos</button>`;
  if (!feedInventory.length)
    return `${head}<div style="font-size:12px;color:var(--mu);margin-top:8px">Nenhum acesso registrado ainda (o registro começou com esta versão).</div>`;
  const rows = feedInventory
    .sort((a, b) => (a.variant + a.room).localeCompare(b.variant + b.room))
    .flatMap(f => Object.entries(f.agents || {}).map(([agent, a]) => `<tr>
      <td>${esc(feedVariantLabel(f.variant))}</td>
      <td>${esc(f.room === "CF" ? "Casa Fechada" : f.room)}</td><td>${esc(agent)}</td>
      <td style="text-align:right">${Number(a.count) || 0}</td>
      <td>${esc(new Date(a.lastAt).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }))}</td>
      <td>${a.lastStatus === 200 ? "ok" : esc(String(a.lastStatus))}</td></tr>`)).join("");
  return `${head}
    <div style="overflow-x:auto;margin-top:8px"><table style="width:100%;font-size:11px;border-collapse:collapse">
      <thead><tr style="color:var(--mu);text-align:left"><th>Feed</th><th>Quarto</th><th>Quem</th><th style="text-align:right">Acessos</th><th>Último</th><th>Status</th></tr></thead>
      <tbody>${rows}</tbody></table></div>
    <div style="font-size:10px;color:var(--mu);margin-top:6px">Só registra a plataforma, o quarto e a variante do link — nunca o token.</div>`;
}

function setIcalUrl(src, roomId, val) {
  if (!icalUrls[src]) icalUrls[src]={};
  icalUrls[src][roomId]=val;
}

async function saveUrls() {
  const r = await api("POST","/urls", icalUrls);
  const err = apiErrorMessage(r);
  // Antes mostrava "sucesso" mesmo quando o servidor recusava (PMS-012).
  alert(err ? `Não foi possível salvar as URLs: ${err}` : "URLs salvas com sucesso!");
}

async function doCleanup() {
  const btn = document.getElementById("clean-btn");
  if (btn) btn.disabled = true;
  syncLog = ["🧹 Arquivando bloqueios do Airbnb que já terminaram..."];
  render();
  try {
    const data = await api("POST", "/cleanup-blocked");
    if (data.ok) {
      syncLog = [`✅ ${data.cancelled} bloqueio(s) já encerrado(s) marcado(s) como cancelado(s). Nada foi apagado.`];
    } else {
      syncLog = ["✗ Erro: " + (apiErrorMessage(data) || "desconhecido")];
    }
  } catch(e) {
    syncLog = ["✗ Erro: " + e.message];
  }
  if (btn) btn.disabled = false;
  render();
  await loadAll();
}

async function doSync() {
  const btn = document.getElementById("sync-btn");
  if (btn) btn.disabled=true;
  syncLog=["⏳ Sincronizando..."];
  render();
  try {
    const data = await api("POST","/sync");
    syncLog = data.log || ["✅ Concluído"];
  } catch(e) {
    syncLog=["✗ Erro: "+e.message];
  }
  if (btn) btn.disabled=false;
  render();
  await loadAll();
  const lb = document.getElementById("log-box");
  if (lb) lb.scrollTop=lb.scrollHeight;
}
