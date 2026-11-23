# PMS Pousada

Sistema de gestão da pousada: reservas (quartos individuais, suíte 11+12 e Casa Fechada),
hóspedes, limpeza/check-in, financeiro e sincronização de calendários (iCal) com Airbnb e Booking.

## Estrutura

| Caminho | O que é |
|---|---|
| `server.js` | API Express 4 e sincronização iCal |
| `build/index.html` | Interface (HTML/CSS/JS sem framework), servida como arquivo estático |
| `lib/availability.js` | Regras de disponibilidade (datas, quartos, sobreposição) — funções puras |
| `test/` | Testes automatizados (`node:test`, sem dependências extras) |
| `.env.example` | Variáveis de ambiente necessárias (sem valores) |

Quartos físicos: 10, 11, 12, 20, 21, 22, 23, 24, 25. Produtos compostos:
`11+12` ocupa os quartos 11 e 12; `CF` (Casa Fechada) ocupa os nove.
Uma estadia ocupa o intervalo `[check_in, check_out)`: saída e entrada no mesmo dia não conflitam.

## Rodar localmente

Requer Node.js 18 ou mais novo.

```bash
npm ci
cp .env.example .env          # preencha com um Supabase de DESENVOLVIMENTO, nunca o de produção
node --env-file=.env server.js   # Node 20.6+; no Node 18, exporte as variáveis antes
```

Abra http://localhost:3000.

## Testes

```bash
npm test
```

Os testes não acessam banco nem rede: usam dados fictícios e um Supabase simulado.

## Regras para contribuir

- Nunca rode migrations ou scripts de escrita no banco de produção sem backup e restauração testados.
- Nunca coloque CPF, telefones, nomes reais, tokens, chaves ou URLs de feed iCal em código, testes, issues ou commits.
- Uma tarefa do backlog por PR, com testes e forma de desfazer.
