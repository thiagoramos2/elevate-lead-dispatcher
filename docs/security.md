# Segurança

Ameaças consideradas, medidas implementadas e onde cada uma é verificada. Seção 22 do enunciado.

## Superfícies

| Superfície | Quem chama | Autenticação |
|---|---|---|
| `POST /api/leads` | Landing pages / servidor de formulários | Pública (por natureza), com validação estrita e rate limit |
| `POST /api/webhooks/callcenter` | Call centers parceiros | HMAC-SHA256 por call center |
| `/api/auth/*`, `/api/leads` (GET), `/api/admin/*` | Dashboard | Sessão (cookie HttpOnly) + perfil |

## Ameaças e medidas

| Ameaça | Medida | Verificação |
|---|---|---|
| **Autenticação fraca** | Senhas com argon2id (19 MiB, t=2, p=1, mínimo OWASP), parâmetros explícitos no código. Sessão opaca de 256 bits; no banco só `sha256(token)`. Expiração deslizante de 8 h. Logout invalida no servidor | `auth-and-access.test.ts` |
| **Brute force / credential stuffing** | Rate limit por IP no login (10/min, Redis). Bloqueio da conta após 5 falhas por 15 min (contador atômico no banco). Resposta idêntica para e-mail inexistente, senha errada e conta bloqueada; argon2 roda mesmo sem usuário (tempo constante) | testes de lockout, de mensagem idêntica e de 429 |
| **Autorização / IDOR** | Guards no backend em toda rota. O escopo do OPERATOR vem da sessão e entra como `AND` na query: forjar `?callCenter=` devolve vazio. Lead de outro call center → `404` (não revela existência). Rotas de admin → `403` | testes de requisição direta à API (seção 21) |
| **SQL injection** | Todo SQL é parametrizado: Prisma ou `$queryRaw` com template tag; filtros dinâmicos montados com `Prisma.sql`/`Prisma.join`. Não existe `$queryRawUnsafe` no código | revisão + `grep` |
| **XSS** | React escapa toda saída; nenhum `dangerouslySetInnerHTML`. API só responde JSON, com headers do Helmet (`X-Content-Type-Options`, CSP na API). O Next envia `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy` | revisão |
| **CSRF** | Cookie `SameSite=Strict`; rotas autenticadas só aceitam JSON (formulário HTML entre sites não consegue enviar); requisição mutável com cookie de sessão e `Origin` diferente do dashboard → `403` | teste de CSRF |
| **Webhook forjado** | HMAC-SHA256 por call center sobre `"<t>.<corpo bruto>"`, `timingSafeEqual`, segredo de ≥ 32 caracteres vindo do ambiente | `webhook-signature.test.ts`, `webhook-api.test.ts` |
| **Replay de webhook** | Janela de ±5 min no timestamp assinado; dentro dela, a deduplicação por `UNIQUE(lead_id, dedup_key)` | testes de assinatura expirada e de duplicado |
| **Call center alterando lead alheio** | A identidade autenticada pelo HMAC restringe o escopo: só leads distribuídos a ela → `404` | teste dedicado |
| **Validação de entrada** | Zod em todas as rotas (corpo, query, params, headers); limites de tamanho por campo; caracteres de controle rejeitados; UTM estrito; corpo máximo de 64 KB. No webhook, autentica **antes** de validar, para não dar detalhes de schema a quem não está autenticado | `lead-validation.test.ts`, testes de 400/422 |
| **Abuso / DoS de aplicação** | Rate limit por rota: login 10/min por IP, ingestão 300/min por IP, webhook 1200/min por call center | teste de 429 |
| **Exposição de dados sensíveis** | Respostas com schema de saída (Zod): hash de senha, token e segredos nunca saem. Logs pino com redaction de e-mail, telefone, senha, cookie, `authorization` e assinatura. Erros 500 genéricos, sem stack nem SQL | teste "never echoes internals" |
| **Segredos no repositório** | Só valores de demonstração (marcados como tal); segredos reais via variáveis de ambiente; `.env` no `.gitignore`; config validada no boot sem ecoar valores | revisão |

## Decisões conscientes (e o que ficaria para produção)

- **Rate limit fail-open:** se o Redis cair, o rate limit é ignorado (logado), em vez de derrubar a ingestão de leads. Disponibilidade da receita > limitação momentânea.
- **`COOKIE_SECURE=false` no Compose de demonstração**, porque ele roda em `http://localhost`. Em produção: HTTPS, `COOKIE_SECURE=true` e prefixo `__Host-` (ADR-0006).
- **`POST /api/leads` sem CORS:** a ingestão é server-to-server ou pela mesma origem. Para landing pages postando direto do navegador de outros domínios, faltaria uma allowlist de CORS por origem.
- **Affiliate criado automaticamente** a partir de um endpoint público: evita perder atribuição, mas permite criar affiliates com refs inventadas (mitigado pelo rate limit). Alternativa: vincular só a affiliates cadastrados.
- **Segredos HMAC em variável de ambiente:** em produção, num secrets manager, com dois segredos ativos por call center para rotação sem downtime.
- **CSP no dashboard:** o Next precisa de nonce para scripts inline; não implementado. A API tem CSP via Helmet.
- **LGPD:** leads têm dados pessoais (nome, e-mail, telefone). Faltam política de retenção e anonimização, e controle de acesso por campo (ex.: mascarar telefone para perfis de leitura).
