# Elevate Lead Dispatcher — Plano de Arquitetura

> Documento vivo. Cada decisão aqui tem um "porquê" e uma alternativa considerada.
> Status: **rascunho para revisão** (fase 0).

## 1. Escopo e priorização

O núcleo avaliado (seção 27 do enunciado) recebe a maior profundidade:

| Prioridade | Item | Profundidade |
|---|---|---|
| P0 | `POST /api/leads` (validação, idempotência) | completa + testes |
| P0 | Modelagem + migrations + índices | completa + justificativa |
| P0 | Dispatcher ponderado + concorrência | completa + teste de concorrência |
| P0 | `POST /api/webhooks/callcenter` (HMAC, dedup, fora de ordem) | completa + testes |
| P1 | Auth (sessão) + RBAC ADMIN/OPERATOR no backend | completa + testes de autorização |
| P1 | API de listagem (filtros, paginação keyset) + métricas | completa |
| P2 | Dashboard React | funcional, limpo, sem excesso |
| P2 | Config do dispatcher pelo ADMIN | pesos e ativo/inativo |
| — | Envio real a call center, outbox, filas, Redis | **fora de escopo**, documentado |

Princípio: sem componente extra (fila, Redis, worker) sem um problema concreto que o justifique.
O Postgres resolve concorrência, idempotência e auditoria aqui.

## 2. Stack

| Camada | Escolha | Por quê | Alternativa descartada |
|---|---|---|---|
| Runtime | Node 22 LTS + TypeScript (strict) | Stack da vaga; tipos ponta a ponta | — |
| HTTP | **Fastify 5** | Validação por schema nativa, logger pino, `inject()` para testes sem rede, plugins maduros (helmet, rate-limit, cookie) | Express (sem schema, mais lento), NestJS (cerimônia demais para o tamanho) |
| Validação | **Zod** (pacote `contracts` compartilhado) | Mesmo schema valida API e tipa frontend | Joi/class-validator |
| Banco | **PostgreSQL 18** | Relacional pedido; `uuidv7()` nativo; `FOR UPDATE`, sequences, `ON CONFLICT` | MySQL (menos recursos para o que precisamos) |
| Acesso a dados | **Drizzle ORM** + migrations SQL geradas e versionadas | SQL explícito e tipado, suporta `FOR UPDATE`/`ON CONFLICT`/`sql` cru; migrations são `.sql` legíveis e revisáveis | Prisma (fraco em locks/SQL avançado, engine binária), Knex (sem tipos) |
| Frontend | **React 19 + Vite** + TanStack Query + React Router | Painel atrás de login: sem SEO/SSR, SPA é mais simples; servido pelo mesmo origin via nginx | Next.js (SSR não agrega aqui e adiciona um segundo servidor Node) |
| Testes | **Vitest** + Postgres real (Testcontainers) | Concorrência só é testável contra banco real; mocks esconderiam o problema | Jest; SQLite em memória (semântica de lock diferente) |
| Lint/format | **Biome** | Uma ferramenta, rápida | ESLint + Prettier |
| Monorepo | pnpm workspaces | `apps/api`, `apps/web`, `packages/contracts` | Turborepo (desnecessário nesse tamanho) |

## 3. Arquitetura

Monólito modular. Um processo de API, um banco, um frontend estático.

```
Browser ──► nginx (web) ──/api──► Fastify API ──► PostgreSQL 18
Landing page ──POST /api/leads──┘        ▲
Call center ──POST /api/webhooks/callcenter (HMAC)
```

Cada módulo segue: `routes` (HTTP, validação, authz) → `service` (casos de uso, transação) → `repository` (SQL).
Regras de negócio puras (máquina de estados, escalonamento ponderado) ficam em `domain/`, sem I/O, 100% testáveis em unidade.

```
apps/api/src/
  modules/
    leads/        recebimento, listagem, métricas
    dispatcher/   escalonamento ponderado + atribuição
    webhooks/     verificação HMAC, ingestão de eventos
    auth/         login, sessão, guards de papel
    admin/        configuração do dispatcher
  domain/         lead-status.ts (máquina de estados), weighted-schedule.ts
  db/             schema.ts, client.ts, migrations/
  plugins/        errors, security, rate-limit
packages/contracts/  schemas Zod compartilhados (lead, webhook, enums)
apps/web/            SPA
```

### Fluxo de um lead

1. `POST /api/leads` → Zod valida formato.
2. Transação única:
   1. Resolve `product` e `funnel` (funil deve pertencer ao produto) → 422 se inválido.
   2. Upsert do `affiliate` por `external_ref`.
   3. `INSERT ... ON CONFLICT (idempotency_key) DO NOTHING RETURNING id`.
      Se não inseriu → replay: retorna o lead existente (200) sem tocar no dispatcher.
   4. Dispatcher: `nextval('dispatch_cursor')` → slot no escalonamento → call center.
   5. Grava `distributions`, atualiza `leads.call_center_id`, grava evento `new` em `lead_events`.
3. Responde `201 { success, lead_id, call_center }`.
4. Call center trabalha o lead e chama o webhook com HMAC.
5. Webhook: verifica assinatura → dedup do evento → trava o lead (`FOR UPDATE`) → aplica ou registra como não aplicado (fora de ordem/transição inválida) → histórico sempre gravado.

## 4. Modelo de dados

```
products(id, slug UNIQUE, name, active, created_at)
funnels(id, product_id FK, slug, name, active, UNIQUE(product_id, slug))
affiliates(id, external_ref UNIQUE, name, created_at)
call_centers(id, slug UNIQUE, name, weight, active, webhook_secret, updated_at)
leads(
  id uuidv7 PK, name, email, phone,
  product_id FK, funnel_id FK, affiliate_id FK NULL,
  source, campaign, utm_source, utm_medium, utm_campaign, utm_content, utm_term,
  call_center_id FK NULL,          -- atribuição atual (denormalizada de distributions)
  status lead_status, status_changed_at,
  idempotency_key UNIQUE, request_hash,
  created_at, updated_at)
distributions(id, lead_id FK, call_center_id FK, cursor bigint, schedule_version, created_at)
lead_events(                        -- histórico/auditoria append-only
  id, lead_id FK, call_center_id, origin (system|webhook|operator), actor_user_id NULL,
  dedup_key, external_id, from_status, to_status,
  occurred_at, received_at, applied bool, rejection_reason, payload jsonb,
  UNIQUE(lead_id, dedup_key))
users(id, email UNIQUE, password_hash, role (admin|operator), call_center_id NULL,
      failed_logins, locked_until, CHECK(role='operator' => call_center_id NOT NULL))
sessions(token_hash PK, user_id FK, expires_at, created_at)
```

- **IDs:** `uuidv7()` (PG 18). Ordenados no tempo → inserções no fim da B-tree (sem fragmentação do UUIDv4), e não são enumeráveis como serial.
- **Lead Status:** enum Postgres (`new, contacted, no_answer, callback, qualified, sale, refund, invalid`). Status atual em `leads.status`, histórico completo em `lead_events`.
- **`call_center_id` em `leads`:** denormalização intencional. `distributions` é o histórico de atribuições (permite redistribuição futura); `leads.call_center_id` é a atribuição atual, usada em toda query de OPERATOR e filtro. Evita join em toda listagem.
- **UTM em colunas** (não jsonb): são filtráveis e têm estrutura fixa. Payload bruto do webhook vai em jsonb só para auditoria.

## 5. Decisões centrais

### 5.1 Idempotência do `POST /api/leads`
- Cliente pode enviar `Idempotency-Key` (header). Sem header, a chave é `sha256(payload canônico)`. Um retry idêntico gera a mesma chave.
- Unique constraint em `idempotency_key` + `INSERT ... ON CONFLICT DO NOTHING`. Duas requisições simultâneas com a mesma chave: uma insere, a outra cai no conflito. Sem janela de corrida.
- Mesma chave com payload diferente → `409 Conflict` (comparando `request_hash`), no padrão da Stripe.
- Replay → `200` com o mesmo `lead_id` e `duplicate: true`. Criação → `201`.
- **Fora de escopo, mas documentado:** deduplicação de *negócio* (mesmo e-mail + produto dias depois) é decisão de produto, não de transporte.

### 5.2 Dispatcher: smooth weighted round robin + cursor atômico
- Pesos 50/30/20 → reduzidos pelo MDC → 5/3/2 → escalonamento determinístico de 10 slots via *smooth WRR* (algoritmo do nginx): `A B C A A B A C B A`. Distribui intercalado, sem rajadas de A.
- O estado compartilhado é **um único inteiro**: a sequence `dispatch_cursor`. `nextval()` é atômico e **não bloqueia** entre transações. Cada lead recebe um cursor único → `slot = cursor mod total_weight`.
- Por que não "ler contadores e atualizar": é exatamente a corrida descrita na seção 13. Por que não `SELECT ... FOR UPDATE` numa linha de estado: funciona e é exato, mas serializa todas as inserções de lead nessa linha até o commit. A sequence dá a mesma garantia sem contenção.
- Trade-off aceito: uma transação que faz rollback depois do `nextval` "pula" um slot (sequences não voltam). O desvio é no máximo de 1 lead por rollback, e rollback após validação é raro. Documentado.
- Mudança de pesos pelo ADMIN: o escalonamento é recalculado e `schedule_version` é gravado em cada distribuição, para auditoria.

### 5.3 Webhook: autenticação
- **HMAC-SHA256 por call center.** Headers: `X-CallCenter-Id`, `X-Signature: t=<unix>,v1=<hex>`, assinando `${t}.${rawBody}`.
- Comparação com `timingSafeEqual`. Tolerância de ±5 min no `t` contra replay.
- Segredo por call center: um segredo vazado compromete um parceiro, não todos. E a identidade autenticada **autoriza**: o call center B não consegue alterar um lead do A (retorna 404, para não vazar existência).
- API key simples foi descartada: vai em texto claro, não protege a integridade do corpo e não impede replay.

### 5.4 Webhook duplicado
- `dedup_key` = `event_id` do payload se existir; senão `sha256(lead_id|status|timestamp)`.
- `UNIQUE(lead_id, dedup_key)` em `lead_events` + `ON CONFLICT DO NOTHING`. Um duplicado retorna `200 { duplicate: true }`, para o call center parar de reenviar, e não altera nada.

### 5.5 Eventos fora de ordem
Duas regras, aplicadas com o lead travado (`SELECT ... FOR UPDATE`) para que dois webhooks simultâneos do mesmo lead não se atropelem:
1. **Ordenação temporal:** só aplica se `event.occurred_at > lead.status_changed_at`. Um `contacted` de 11h que chega depois de um `sale` de 12h é **gravado no histórico** com `applied=false, rejection_reason='stale'`, mas não muda o status.
2. **Máquina de estados:** mesmo com timestamp mais novo, transições inválidas são rejeitadas (`sale → contacted` não existe).

```
new        → contacted | no_answer | callback | qualified | sale | invalid
contacted  → no_answer | callback | qualified | sale | invalid
no_answer  → contacted | no_answer | callback | qualified | sale | invalid
callback   → contacted | no_answer | callback | qualified | sale | invalid
qualified  → contacted | no_answer | callback | sale | invalid
sale       → refund
refund     → (terminal)
invalid    → (terminal)
```
Eventos rejeitados retornam `200 { applied: false, reason }`: o webhook foi recebido corretamente, e um 4xx faria o parceiro reenviar para sempre. Timestamp no futuro (> agora + 5 min) → 422.

### 5.6 Autenticação e sessão
- Sessão opaca em cookie `HttpOnly; Secure; SameSite=Strict`. No banco fica só o `sha256(token)`. Revogável na hora, diferente de JWT.
- Senhas com **argon2id**.
- CSRF: `SameSite=Strict` + verificação de `Origin` em métodos mutáveis + API aceita apenas `application/json` (form HTML não consegue forjar).
- Brute force: rate limit por IP no `/auth/login` + bloqueio temporário por conta após N falhas. Mensagem de erro genérica (sem enumeração de usuário).
- RBAC no backend: guard `requireRole('admin')` nas rotas admin. **Escopo de OPERATOR aplicado no repository** (`WHERE call_center_id = $user.call_center_id` injetado pelo serviço, não pelo cliente). Lead de outro call center → 404.

### 5.7 Listagem e métricas
- **Paginação keyset** em `(created_at, id)`: custo constante na página 1 ou na 50.000. `OFFSET` degrada linearmente a 10M linhas.
- Filtros: período, produto, funil, origem, call center, status. Estado dos filtros na URL.
- Métricas: total, hoje (fuso configurável, padrão `America/Sao_Paulo`), distribuídos, pendentes, vendas, conversão = vendas / total.

## 6. Índices (justificativa vai para o README)

| Índice | Consulta otimizada |
|---|---|
| `leads(created_at DESC, id DESC)` | listagem padrão, paginação keyset, "leads hoje", filtro por período |
| `leads(call_center_id, created_at DESC, id DESC)` | listagem do OPERATOR (consulta mais frequente) e filtro por call center |
| `leads(status, created_at DESC)` | métricas de vendas/pendentes, filtro por status |
| `leads(product_id, funnel_id, created_at DESC)` | filtro por produto/funil |
| `lead_events(lead_id, received_at)` | histórico/auditoria de um lead |
| UNIQUE `leads(idempotency_key)`, `lead_events(lead_id, dedup_key)` | idempotência (são índices também) |
| UNIQUE `funnels(product_id, slug)`, `products(slug)`, `affiliates(external_ref)` | resolução no recebimento |

Sem índice em `source`/`utm_*`: baixa seletividade. Os filtros combinam com o intervalo de `created_at`.

## 7. Escalabilidade (100k → 1M → 10M+)

- **100k–1M:** o modelo atual atende. Índices compostos + keyset cobrem as consultas.
- **10M+:** particionar `leads` e `lead_events` por `RANGE(created_at)` mensal (partition pruning em consultas por período, VACUUM e retenção por partição). Métricas saem de `COUNT(*)` ao vivo e passam para uma tabela de rollup diária, atualizada incrementalmente. Réplica de leitura para o dashboard. PgBouncer em modo transação.
- **Ingestão em pico:** se o `POST /api/leads` virar gargalo, aceitar o lead e distribuir de forma assíncrona (outbox + worker). Hoje não se justifica.

## 8. Fases e commits

| Fase | Entrega | Commit(s) |
|---|---|---|
| 0 | CLAUDE.md, este plano, log de IA | `docs: ...` |
| 1 | Monorepo, TS, Biome, Vitest, compose com Postgres | `chore: ...` |
| 2 | Schema, migrations, seed | `feat(db): ...` |
| 3 | Domínio puro: máquina de estados + WRR + testes unitários | `feat(domain): ...` |
| 4 | `POST /api/leads` + idempotência + dispatcher + testes de integração/concorrência | `feat(leads): ...` |
| 5 | Webhook + HMAC + dedup + fora de ordem + testes | `feat(webhooks): ...` |
| 6 | Auth + RBAC + listagem/métricas + testes de autorização | `feat(auth): ...` |
| 7 | Config do dispatcher (ADMIN) | `feat(admin): ...` |
| 8 | Frontend | `feat(web): ...` |
| 9 | Docker completo, hardening, README final | `docs/chore: ...` |

Ao fim de cada fase: testes verdes, revisão humana, commit.

## 9. Questões em aberto (decisão do candidato)

1. **"Leads pendentes"**: (a) status `new`, aguardando primeiro contato, ou (b) aguardando distribuição (só ocorre sem call center ativo)? Proposta: (a), com (b) visível separadamente se > 0.
2. **Affiliate desconhecido**: criar automaticamente (proposta: não perder lead de parceiro novo) ou rejeitar?
3. **`POST /api/leads` público**: chamado direto do browser da landing page (proposta: público + rate limit + CORS allowlist), ou só server-to-server com API key?
