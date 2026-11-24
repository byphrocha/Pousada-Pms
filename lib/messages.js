// PMS-021: modelos de mensagem de WhatsApp. Funções puras.
// Os textos reais (horário, endereço, chave PIX) ficam só no banco (settings),
// editados pelo administrador. Aqui há apenas modelos genéricos com lacunas
// [entre colchetes] para preencher. Nada é enviado pelo servidor: a tela só
// abre o WhatsApp com o texto revisado pela pessoa.
"use strict";

const SETTINGS_KEY = "message_templates";
const MAX_TEMPLATES = 12;
const MAX_TITLE = 60;
const MAX_BODY = 2000;

// admin: true → usa valores ({valor}/{saldo}); funcionário não vê (decisão de 23/11).
const DEFAULT_TEMPLATES = [
  { id: "confirmacao", title: "Confirmação", admin: false,
    body: "Olá, {nome}! Sua reserva está confirmada: {quarto}, de {entrada} a {saida} ({noites} noite(s)). Qualquer dúvida, é só chamar por aqui." },
  { id: "chegada", title: "Instruções de chegada", admin: false,
    body: "Olá, {nome}! Seu check-in é em {entrada}. [Escreva aqui o horário de check-in, o endereço e como entrar.] Boa viagem!" },
  { id: "saldo", title: "Lembrete de saldo", admin: true,
    body: "Olá, {nome}! Passando para lembrar do saldo da sua reserva ({quarto}, {entrada} a {saida}): {saldo}. [Escreva aqui a chave PIX ou a forma de pagamento.]" },
  { id: "agradecimento", title: "Agradecimento", admin: false,
    body: "Olá, {nome}! Obrigado por se hospedar com a gente. Se puder, deixe sua avaliação. Volte sempre!" },
];

const USES_MONEY = /\{(valor|saldo)\}/;

/**
 * Valida o que o administrador enviou. Devolve { templates } ou { error }.
 * Modelo que usa {valor}/{saldo} é sempre marcado admin (o funcionário não vê valores),
 * mesmo que venha admin:false.
 */
function sanitizeTemplates(input) {
  if (!Array.isArray(input)) return { error: "Envie uma lista de modelos." };
  if (input.length === 0) return { error: "Mantenha pelo menos um modelo." };
  if (input.length > MAX_TEMPLATES) return { error: `No máximo ${MAX_TEMPLATES} modelos.` };
  const out = [];
  const ids = new Set();
  for (const [i, t] of input.entries()) {
    if (!t || typeof t !== "object") return { error: `Modelo ${i + 1} inválido.` };
    const title = String(t.title ?? "").trim();
    const body = String(t.body ?? "").replace(/\r\n/g, "\n").trim();
    if (!title) return { error: `Modelo ${i + 1} sem título.` };
    if (!body) return { error: `"${title.slice(0, MAX_TITLE)}" está sem texto.` };
    if (title.length > MAX_TITLE) return { error: `Título com mais de ${MAX_TITLE} caracteres.` };
    if (body.length > MAX_BODY) return { error: `"${title}" passa de ${MAX_BODY} caracteres.` };
    let id = String(t.id ?? "").toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 30) || `modelo-${i + 1}`;
    while (ids.has(id)) id += "-2";
    ids.add(id);
    out.push({ id, title, body, admin: t.admin === true || USES_MONEY.test(body) });
  }
  return { templates: out };
}

/** O que cada perfil pode ver. */
function templatesForRole(templates, role) {
  const list = Array.isArray(templates) && templates.length ? templates : DEFAULT_TEMPLATES;
  return role === "admin" ? list : list.filter(t => !t.admin && !USES_MONEY.test(t.body));
}

module.exports = { SETTINGS_KEY, DEFAULT_TEMPLATES, MAX_TEMPLATES, MAX_BODY, sanitizeTemplates, templatesForRole };
