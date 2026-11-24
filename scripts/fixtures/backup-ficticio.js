// Backup FICTÍCIO (nenhum dado real) no formato de /admin/backup, para o ensaio
// de restauração no CI. Inclui textos com aspas, $ e acento para testar escape.
"use strict";
const { buildBackup } = require("../../lib/backup");
const tables = {
  users: [{ id: "u1", username: "admin-teste", password_hash: "$2b$10$hashficticio", role: "admin", created_at: "2030-01-01T00:00:00+00:00" }],
  guests: [{ id: "g1", name: "Hóspede O'Teste $pms$", phone: "TEL-FICTICIO", email: "", cpf: "", address: "", notes: "aspas \" e \\ barra", created_at: "2030-01-01T00:00:00+00:00", updated_at: "2030-01-01T00:00:00+00:00" }],
  reservations: [
    { id: "r1", room_id: "20", guest_name: "Hóspede Teste", check_in: "2099-01-10", check_out: "2099-01-12", source: "direto", adults: 2, children: 0, phone: "", notes: "", status: "confirmed", external_uid: null, created_at: "2030-01-01T00:00:00+00:00", amount: 350.5, payment: "pix", group_id: null },
    { id: "r2", room_id: "20", guest_name: "Hóspede Teste", check_in: "2099-01-12", check_out: "2099-01-14", source: "booking", adults: 2, children: 0, phone: "", notes: "", status: "confirmed", external_uid: "uid-ficticio", created_at: "2030-01-01T00:00:00+00:00", amount: 0, payment: "pix", group_id: null },
  ],
  prereservations: [],
  transactions: [{ id: "t1", type: "receita", category: "reserva", description: "Teste", amount: 100, date: "2030-01-02", month: "2030-01", reservation_id: "r1", created_at: "2030-01-02T00:00:00+00:00" }],
  settings: [{ key: "ical_urls", value: { airbnb: {}, booking: { "20": "https://exemplo.test/ficticio.ics" } } }],
  payments: [{ id: "p1", reservation_id: "r1", kind: "sinal", amount: 100, method: "pix", due_date: null, paid_at: "2030-01-02", notes: "", created_at: "2030-01-02T00:00:00+00:00", created_by: "admin-teste" }],
  audit_log: [{ id: 41, at: "2030-01-02T00:00:00+00:00", user_id: "u1", username: "admin-teste", role: "admin", action: "create", entity: "reservation", entity_id: "r1", reservation_id: "r1", changes: { amount: 350.5 } }],
};
buildBackup(async (name) => ({ data: tables[name], error: null }), { now: new Date("2030-01-03T00:00:00Z") })
  .then(b => process.stdout.write(JSON.stringify(b)));
