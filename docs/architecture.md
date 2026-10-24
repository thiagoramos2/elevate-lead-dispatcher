# Arquitetura — Elevate Lead Dispatcher

> Documento vivo. As decisões detalhadas estão em [`docs/decisions/`](decisions/).
> Revisão 2: a stack foi redefinida pelo candidato (Prisma, Next.js, BullMQ + outbox). A revisão 1 está no histórico do Git.

## 1. Visão geral

```
                 ┌────────────┐   /api/* (rewrite)   ┌──────────────┐
  Admin/Operator │  web       │ ───────────────────► │  api         │──┐
  (browser) ───► │  Next.js   │                      │  Fastify     │  │ rate limit
                 └────────────┘                      └──────┬───────┘  ▼
  Landing page ── POST /api/leads ──────────────────────────┤      ┌────────┐
  Call center ─── POST /api/webhooks/callcenter (HMAC) ─────┤      │ Redis  │
                                                            ▼      └───▲────┘
                                                     ┌──────────────┐  │ BullMQ
                                                     │ PostgreSQL 18│  │
                                                     └──────▲───────┘  │
                                                            │          │
                                                     ┌──────┴──────────┴─┐
                                                     │ worker            │
                                                     │ • outbox relay    │
                                                     │ • distribution    │
                                                     └───────────────────┘
```

| Serviço    | Responsabilidade                                                                                                   | Depende de                                                 |
| ---------- | ------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------- |
| `web`      | Dashboard (Next.js 16 + Tailwind). Faz proxy de `/api/*` para a API, então o cookie de sessão fica no mesmo origin | api                                                        |
| `api`      | HTTP: ingestão de leads, webhook, auth, consultas e métricas. **Não publica na fila**                              | Postgres (obrigatório), Redis (só rate limit, _fail-open_) |
| `worker`   | Relay do outbox (Postgres → BullMQ) e consumidor de distribuição. Escala horizontalmente                           | Postgres, Redis                                            |
| `postgres` | Fonte da verdade: leads, distribuições, histórico, outbox, estado do dispatcher                                    | —                                                          |
| `redis`    | Transporte de jobs (BullMQ) e contadores de rate limit. **Não é fonte da verdade**                                 | —                                                          |

API e worker compartilham o mesmo pacote (`apps/backend`) e a mesma imagem Docker, com dois entrypoints. São processos separados, mas o código de domínio é um só.

## 2. Fluxo de um lead

**Ingestão (síncrona, só Postgres)**
1. `POST /api/leads` → Zod valida o formato (400 com detalhes por campo).
2. Transação:
   1. Resolve `product` ativo e `funnel` ativo daquele produto → 422 se inválido.
   2. Upsert do `affiliate` por `external_ref` (`ON CONFLICT DO NOTHING`).
   3. `INSERT lead ... ON CONFLICT (idempotency_key) DO NOTHING RETURNING id`.
      Se não inseriu → replay → `200` com o `lead_id` existente (ou `409` se o payload diverge).
   4. `INSERT lead_events` (status inicial `new`, origem `system`).
   5. `INSERT outbox_events` (`lead.created`).
3. Commit → `201 { success, lead_id, distribution_status: "pending" }`.

O lead está persistido antes da resposta. Redis fora do ar não afeta a ingestão.

**Publicação (worker: outbox relay)**
4. Loop: `SELECT ... FROM outbox_events WHERE published_at IS NULL AND available_at <= now() ORDER BY id LIMIT 100 FOR UPDATE SKIP LOCKED`.
5. `queue.addBulk(...)` com `jobId = lead_id` (o BullMQ ignora um jobId que já existe).
6. Marca `published_at`. Se o Redis falhar, faz rollback, incrementa `attempts`, define `available_at` com backoff e loga. Nada se perde.

**Distribuição (worker: consumidor BullMQ)**
7. Transação:
1. `SELECT ... FROM leads WHERE id = $1 FOR UPDATE`. Se já distribuído → no-op (idempotente).
2. `UPDATE dispatcher_state SET cursor = cursor + 1 RETURNING cursor, config_version`. A linha fica travada até o commit, o que serializa a decisão entre todos os workers.
3. Lê os call centers ativos e monta o escalonamento smooth WRR (função pura, cache por `config_version`).
4. `call_center = schedule[(cursor - 1) mod length]`.
5. `INSERT distributions` (`UNIQUE(lead_id)` é a última barreira contra duplicidade).
6. `UPDATE leads SET call_center_id, distribution_status = 'distributed', distributed_at`.
7. Falha: retry com backoff exponencial. Esgotadas as tentativas, `distribution_status = 'failed'` e o motivo fica registrado.

**Atualização (webhook)**
9. `POST /api/webhooks/callcenter`: verifica o HMAC do call center → Zod → transação:
`FOR UPDATE` no lead → confere que o lead pertence ao call center autenticado → insere o evento com `dedup_key` (`ON CONFLICT DO NOTHING` → duplicado) → aplica ou rejeita (fora de ordem / transição inválida) → histórico sempre gravado.

## 3. Modelo de dados

```
products        (id, slug UNIQUE, name, active, created_at, updated_at)
funnels         (id, product_id FK, slug, name, active, UNIQUE(product_id, slug))
affiliates      (id, external_ref UNIQUE, name NULL, created_at)
call_centers    (id, slug UNIQUE, name, weight > 0, active, created_at, updated_at)
dispatcher_state(id = 1 CHECK, cursor bigint, config_version int, updated_at)   -- linha única
leads           (id uuidv7, name, email, phone, product_id FK, funnel_id FK, affiliate_id FK NULL,
                 source, campaign, utm_source, utm_medium, utm_campaign, utm_content, utm_term,
                 status lead_status, status_changed_at,
                 distribution_status (pending|distributed|failed), call_center_id FK NULL, distributed_at,
                 idempotency_key UNIQUE, request_hash, created_at, updated_at)
distributions   (id, lead_id FK UNIQUE, call_center_id FK, cursor, config_version, created_at)
lead_events     (id, lead_id FK, origin (system|webhook|operator), call_center_id NULL, actor_user_id NULL,
                 dedup_key, external_id NULL, from_status, to_status, occurred_at, received_at,
                 applied bool, rejection_reason NULL, payload jsonb, UNIQUE(lead_id, dedup_key))
outbox_events   (id bigint identity, type, aggregate_id, payload jsonb, created_at,
                 available_at, published_at NULL, attempts, last_error NULL)
users           (id, email UNIQUE, password_hash, role (admin|operator), call_center_id FK NULL,
                 failed_logins, locked_until, CHECK(role = 'operator' ⇔ call_center_id IS NOT NULL))
sessions        (token_hash PK, user_id FK, expires_at, created_at)
```

- **IDs:** `uuidv7()` nativo do PG 18. Ordenados no tempo (inserção no fim da B-tree, sem a fragmentação do UUIDv4) e não enumeráveis.
- **Integridade:** FKs com `ON DELETE RESTRICT` em tudo que tem histórico (lead, call center, produto). Exclusão é lógica (`active = false`). Lead não é apagado; retenção/anonimização é tratada em [`security.md`](security.md).
- **Denormalização intencional:** `leads.call_center_id` e `leads.status` são o estado atual. `distributions` e `lead_events` são o histórico. Toda listagem filtra pelo estado atual sem join com o histórico.
- **`dispatcher_state` em linha única:** guarda o cursor gap-free e a versão da configuração. Detalhes em [ADR-0003](decisions/0003-weighted-dispatch-and-concurrency.md).

## 4. Índices

| Índice                                                                                                                                                                   | Consulta otimizada                                                           |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------- |
| `leads(created_at DESC, id DESC)`                                                                                                                                        | listagem padrão (paginação keyset), "leads hoje", filtro por período         |
| `leads(call_center_id, created_at DESC, id DESC)`                                                                                                                        | listagem do OPERATOR (sempre escopada) e filtro por call center              |
| `leads(status, created_at DESC)`                                                                                                                                         | contagem de vendas, filtro por status                                        |
| `leads(product_id, funnel_id, created_at DESC)`                                                                                                                          | filtro por produto/funil                                                     |
| `leads(created_at) WHERE distribution_status <> 'distributed'` (parcial)                                                                                                 | métrica "pendentes" e reconciliação de leads presos; o índice fica minúsculo |
| `outbox_events(id) WHERE published_at IS NULL` (parcial)                                                                                                                 | o polling do relay lê só os pendentes                                        |
| `lead_events(lead_id, occurred_at)`                                                                                                                                      | histórico de um lead                                                         |
| UNIQUE: `leads(idempotency_key)`, `lead_events(lead_id, dedup_key)`, `distributions(lead_id)`, `funnels(product_id, slug)`, `products(slug)`, `affiliates(external_ref)` | idempotência e resolução na ingestão                                         |

Sem índice em `source`/`utm_*`: a seletividade é baixa, e esses filtros sempre vêm combinados com o intervalo de `created_at`.

## 5. Riscos técnicos e mitigação

| Risco                                                                | Onde         | Mitigação                                                                                                                       |
| -------------------------------------------------------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| Corrida ler-e-atualizar na distribuição                              | worker       | Cursor incrementado com `UPDATE ... RETURNING` sob row lock. A fila **não** resolve isso, porque N workers consomem em paralelo |
| Distribuição duplicada (retry, reentrega do job, relay republicando) | worker       | `FOR UPDATE` no lead + checagem de `distribution_status` + `UNIQUE(distributions.lead_id)`                                      |
| Lead gravado mas job nunca publicado (crash entre DB e Redis)        | api          | Transactional outbox: lead e evento na mesma transação                                                                          |
| Publicação duplicada (relay cai depois do `add` e antes do commit)   | worker       | Entrega _at-least-once_ + `jobId` determinístico + consumidor idempotente                                                       |
| Redis perde dados (restart sem persistência)                         | infra        | AOF habilitado. O outbox mantém o histórico de publicação, e a reconciliação republica leads `pending` antigos                  |
| Deadlock                                                             | worker/admin | Ordem fixa de locks: lead → `dispatcher_state`. A mudança de config trava só `dispatcher_state`                                 |
| Contenção no `dispatcher_state`                                      | worker       | Transação curta (~ms). O teto é medido e documentado em `scalability.md`, não presumido                                         |
| Webhook duplicado / fora de ordem / forjado                          | api          | dedup_key único, `occurred_at` vs `status_changed_at` + máquina de estados, HMAC + janela de timestamp                          |
| OPERATOR acessando lead alheio                                       | api          | Escopo aplicado no service a partir da sessão; 404 para lead de outro call center                                               |

## 6. Estrutura do repositório

```
apps/backend/
  prisma/              schema.prisma, migrations/, seed.ts
  src/
    api.ts             entrypoint HTTP
    worker.ts          entrypoint worker (relay + consumer)
    config/            env validado com Zod
    domain/            regras puras: lead-status, weighted-schedule, idempotency
    modules/
      leads/           routes, service, repository
      dispatch/        service (distribuição), queue
      outbox/          relay
      webhooks/        hmac, routes, service
      auth/            sessão, senha, guards
      admin/           config do dispatcher
    infra/             prisma client, redis, logger, errors
  test/
    unit/  integration/
apps/web/              Next.js
packages/contracts/    schemas Zod compartilhados (lead, webhook, enums, filtros)
docs/
```
