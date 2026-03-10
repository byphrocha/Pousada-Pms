// PMS - Property Management System
// Pousada · 9 Quartos
import { useState, useEffect, useCallback } from "react";

// ─── Rooms ──────────────────────────────────────────────────────────────────────
const ROOMS = [
  { id: "10", type: "Triplo",          climate: "AC",         capacity: 3 },
  { id: "11", type: "Triplo",          climate: "Ventilador", capacity: 3 },
  { id: "12", type: "Triplo",          climate: "Ventilador", capacity: 3 },
  { id: "20", type: "Quádruplo",       climate: "AC",         capacity: 4 },
  { id: "21", type: "Triplo",          climate: "AC",         capacity: 3 },
  { id: "22", type: "Casal + 1 Soltr", climate: "AC",         capacity: 3 },
  { id: "23", type: "Casal + 2 Soltr", climate: "AC",         capacity: 4 },
  { id: "24", type: "Duplo",           climate: "AC",         capacity: 2 },
  { id: "25", type: "Casal + 1 Soltr", climate: "AC",         capacity: 3 },
];

// ─── Utils ──────────────────────────────────────────────────────────────────────
const todayStr = () => new Date().toISOString().split("T")[0];
const fmtDate  = (s) => s ? new Date(s + "T12:00:00").toLocaleDateString("pt-BR") : "—";
const genId    = () => Math.random().toString(36).slice(2, 10);
const nights   = (ci, co) => Math.max(0, Math.round((new Date(co) - new Date(ci)) / 86400000));

function getRoomStatus(roomId, reservations) {
  const t = todayStr();
  for (const r of reservations) {
    if (r.roomId !== roomId || r.status === "cancelled") continue;
    if (r.checkIn  === t) return "checkin";
    if (r.checkOut === t) return "checkout";
    if (r.checkIn < t && r.checkOut > t) return "occupied";
  }
  return "free";
}

function getRoomReservation(roomId, reservations) {
  const t = todayStr();
  return reservations.find(r =>
    r.roomId === roomId &&
    r.status !== "cancelled" &&
    r.checkIn <= t && r.checkOut > t
  );
}

function parseIcal(text) {
  const events = [];
  const blocks  = text.split("BEGIN:VEVENT");
  const parseIcalDate = (s) => {
    const c = s.replace(/[TZ]/g, "").slice(0, 8);
    return `${c.slice(0,4)}-${c.slice(4,6)}-${c.slice(6,8)}`;
  };
  for (let i = 1; i < blocks.length; i++) {
    const b   = blocks[i];
    const get = (k) => { const m = b.match(new RegExp(k + "[^:]*:([^\r\n]+)")); return m ? m[1].trim() : ""; };
    const dtstart = get("DTSTART"), dtend = get("DTEND"), summary = get("SUMMARY"), uid = get("UID");
    if (dtstart && dtend) events.push({ uid, summary, checkIn: parseIcalDate(dtstart), checkOut: parseIcalDate(dtend) });
  }
  return events;
}

// ─── Storage ────────────────────────────────────────────────────────────────────
async function loadData(key) {
  try { const r = await window.storage.get(key); return r ? JSON.parse(r.value) : null; }
  catch { return null; }
}
async function saveData(key, val) {
  try { await window.storage.set(key, JSON.stringify(val)); } catch {}
}

// ─── Design tokens ──────────────────────────────────────────────────────────────
const C = {
  bg0: "#070b14", bg1: "#0d1221", bg2: "#131929", bg3: "#1b2234",
  border: "#1e2d45", borderHov: "#2d4268",
  text: "#d9e4f5", muted: "#5a7090", dim: "#8898b4",
  free:    "#22c55e", freeD: "#0f2b1a",
  occ:     "#ef4444", occD:  "#2b0f0f",
  cin:     "#3b82f6", cinD:  "#0f1e2b",
  cout:    "#f59e0b", coutD: "#2b1e0a",
  booking: "#0066cc", airbnb: "#ff5a5f", direto: "#8b5cf6",
  green: "#166534", greenHov: "#15803d",
};

const STATUS_CFG = {
  free:    { label: "Livre",      color: C.free,  bg: C.freeD, icon: "🟢" },
  occupied:{ label: "Ocupado",    color: C.occ,   bg: C.occD,  icon: "🔴" },
  checkin: { label: "Check-in",   color: C.cin,   bg: C.cinD,  icon: "🔵" },
  checkout:{ label: "Check-out",  color: C.cout,  bg: C.coutD, icon: "🟡" },
};

const SOURCE_COLOR = { direto: C.direto, booking: C.booking, airbnb: C.airbnb };

// ─── Tiny UI primitives ──────────────────────────────────────────────────────────
const inp = {
  boxSizing:"border-box", width:"100%", background:C.bg0, border:`1px solid ${C.border}`,
  borderRadius:8, color:C.text, padding:"9px 12px", fontSize:13, outline:"none",
  fontFamily:"inherit",
};
const btn = (bg="#1b2234", full=false) => ({
  background:bg, border:`1px solid ${bg === "#1b2234" ? C.border : bg}`, color:"#fff",
  padding:"9px 18px", borderRadius:8, cursor:"pointer", fontSize:13, fontWeight:600,
  fontFamily:"inherit", width: full ? "100%" : undefined, transition:"opacity .15s",
});

function Field({ label, children, half }) {
  return (
    <div style={{ marginBottom:12, flex: half ? "0 0 calc(50% - 6px)" : "1 1 100%" }}>
      <label style={{ display:"block", fontSize:10, color:C.muted, marginBottom:4,
        fontWeight:700, letterSpacing:".08em", textTransform:"uppercase" }}>{label}</label>
      {children}
    </div>
  );
}

function Modal({ title, onClose, children, wide }) {
  return (
    <div style={{ position:"fixed", inset:0, background:"rgba(0,0,0,.75)", zIndex:1000,
      display:"flex", alignItems:"center", justifyContent:"center", padding:16 }}
      onClick={onClose}>
      <div style={{ background:C.bg1, border:`1px solid ${C.border}`, borderRadius:16,
        padding:28, width:"100%", maxWidth: wide ? 700 : 520, maxHeight:"92vh", overflowY:"auto" }}
        onClick={e => e.stopPropagation()}>
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:22 }}>
          <h2 style={{ margin:0, color:C.text, fontSize:17, fontFamily:"'Georgia', serif" }}>{title}</h2>
          <button onClick={onClose} style={{ background:"none", border:"none", color:C.muted,
            cursor:"pointer", fontSize:24, lineHeight:1, padding:"0 4px" }}>×</button>
        </div>
        {children}
      </div>
    </div>
  );
}

function Pill({ color, children }) {
  return (
    <span style={{ fontSize:10, padding:"2px 9px", borderRadius:99,
      background: color + "28", color, fontWeight:700, letterSpacing:".04em" }}>
      {children}
    </span>
  );
}

// ─── Room Card ───────────────────────────────────────────────────────────────────
function RoomCard({ room, status, reservation, onClick }) {
  const s = STATUS_CFG[status];
  return (
    <div onClick={onClick} style={{
      background: s.bg, border:`1.5px solid ${s.color}44`, borderRadius:12,
      padding:"14px 8px", cursor:"pointer", display:"flex", flexDirection:"column",
      alignItems:"center", gap:5, position:"relative", transition:"transform .18s, box-shadow .18s",
      userSelect:"none",
    }}
    onMouseEnter={e => { e.currentTarget.style.transform="translateY(-3px)"; e.currentTarget.style.boxShadow=`0 8px 24px ${s.color}22`; }}
    onMouseLeave={e => { e.currentTarget.style.transform="translateY(0)";   e.currentTarget.style.boxShadow="none"; }}>
      <div style={{ position:"absolute", top:7, right:8, width:7, height:7,
        borderRadius:"50%", background:s.color, boxShadow:`0 0 6px ${s.color}` }} />
      <div style={{ fontSize:20, fontWeight:900, color:s.color, fontFamily:"'Courier New', monospace", lineHeight:1 }}>
        {room.id}
      </div>
      <div style={{ fontSize:26 }}>
        {status === "free" ? "🚪" : status === "checkin" ? "🔓" : status === "checkout" ? "🧹" : "🔒"}
      </div>
      <div style={{ fontSize:9, color:s.color, opacity:.85, textAlign:"center", lineHeight:1.3, fontWeight:600 }}>
        {room.type}
      </div>
      <div style={{ fontSize:9, background:"rgba(255,255,255,.07)", padding:"2px 7px",
        borderRadius:99, color:s.color }}>
        {room.climate === "AC" ? "❄ AC" : "💨 Vent."}
      </div>
      {reservation && status !== "free" && (
        <div style={{ fontSize:8, color:s.color, opacity:.75, textAlign:"center",
          maxWidth:78, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>
          {reservation.guestName}
        </div>
      )}
    </div>
  );
}

// ─── Reservation Form ─────────────────────────────────────────────────────────────
function ReservationForm({ rooms, initial, onSave, onCancel, onClose }) {
  const [form, setForm] = useState({
    roomId: rooms[0].id, guestName:"", checkIn:todayStr(), checkOut:"",
    source:"direto", adults:2, children:0, phone:"", notes:"", status:"confirmed",
    ...(initial || {}),
  });
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));
  const valid = form.guestName.trim() && form.checkIn && form.checkOut && form.checkOut > form.checkIn;
  const n = form.checkIn && form.checkOut ? nights(form.checkIn, form.checkOut) : 0;
  return (
    <div>
      <div style={{ display:"flex", flexWrap:"wrap", gap:12 }}>
        <Field label="Quarto" half>
          <select value={form.roomId} onChange={e => set("roomId", e.target.value)} style={inp}>
            {rooms.map(r => <option key={r.id} value={r.id}>{r.id} – {r.type}</option>)}
          </select>
        </Field>
        <Field label="Canal" half>
          <select value={form.source} onChange={e => set("source", e.target.value)} style={inp}>
            <option value="direto">Direto</option>
            <option value="booking">Booking.com</option>
            <option value="airbnb">Airbnb</option>
          </select>
        </Field>
      </div>
      <Field label="Nome do Hóspede">
        <input value={form.guestName} onChange={e => set("guestName", e.target.value)}
          style={inp} placeholder="Nome completo" autoFocus />
      </Field>
      <div style={{ display:"flex", flexWrap:"wrap", gap:12 }}>
        <Field label="Check-in" half>
          <input type="date" value={form.checkIn} onChange={e => set("checkIn", e.target.value)} style={inp} />
        </Field>
        <Field label="Check-out" half>
          <input type="date" value={form.checkOut} onChange={e => set("checkOut", e.target.value)} style={inp} />
        </Field>
        <Field label="Adultos" half>
          <input type="number" value={form.adults} onChange={e => set("adults", +e.target.value)} style={inp} min={1} max={6} />
        </Field>
        <Field label="Crianças" half>
          <input type="number" value={form.children} onChange={e => set("children", +e.target.value)} style={inp} min={0} max={4} />
        </Field>
      </div>
      <Field label="Telefone / WhatsApp">
        <input value={form.phone} onChange={e => set("phone", e.target.value)} style={inp} placeholder="(44) 99999-9999" />
      </Field>
      <Field label="Observações">
        <textarea value={form.notes} onChange={e => set("notes", e.target.value)}
          style={{ ...inp, height:64, resize:"vertical" }} />
      </Field>
      {n > 0 && (
        <div style={{ fontSize:12, color:C.dim, marginBottom:16 }}>
          📅 {fmtDate(form.checkIn)} → {fmtDate(form.checkOut)} · <b style={{ color:C.text }}>{n} noite{n!==1?"s":""}</b>
        </div>
      )}
      <div style={{ display:"flex", gap:10, justifyContent:"flex-end" }}>
        {onCancel && (
          <button style={btn("#4a1010")} onClick={onCancel}>Cancelar Reserva</button>
        )}
        <button style={{ ...btn(valid ? "#166534" : C.bg3), opacity: valid ? 1 : .5 }}
          onClick={() => valid && onSave(form)} disabled={!valid}>
          {initial?.id ? "Salvar Alterações" : "Criar Reserva"}
        </button>
      </div>
    </div>
  );
}

// ─── Map View ────────────────────────────────────────────────────────────────────
function RoomMapView({ rooms, reservations, onRoomClick, onNew }) {
  const t = todayStr();
  const occupied  = reservations.filter(r => r.status!=="cancelled" && r.checkIn<=t && r.checkOut>t);
  const checkins  = reservations.filter(r => r.checkIn===t  && r.status!=="cancelled");
  const checkouts = reservations.filter(r => r.checkOut===t && r.status!=="cancelled");
  const free      = rooms.length - occupied.length;

  return (
    <div>
      {/* KPI row */}
      <div style={{ display:"grid", gridTemplateColumns:"repeat(4,1fr)", gap:12, marginBottom:24 }}>
        {[
          ["Ocupados",    occupied.length,  C.occ],
          ["Check-ins",   checkins.length,  C.cin],
          ["Check-outs",  checkouts.length, C.cout],
          ["Disponíveis", free,             C.free],
        ].map(([l,v,c]) => (
          <div key={l} style={{ background:C.bg2, border:`1px solid ${C.border}`, borderRadius:12, padding:"14px 16px", textAlign:"center" }}>
            <div style={{ fontSize:30, fontWeight:900, color:c, fontFamily:"monospace", lineHeight:1 }}>{v}</div>
            <div style={{ fontSize:10, color:C.muted, marginTop:4, fontWeight:600, letterSpacing:".06em" }}>{l.toUpperCase()}</div>
          </div>
        ))}
      </div>

      {/* Legend */}
      <div style={{ display:"flex", gap:18, marginBottom:18, flexWrap:"wrap" }}>
        {Object.entries(STATUS_CFG).map(([k,v]) => (
          <div key={k} style={{ display:"flex", alignItems:"center", gap:6 }}>
            <div style={{ width:9, height:9, borderRadius:"50%", background:v.color, boxShadow:`0 0 5px ${v.color}` }} />
            <span style={{ fontSize:11, color:C.muted }}>{v.label}</span>
          </div>
        ))}
      </div>

      {/* Room Grid */}
      <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fill, minmax(96px,1fr))", gap:12 }}>
        {rooms.map(room => (
          <RoomCard
            key={room.id}
            room={room}
            status={getRoomStatus(room.id, reservations)}
            reservation={getRoomReservation(room.id, reservations)}
            onClick={() => onRoomClick(room)}
          />
        ))}
      </div>

      {/* Today schedule */}
      {(checkins.length > 0 || checkouts.length > 0) && (
        <div style={{ marginTop:28, borderTop:`1px solid ${C.border}`, paddingTop:22 }}>
          <div style={{ fontSize:11, color:C.muted, fontWeight:700, letterSpacing:".1em", marginBottom:14 }}>
            AGENDA HOJE — {new Date().toLocaleDateString("pt-BR",{weekday:"long",day:"numeric",month:"long"})}
          </div>
          <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:14 }}>
            {[["CHECK-INS", checkins, C.cin, C.cinD], ["CHECK-OUTS", checkouts, C.cout, C.coutD]].map(([lbl, list, clr, bg]) => (
              <div key={lbl}>
                <div style={{ fontSize:10, color:clr, fontWeight:700, letterSpacing:".1em", marginBottom:8 }}>{lbl}</div>
                {list.length === 0
                  ? <div style={{ color:C.border, fontSize:13 }}>Nenhum hoje</div>
                  : list.map(r => (
                    <div key={r.id} onClick={() => onRoomClick(rooms.find(rm=>rm.id===r.roomId))}
                      style={{ background:bg, border:`1px solid ${clr}44`, borderRadius:8, padding:"9px 12px",
                        marginBottom:6, cursor:"pointer", display:"flex", alignItems:"center", gap:10 }}>
                      <span style={{ color:clr, fontWeight:800, fontFamily:"monospace", fontSize:15 }}>{r.roomId}</span>
                      <div>
                        <div style={{ color:C.text, fontSize:13, fontWeight:600 }}>{r.guestName}</div>
                        <div style={{ color:C.muted, fontSize:10 }}>{r.adults}ad {r.children>0?`+ ${r.children}cr`:""} · <Pill color={SOURCE_COLOR[r.source]||C.muted}>{r.source}</Pill></div>
                      </div>
                    </div>
                  ))
                }
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Reservations View ───────────────────────────────────────────────────────────
function ReservasView({ rooms, reservations, onEdit, onNew }) {
  const [filter, setFilter] = useState("upcoming");
  const [search, setSearch]  = useState("");
  const t = todayStr();

  const list = reservations
    .filter(r => {
      if (filter === "upcoming") return r.checkIn >= t && r.status !== "cancelled";
      if (filter === "active")   return r.checkIn <= t && r.checkOut > t && r.status !== "cancelled";
      if (filter === "past")     return r.checkOut < t && r.status !== "cancelled";
      if (filter === "all")      return true;
      return true;
    })
    .filter(r => !search || r.guestName.toLowerCase().includes(search.toLowerCase()) || r.roomId.includes(search))
    .sort((a,b) => a.checkIn.localeCompare(b.checkIn));

  return (
    <div>
      <div style={{ display:"flex", gap:10, marginBottom:18, alignItems:"center", flexWrap:"wrap" }}>
        <input value={search} onChange={e => setSearch(e.target.value)}
          placeholder="🔍  Buscar hóspede ou quarto..." style={{ ...inp, maxWidth:230 }} />
        <div style={{ display:"flex", gap:6 }}>
          {[["upcoming","Futuras"],["active","Ativas"],["past","Passadas"],["all","Todas"]].map(([v,l]) => (
            <button key={v} onClick={() => setFilter(v)} style={{
              ...btn(filter===v ? "#1e3a5f" : C.bg2), padding:"8px 14px", fontSize:11,
              borderColor: filter===v ? C.cin : C.border, color: filter===v ? C.cin : C.muted,
            }}>{l}</button>
          ))}
        </div>
        <button onClick={onNew} style={{ ...btn("#166534"), marginLeft:"auto" }}>+ Nova Reserva</button>
      </div>

      {list.length === 0 && (
        <div style={{ textAlign:"center", color:C.border, padding:48, fontSize:15 }}>Nenhuma reserva encontrada</div>
      )}

      {list.map(r => {
        const room = rooms.find(rm => rm.id === r.roomId);
        const n = nights(r.checkIn, r.checkOut);
        const cancelled = r.status === "cancelled";
        return (
          <div key={r.id} onClick={() => onEdit(r)}
            style={{ background:C.bg2, border:`1px solid ${C.border}`, borderRadius:10,
              padding:"13px 16px", cursor:"pointer", display:"flex", alignItems:"center",
              gap:14, marginBottom:8, opacity: cancelled ? .45 : 1, transition:"border-color .15s" }}
            onMouseEnter={e => e.currentTarget.style.borderColor = C.borderHov}
            onMouseLeave={e => e.currentTarget.style.borderColor = C.border}>
            <div style={{ width:46, height:46, borderRadius:10, background:C.bg0,
              display:"flex", alignItems:"center", justifyContent:"center",
              fontSize:17, fontWeight:900, color:C.cin, fontFamily:"monospace", flexShrink:0 }}>
              {r.roomId}
            </div>
            <div style={{ flex:1, minWidth:0 }}>
              <div style={{ fontWeight:700, color:C.text, fontSize:14 }}>{r.guestName}</div>
              <div style={{ fontSize:11, color:C.muted, marginTop:3 }}>
                {room?.type} · {fmtDate(r.checkIn)} → {fmtDate(r.checkOut)} · <b style={{ color:C.dim }}>{n} noite{n!==1?"s":""}</b>
                {r.phone && ` · ${r.phone}`}
              </div>
            </div>
            <div style={{ display:"flex", gap:7, alignItems:"center", flexShrink:0 }}>
              <Pill color={SOURCE_COLOR[r.source]||C.muted}>{r.source}</Pill>
              {cancelled && <Pill color={C.occ}>cancelado</Pill>}
              <span style={{ color:C.border, fontSize:20 }}>›</span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ─── Generate iCal string from reservations ─────────────────────────────────────
function generateIcal(reservations, rooms) {
  const fmt = (d) => d.replace(/-/g,"");
  const esc = (s) => (s||"").replace(/[\n\r]/g," ");
  let lines = [
    "BEGIN:VCALENDAR","VERSION:2.0",
    "PRODID:-//Pousada PMS//PT","CALSCALE:GREGORIAN","METHOD:PUBLISH",
  ];
  reservations.filter(r => r.status !== "cancelled").forEach(r => {
    const room = rooms.find(rm => rm.id === r.roomId);
    lines.push("BEGIN:VEVENT");
    lines.push(`UID:pms-${r.id}@pousada`);
    lines.push(`DTSTART;VALUE=DATE:${fmt(r.checkIn)}`);
    lines.push(`DTEND;VALUE=DATE:${fmt(r.checkOut)}`);
    lines.push(`SUMMARY:${esc(r.guestName)} – Qto ${r.roomId}`);
    lines.push(`DESCRIPTION:${esc(room?.type||"")} · ${r.source} · ${r.adults}ad${r.children?` ${r.children}cr`:""}`);
    lines.push(`STATUS:CONFIRMED`);
    lines.push("END:VEVENT");
  });
  lines.push("END:VCALENDAR");
  return lines.join("\r\n");
}

function downloadIcal(content, filename) {
  const blob = new Blob([content], { type:"text/calendar;charset=utf-8" });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement("a");
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

// ─── Generate iCal ───────────────────────────────────────────────────────────
function generateIcal(reservations, rooms) {
  const fmt = (d) => d.replace(/-/g,"");
  const esc = (s) => (s||"").replace(/[\n\r]/g," ");
  let lines = ["BEGIN:VCALENDAR","VERSION:2.0","PRODID:-//Pousada PMS//PT","CALSCALE:GREGORIAN","METHOD:PUBLISH"];
  reservations.filter(r => r.status !== "cancelled").forEach(r => {
    const room = rooms.find(rm => rm.id === r.roomId);
    lines.push("BEGIN:VEVENT",`UID:pms-${r.id}@pousada`,
      `DTSTART;VALUE=DATE:${fmt(r.checkIn)}`,`DTEND;VALUE=DATE:${fmt(r.checkOut)}`,
      `SUMMARY:${esc(r.guestName)} – Qto ${r.roomId}`,
      `DESCRIPTION:${esc(room?.type||"")} · ${r.source}`,`STATUS:CONFIRMED`,"END:VEVENT");
  });
  lines.push("END:VCALENDAR");
  return lines.join("\r\n");
}

function downloadIcal(content, filename) {
  const blob = new Blob([content], { type:"text/calendar;charset=utf-8" });
  const a    = document.createElement("a");
  a.href = URL.createObjectURL(blob); a.download = filename; a.click();
}

// ─── Sync View ────────────────────────────────────────────────────────────────
function SyncView({ reservations, serverUrl, onServerUrlChange, syncLog, setSyncLog }) {
  const [tab,        setTab]        = useState("server");
  const [urlDraft,   setUrlDraft]   = useState(serverUrl || "");
  const [fileRoom,   setFileRoom]   = useState(ROOMS[0].id);
  const [fileSrc,    setFileSrc]    = useState("booking");
  const [icalUrls,   setIcalUrls]   = useState({ booking:{}, airbnb:{} });
  const [dragging,   setDragging]   = useState(false);
  const [syncing,    setSyncing]    = useState(false);
  const fileRef = React.useRef();

  // Load iCal URLs from server
  useEffect(() => {
    if (!serverUrl) return;
    fetch(`${serverUrl}/urls`).then(r=>r.json()).then(setIcalUrls).catch(()=>{});
  }, [serverUrl]);

  const log = (msgs) => setSyncLog(Array.isArray(msgs) ? msgs : l => [...l, msgs]);

  // Save URLs to server + trigger sync
  const handleServerSync = async () => {
    if (!serverUrl) return;
    setSyncing(true); log([`🔄 Enviando URLs e sincronizando...`]);
    try {
      await fetch(`${serverUrl}/urls`, { method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify(icalUrls) });
      const res  = await fetch(`${serverUrl}/sync`, { method:"POST" });
      const data = await res.json();
      log(data.log || ["✅ Sincronização concluída!"]);
    } catch(e) { log([`✗ Erro: ${e.message}`]); }
    setSyncing(false);
  };

  // File upload → send to server
  const handleFile = (file) => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async (e) => {
      const text = e.target.result;
      log([`📂 Processando ${file.name}...`]);
      if (!text.includes("BEGIN:VCALENDAR")) { log(["✗ Arquivo inválido"]); return; }
      const evts = parseIcal(text);
      log([`   → ${evts.length} evento(s) encontrado(s)`]);
      // If server connected, send there; else import locally
      if (serverUrl) {
        for (const ev of evts) {
          const uid = `${fileSrc}-${fileRoom}-${ev.uid}`;
          await fetch(`${serverUrl}/reservations`, {
            method:"POST", headers:{"Content-Type":"application/json"},
            body:JSON.stringify({
              roomId:fileRoom, externalUid:uid, status:"confirmed",
              guestName:ev.summary||"Reserva", checkIn:ev.checkIn, checkOut:ev.checkOut,
              source:fileSrc, adults:2, children:0, phone:"",
              notes:`Importado de ${file.name}`, createdAt:new Date().toISOString(),
            })
          }).catch(()=>{});
          log([`   ✓ ${ev.summary} (${ev.checkIn} → ${ev.checkOut})`]);
        }
        log(["✅ Importação concluída!"]);
      } else {
        // fallback: store locally via window event
        window.dispatchEvent(new CustomEvent("pms:import", { detail:{ evts, roomId:fileRoom, source:fileSrc, filename:file.name } }));
        log(["✅ Importado localmente (sem servidor)"]);
      }
    };
    reader.readAsText(file);
  };

  const tabStyle = (t) => ({
    padding:"9px 18px", border:`1px solid ${C.border}`,
    borderBottom: tab===t ? `1px solid ${C.bg2}` : `1px solid ${C.border}`,
    background: tab===t ? C.bg2 : C.bg1, color: tab===t ? C.text : C.muted,
    cursor:"pointer", fontSize:12, fontWeight:700, fontFamily:"inherit",
    marginBottom:-1, position:"relative", zIndex: tab===t ? 1 : 0,
    borderRadius:"8px 8px 0 0",
  });

  const connected = !!serverUrl;

  return (
    <div>
      {/* Connection status banner */}
      <div style={{ display:"flex", alignItems:"center", gap:12, padding:"12px 16px",
        borderRadius:10, marginBottom:20, border:`1px solid ${connected ? C.free+"55" : C.cout+"55"}`,
        background: connected ? C.freeD : C.coutD }}>
        <div style={{ width:10, height:10, borderRadius:"50%", flexShrink:0,
          background: connected ? C.free : C.cout,
          boxShadow:`0 0 8px ${connected ? C.free : C.cout}` }} />
        <div style={{ flex:1 }}>
          <div style={{ fontSize:13, fontWeight:700, color: connected ? C.free : C.cout }}>
            {connected ? "✅ Servidor conectado" : "⚠️ Sem servidor — modo offline"}
          </div>
          <div style={{ fontSize:11, color:C.muted, marginTop:2 }}>
            {connected ? serverUrl : "Configure o servidor na aba abaixo para sincronização automática a cada hora"}
          </div>
        </div>
        {connected && (
          <button onClick={handleServerSync} disabled={syncing}
            style={{ ...btn("#1e3a5f"), fontSize:11, opacity:syncing?.6:1, flexShrink:0 }}>
            {syncing ? "⏳..." : "🔄 Sincronizar"}
          </button>
        )}
      </div>

      {/* Tabs */}
      <div style={{ display:"flex" }}>
        <button style={tabStyle("server")} onClick={() => setTab("server")}>🖥 Servidor</button>
        <button style={tabStyle("urls")}   onClick={() => setTab("urls")}>🔗 URLs iCal</button>
        <button style={tabStyle("file")}   onClick={() => setTab("file")}>📁 Upload .ics</button>
        <button style={tabStyle("export")} onClick={() => setTab("export")}>📤 Exportar</button>
      </div>

      <div style={{ background:C.bg2, border:`1px solid ${C.border}`, borderRadius:"0 12px 12px 12px", padding:22 }}>

        {/* SERVER SETUP TAB */}
        {tab === "server" && (
          <div>
            <div style={{ fontSize:13, color:C.text, fontWeight:700, marginBottom:16 }}>
              Configure o servidor de sincronização automática
            </div>

            {/* Step by step */}
            <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:12, marginBottom:22 }}>
              {[
                ["1️⃣", "Crie conta no Railway", "railway.app → Login com GitHub (grátis)", "#1e3a5f"],
                ["2️⃣", "Crie novo projeto", "New Project → Deploy from GitHub repo", "#1e2b1e"],
                ["3️⃣", "Faça upload dos arquivos", "Envie a pasta pousada-server para um repositório GitHub", "#2b1e0a"],
                ["4️⃣", "Copie a URL pública", "Settings → Networking → Generate Domain", "#1e1a2b"],
              ].map(([n,t,d,bg]) => (
                <div key={n} style={{ background:bg, border:`1px solid ${C.border}`, borderRadius:10, padding:14 }}>
                  <div style={{ fontSize:20, marginBottom:6 }}>{n}</div>
                  <div style={{ fontSize:12, color:C.text, fontWeight:700, marginBottom:3 }}>{t}</div>
                  <div style={{ fontSize:11, color:C.muted, lineHeight:1.5 }}>{d}</div>
                </div>
              ))}
            </div>

            <div style={{ background:"#0a1200", border:"1px solid #2a3800", borderRadius:10, padding:14, marginBottom:18, fontSize:12, color:"#a3e635", lineHeight:1.8 }}>
              <b>💡 Custo:</b> Railway oferece <b>$5 de crédito/mês grátis</b> — suficiente para este servidor rodar 24h/7dias sem pagar nada.
            </div>

            <div style={{ marginBottom:6, fontSize:11, color:C.muted, fontWeight:700, letterSpacing:".08em" }}>URL DO SEU SERVIDOR</div>
            <div style={{ display:"flex", gap:10 }}>
              <input value={urlDraft} onChange={e => setUrlDraft(e.target.value)}
                placeholder="https://pousada-pms-server.up.railway.app"
                style={{ ...inp, flex:1 }} />
              <button style={btn("#166534")} onClick={() => {
                const url = urlDraft.replace(/\/$/, "");
                onServerUrlChange(url);
                log([`🔌 Testando conexão com ${url}...`]);
                fetch(`${url}/`).then(r=>r.json()).then(d => {
                  log([`✅ Servidor online! ${d.reservas} reserva(s) no servidor.`]);
                }).catch(() => log(["✗ Não foi possível conectar. Verifique a URL."]));
              }}>Conectar</button>
            </div>
          </div>
        )}

        {/* ICAL URLS TAB */}
        {tab === "urls" && (
          <div>
            <div style={{ fontSize:12, color:C.dim, lineHeight:1.7, marginBottom:16 }}>
              {connected
                ? "URLs salvas no servidor e sincronizadas automaticamente a cada hora."
                : "⚠️ Configure o servidor primeiro para habilitar sync automático."}
            </div>
            {[["booking","🔵 Booking.com",C.booking],["airbnb","🔴 Airbnb",C.airbnb]].map(([src,label,clr]) => (
              <div key={src} style={{ marginBottom:20 }}>
                <div style={{ fontSize:11, color:clr, fontWeight:700, letterSpacing:".08em", marginBottom:10 }}>{label}</div>
                {ROOMS.map(r => (
                  <div key={r.id} style={{ display:"flex", gap:10, alignItems:"center", marginBottom:6 }}>
                    <div style={{ width:34, color:C.cin, fontWeight:800, fontFamily:"monospace", fontSize:14, textAlign:"center", flexShrink:0 }}>{r.id}</div>
                    <input value={icalUrls[src]?.[r.id]||""}
                      onChange={e => setIcalUrls(u => ({...u, [src]:{...u[src],[r.id]:e.target.value}}))}
                      placeholder={`https://ical.${src==="booking"?"booking":"airbnb"}.com/...ics — Qto ${r.id}`}
                      style={{ ...inp, fontSize:11 }} />
                  </div>
                ))}
              </div>
            ))}
            <div style={{ display:"flex", gap:10 }}>
              <button style={btn("#166534")} onClick={async () => {
                if (serverUrl) {
                  await fetch(`${serverUrl}/urls`, { method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify(icalUrls) });
                  log(["✅ URLs salvas no servidor!"]);
                } else {
                  await saveData("pms:ical_urls", icalUrls);
                  log(["✅ URLs salvas localmente."]);
                }
              }}>💾 Salvar URLs</button>
              {connected && (
                <button style={btn("#1e3a5f")} onClick={handleServerSync} disabled={syncing}>
                  {syncing ? "⏳ Sincronizando..." : "🔄 Salvar e Sincronizar Agora"}
                </button>
              )}
            </div>
          </div>
        )}

        {/* FILE UPLOAD TAB */}
        {tab === "file" && (
          <div>
            <div style={{ fontSize:12, color:C.dim, lineHeight:1.7, marginBottom:16 }}>
              Baixe o arquivo <code style={{ background:C.bg0, padding:"1px 5px", borderRadius:4 }}>.ics</code> do Booking/Airbnb e faça o upload aqui.
              No Booking: Extranet → Calendário → ícone de exportar do quarto → abra o link no navegador → arquivo baixa.
            </div>
            <div style={{ display:"flex", gap:10, marginBottom:16 }}>
              <div style={{ flex:1 }}>
                <label style={{ fontSize:10, color:C.muted, fontWeight:700, letterSpacing:".08em", display:"block", marginBottom:4 }}>QUARTO</label>
                <select value={fileRoom} onChange={e => setFileRoom(e.target.value)} style={inp}>
                  {ROOMS.map(r => <option key={r.id} value={r.id}>{r.id} – {r.type}</option>)}
                </select>
              </div>
              <div style={{ flex:1 }}>
                <label style={{ fontSize:10, color:C.muted, fontWeight:700, letterSpacing:".08em", display:"block", marginBottom:4 }}>CANAL</label>
                <select value={fileSrc} onChange={e => setFileSrc(e.target.value)} style={inp}>
                  <option value="booking">Booking.com</option>
                  <option value="airbnb">Airbnb</option>
                </select>
              </div>
            </div>
            <div onDragOver={e=>{e.preventDefault();setDragging(true);}}
              onDragLeave={()=>setDragging(false)} onDrop={e=>{e.preventDefault();setDragging(false);handleFile(e.dataTransfer.files[0]);}}
              onClick={()=>fileRef.current.click()}
              style={{ border:`2px dashed ${dragging?C.cin:C.border}`, borderRadius:12, padding:"36px 16px",
                textAlign:"center", cursor:"pointer", background:dragging?C.cinD:C.bg0, transition:"all .2s" }}>
              <div style={{ fontSize:36, marginBottom:8 }}>📂</div>
              <div style={{ fontSize:13, color:dragging?C.cin:C.text, fontWeight:600 }}>{dragging?"Solte aqui!":"Arraste o arquivo .ics"}</div>
              <div style={{ fontSize:11, color:C.muted, marginTop:4 }}>ou clique para selecionar</div>
              <input ref={fileRef} type="file" accept=".ics,text/calendar" style={{ display:"none" }} onChange={e=>handleFile(e.target.files[0])} />
            </div>
          </div>
        )}

        {/* EXPORT TAB */}
        {tab === "export" && (
          <div>
            <div style={{ fontSize:12, color:C.dim, lineHeight:1.7, marginBottom:18 }}>
              Gere um <code style={{ background:C.bg0, padding:"1px 5px", borderRadius:4 }}>.ics</code> com as reservas do PMS
              para importar no Booking/Airbnb e bloquear datas.
            </div>
            <div style={{ background:"#1a1200", border:"1px solid #554400", borderRadius:10, padding:14, marginBottom:18, fontSize:12, color:"#d4a72c", lineHeight:1.8 }}>
              <b>⚠️ Importante:</b> No Booking, use <b>upload de arquivo</b> (não cole URL do PMS).
              O status "Validando" aparece quando o Booking tenta acessar uma URL que não existe.
            </div>
            <div style={{ background:C.bg0, border:`1px solid ${C.border}`, borderRadius:10, padding:14, marginBottom:20 }}>
              <div style={{ fontSize:11, color:C.muted, fontWeight:700, letterSpacing:".08em", marginBottom:10 }}>COMO IMPORTAR NO BOOKING</div>
              {["1. Baixe o .ics abaixo","2. Extranet → Calendário → Gerenciar conexões","3. Adicionar conexão → Importar calendário","4. Selecione o quarto → Upload do arquivo .ics","5. ✅ Booking bloqueia as datas automaticamente"].map((s,i)=>(
                <div key={i} style={{ fontSize:11, color:C.dim, lineHeight:1.9 }}>• {s}</div>
              ))}
            </div>
            <div style={{ background:C.bg2, border:`1px solid ${C.border}`, borderRadius:12, padding:22, textAlign:"center" }}>
              <div style={{ fontSize:32, marginBottom:8 }}>📅</div>
              <div style={{ fontSize:14, color:C.text, fontWeight:700, marginBottom:4 }}>
                {reservations.filter(r=>r.status!=="cancelled").length} reservas ativas
              </div>
              <div style={{ fontSize:11, color:C.muted, marginBottom:18 }}>Inclui todas as reservas manuais e importadas</div>
              <button onClick={() => downloadIcal(generateIcal(reservations, ROOMS), "pousada-pms.ics")}
                style={{ ...btn("#166534"), padding:"12px 32px", fontSize:14 }}>
                ⬇️  Baixar pousada-pms.ics
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Log */}
      {syncLog.length > 0 && (
        <div style={{ marginTop:16, background:"#04060d", border:`1px solid ${C.border}`,
          borderRadius:10, padding:16, fontFamily:"monospace", fontSize:11,
          maxHeight:200, overflowY:"auto", lineHeight:1.9 }}>
          {syncLog.map((l,i) => (
            <div key={i} style={{ color:
              l.includes("✅")||l.includes("✓") ? "#4ade80" :
              l.includes("✗")||l.includes("Erro") ? "#f87171" :
              l.includes("⚠️") ? "#fbbf24" : "#8898b4" }}>{l}</div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Main App ────────────────────────────────────────────────────────────────
export default function PMS() {
  const [view,         setView]         = useState("map");
  const [reservations, setReservations] = useState([]);
  const [serverUrl,    setServerUrl]    = useState("");
  const [modal,        setModal]        = useState(null);
  const [syncLog,      setSyncLog]      = useState([]);
  const [loaded,       setLoaded]       = useState(false);

  // Load from storage
  useEffect(() => {
    (async () => {
      const r = await loadData("pms:reservations"); if (r) setReservations(r);
      const s = await loadData("pms:server_url");   if (s) setServerUrl(s);
      setLoaded(true);
    })();
  }, []);

  // Auto-fetch from server every 5 minutes if connected
  useEffect(() => {
    if (!serverUrl || !loaded) return;
    const fetchFromServer = async () => {
      try {
        const res  = await fetch(`${serverUrl}/reservations`);
        const data = await res.json();
        setReservations(data);
        await saveData("pms:reservations", data);
      } catch {}
    };
    fetchFromServer();
    const interval = setInterval(fetchFromServer, 5 * 60 * 1000);
    return () => clearInterval(interval);
  }, [serverUrl, loaded]);

  // Save reservations locally when no server
  useEffect(() => {
    if (loaded && !serverUrl) saveData("pms:reservations", reservations);
  }, [reservations, loaded, serverUrl]);

  const handleServerUrlChange = async (url) => {
    setServerUrl(url);
    await saveData("pms:server_url", url);
  };

  // Listen for local file imports (when no server)
  useEffect(() => {
    const handler = (e) => {
      const { evts, roomId, source, filename } = e.detail;
      const newRes = [];
      evts.forEach(ev => {
        const uid = `${source}-${roomId}-${ev.uid}`;
        if (!reservations.find(r => r.externalUid === uid)) {
          newRes.push({
            id:genId(), roomId, externalUid:uid, status:"confirmed",
            guestName:ev.summary||"Reserva", checkIn:ev.checkIn, checkOut:ev.checkOut,
            source, adults:2, children:0, phone:"",
            notes:`Importado de ${filename}`, createdAt:new Date().toISOString(),
          });
        }
      });
      if (newRes.length) setReservations(rs => [...rs, ...newRes]);
    };
    window.addEventListener("pms:import", handler);
    return () => window.removeEventListener("pms:import", handler);
  }, [reservations]);

  // Reservation CRUD — syncs to server if connected
  const saveReservation = async (form) => {
    let updated;
    if (form.id) updated = reservations.map(r => r.id === form.id ? form : r);
    else {
      const newR = { ...form, id:genId(), createdAt:new Date().toISOString() };
      updated = [...reservations, newR];
      form = newR;
    }
    setReservations(updated);
    if (serverUrl) {
      await fetch(`${serverUrl}/reservations`, {
        method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify(form)
      }).catch(()=>{});
    } else {
      await saveData("pms:reservations", updated);
    }
    setModal(null);
  };

  const cancelReservation = async (id) => {
    const updated = reservations.map(r => r.id === id ? {...r, status:"cancelled"} : r);
    setReservations(updated);
    if (serverUrl) {
      await fetch(`${serverUrl}/reservations/${id}`, { method:"DELETE" }).catch(()=>{});
    } else {
      await saveData("pms:reservations", updated);
    }
    setModal(null);
  };

  const handleRoomClick = (room) => {
    const res = getRoomReservation(room.id, reservations);
    if (res) setModal({ type:"edit", reservation:res });
    else     setModal({ type:"new",  roomId:room.id });
  };

  const NAV = [
    { id:"map",     icon:"🏨", label:"Mapa de Quartos" },
    { id:"reservas",icon:"📋", label:"Reservas" },
    { id:"sync",    icon:"🔄", label:"Sincronização" },
  ];

  return (
    <div style={{ display:"flex", height:"100vh", background:C.bg0,
      fontFamily:"'Segoe UI', system-ui, sans-serif", color:C.text, overflow:"hidden" }}>

      {/* Sidebar */}
      <div style={{ width:70, background:C.bg1, borderRight:`1px solid ${C.border}`,
        display:"flex", flexDirection:"column", alignItems:"center", paddingTop:18, gap:4 }}>
        <div style={{ fontSize:26, marginBottom:18, filter:"drop-shadow(0 0 8px #3b82f666)" }}>🏡</div>
        {NAV.map(n => (
          <button key={n.id} onClick={() => setView(n.id)} title={n.label} style={{
            width:50, height:50, borderRadius:12, border:"none", cursor:"pointer", fontSize:21,
            background: view===n.id ? C.bg3 : "transparent",
            borderLeft: `3px solid ${view===n.id ? C.cin : "transparent"}`,
            transition:"all .18s", position:"relative",
          }}>
            {n.icon}
            {/* dot indicator for sync */}
            {n.id==="sync" && (
              <div style={{ position:"absolute", top:8, right:8, width:7, height:7, borderRadius:"50%",
                background: serverUrl ? C.free : C.cout,
                boxShadow:`0 0 5px ${serverUrl ? C.free : C.cout}` }} />
            )}
          </button>
        ))}
      </div>

      {/* Content */}
      <div style={{ flex:1, display:"flex", flexDirection:"column", overflow:"hidden" }}>
        <div style={{ background:C.bg1, borderBottom:`1px solid ${C.border}`,
          padding:"15px 24px", display:"flex", alignItems:"center", justifyContent:"space-between" }}>
          <div>
            <h1 style={{ margin:0, fontSize:18, fontWeight:900, color:C.text,
              fontFamily:"'Georgia', serif", letterSpacing:"-.01em" }}>
              {NAV.find(n=>n.id===view)?.label}
            </h1>
            <div style={{ fontSize:11, color:C.muted, marginTop:2 }}>
              {new Date().toLocaleDateString("pt-BR",{weekday:"long",day:"numeric",month:"long",year:"numeric"})}
            </div>
          </div>
          <div style={{ display:"flex", gap:10, alignItems:"center" }}>
            {serverUrl && (
              <div style={{ fontSize:10, color:C.free, display:"flex", alignItems:"center", gap:5 }}>
                <div style={{ width:6, height:6, borderRadius:"50%", background:C.free, boxShadow:`0 0 5px ${C.free}` }} />
                Servidor online
              </div>
            )}
            <button onClick={() => setModal({ type:"new", roomId:null })} style={btn("#166534")}>
              + Nova Reserva
            </button>
          </div>
        </div>

        <div style={{ flex:1, overflowY:"auto", padding:24 }}>
          {view === "map" && (
            <RoomMapView rooms={ROOMS} reservations={reservations}
              onRoomClick={handleRoomClick} />
          )}
          {view === "reservas" && (
            <ReservasView rooms={ROOMS} reservations={reservations}
              onEdit={r => setModal({ type:"edit", reservation:r })}
              onNew={() => setModal({ type:"new", roomId:null })} />
          )}
          {view === "sync" && (
            <SyncView reservations={reservations}
              serverUrl={serverUrl} onServerUrlChange={handleServerUrlChange}
              syncLog={syncLog} setSyncLog={setSyncLog} />
          )}
        </div>
      </div>

      {/* Modals */}
      {modal?.type === "new" && (
        <Modal title="Nova Reserva" onClose={() => setModal(null)}>
          <ReservationForm rooms={ROOMS}
            initial={modal.roomId ? { roomId:modal.roomId } : undefined}
            onSave={saveReservation} onClose={() => setModal(null)} />
        </Modal>
      )}
      {modal?.type === "edit" && (
        <Modal title="Editar Reserva" onClose={() => setModal(null)}>
          <ReservationForm rooms={ROOMS} initial={modal.reservation}
            onSave={saveReservation}
            onCancel={() => cancelReservation(modal.reservation.id)}
            onClose={() => setModal(null)} />
        </Modal>
      )}
    </div>
  );
}
