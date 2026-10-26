# Elevate Lead Dispatcher

Recebe leads de páginas de venda, distribui entre call centers por peso (50/30/20) com garantia de
consistência sob concorrência, recebe atualizações de status dos call centers por webhook assinado e
oferece um painel com perfis ADMIN e OPERATOR.

**Stack:** Node.js 24 · TypeScript · Fastify 5 · PostgreSQL 18 · Prisma 7 · Redis 8 + BullMQ · Next.js 16 ·
Tailwind 4 · Zod · Vitest + Testcontainers · Docker Compose.

| Documento | Conteúdo |
|---|---|
| [`docs/architecture.md`](docs/architecture.md) | Componentes, fluxo completo de um lead, modelo de dados, índices, riscos |
| [`docs/decisions/`](docs/decisions/) | ADRs: stack, outbox, dispatcher/concorrência, idempotência, webhook, autenticação |
| [`docs/security.md`](docs/security.md) | Ameaças → medidas → testes |
| [`docs/scalability.md`](docs/scalability.md) | Medições, 100k → 10M, como escalar cada componente |
| [`docs/requirements-checklist.md`](docs/requirements-checklist.md) | Cada requisito do enunciado e onde está implementado/testado |
| [`docs/AI_LOG.md`](docs/AI_LOG.md) | Como a IA foi usada, etapa por etapa |

---

## 1. Como executar

Pré-requisito: Docker com Compose v2.

```bash
docker compose up --build
```

Sobe 5 serviços e um job de migração: `postgres`, `redis`, `migrate` (aplica as migrations e o seed de
demonstração e encerra), `api`, `worker` e `web`. Na primeira vez o build leva alguns minutos.

| URL | O quê |
|---|---|
| http://localhost:3000 | Dashboard |
| http://localhost:3001/api/docs | OpenAPI / Swagger UI |
| http://localhost:3001/health/ready | Readiness da API |

**Usuários de demonstração** (criados pelo seed; não são credenciais reais):

| Perfil | E-mail | Senha |
|---|---|---|
| ADMIN | `admin@elevate.local` | `Elevate-Admin-2026` |
| OPERATOR (Call Center A/B/C) | `operator.a@elevate.local`, `operator.b@…`, `operator.c@…` | `Elevate-Operator-2026` |

Catálogo do seed: produtos `nutralean` (funis `vsl-01`, `vsl-02`, `quiz-01`), `glucoshield` (`vsl-01`, `tsl-01`)
e `prostavive` (`vsl-01`); call centers A/B/C com pesos 50/30/20.

### Enviar um lead

```bash
curl -i http://localhost:3000/api/leads -H 'content-type: application/json' -d '{
  "name": "João Silva", "email": "joao@email.com", "phone": "+5511999999999",
  "product": "nutralean", "funnel": "vsl-01", "source": "facebook",
  "campaign": "campaign-123", "affiliate_id": "999",
  "utm": { "source": "facebook", "medium": "cpc", "campaign": "campaign-123", "content": "ad-01" }
}'
# 201 {"success":true,"lead_id":"…","duplicate":false,"distribution_status":"pending"}
# Repetir o mesmo comando → 200 com o mesmo lead_id e "duplicate": true
```

### Simular o webhook do call center (assinatura HMAC)

O lead precisa ter sido distribuído para o call center que assina (veja a coluna "Call center" no dashboard).

```bash
LEAD_ID=<id do lead>      CC=callcenter-a      SECRET=dev-secret-a-0123456789abcdef0123456789
TS=$(date +%s)
BODY="{\"lead_id\":\"$LEAD_ID\",\"external_id\":\"abc123\",\"status\":\"contacted\",\"timestamp\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"}"
SIG=$(printf '%s' "$TS.$BODY" | openssl dgst -sha256 -hmac "$SECRET" | sed 's/^.*= //')
curl -i http://localhost:3000/api/webhooks/callcenter -H 'content-type: application/json' \
  -H "x-callcenter-id: $CC" -H "x-signature: t=$TS,v1=$SIG" -d "$BODY"
```

Os segredos de demonstração dos call centers B e C seguem o mesmo padrão (`dev-secret-b-…`, `dev-secret-c-…`;
ver `docker-compose.yml`).

Respostas esperadas ao repetir o exemplo:
- **mesmo comando, mesmo `TS`** → `"duplicate": true` (evento já recebido, nada muda);
- **comando gerado de novo** (novo `TS`) com o mesmo status → `"applied": false, "reason": "invalid_transition"`,
  porque `contacted → contacted` não é uma transição permitida. Troque o status (`qualified`, `sale`…) para avançar;
- **status com timestamp anterior ao atual** → `"applied": false, "reason": "stale"` (evento fora de ordem, registrado
  no histórico sem alterar o lead).

### Escalar workers

```bash
docker compose up --build --scale worker=3
```

A distribuição continua exata com vários workers: a sincronização está no Postgres, não no processo (seção 4.3).

## 2. Como rodar os testes

Pré-requisitos: **Node 24 LTS** (≥ 24.11), pnpm 10 e Docker (os testes de integração sobem Postgres e Redis reais
com Testcontainers; não há mock de banco). Com Node mais antigo, o `pnpm install` para com uma mensagem explicando a
versão exigida (`engine-strict`). O `install` também gera o client do Prisma (`postinstall`).

```bash
pnpm install
pnpm test              # tudo (162 testes)
pnpm test:unit         # só regras puras, sem infraestrutura
pnpm test:integration  # Postgres 18 + Redis 8 reais em containers
pnpm lint && pnpm typecheck
```

| Suíte | O que prova |
|---|---|
| `test/unit/` (80) | Validação do lead, algoritmo de distribuição (SWRR), máquina de estados, chave de idempotência, assinatura HMAC |
| `schema-constraints` | O banco recusa estados impossíveis mesmo com o código errado (gravando linhas inválidas direto) |
| `leads-api` | `POST /api/leads`: validação 400/422, idempotência, 409, **25 requisições idênticas simultâneas → 1 lead** |
| `distribution-service` | **100 distribuições concorrentes → 50/30/20 exato**, cursor sem buracos, config alterada no meio da rajada |
| `distribution-pipeline` | **100 HTTP simultâneos → relay → 4 workers × 10**: 50/30/20 exato; reprocessamento, Redis fora, retries, reconciliação |
| `webhook-api` | HMAC, replay, duplicado, fora de ordem, transição inválida, isolamento entre call centers, 15 webhooks concorrentes |
| `auth-and-access` | Login, bloqueio, rate limit, CSRF, OPERATOR barrado em admin e em lead alheio por requisição direta, filtros, métricas |

### Sem Docker para a aplicação (opcional)

```bash
cp .env.example .env
docker compose up -d postgres redis
pnpm --filter backend exec prisma migrate deploy && pnpm --filter backend exec prisma db seed
pnpm --filter backend dev:api      # terminal 1
pnpm --filter backend dev:worker   # terminal 2
pnpm --filter web dev              # terminal 3 → http://localhost:3000
```

## 3. Arquitetura

```
                 ┌────────────┐   /api/* (proxy)     ┌──────────────┐
  Admin/Operador │  web       │ ───────────────────► │  api         │── rate limit ──► Redis
  (navegador) ──►│  Next.js   │                      │  Fastify     │
                 └────────────┘                      └──────┬───────┘
  Landing page ── POST /api/leads ──────────────────────────┤
  Call center ─── POST /api/webhooks/callcenter (HMAC) ─────┤
                                                            ▼
                                                     ┌──────────────┐        ┌────────┐
                                                     │ PostgreSQL 18│◄──────►│ worker │◄──► Redis (BullMQ)
                                                     └──────────────┘        └────────┘
                                              (fonte da verdade)       relay do outbox + distribuição
```

Monólito modular em TypeScript: `apps/backend` (API e worker, mesmo código e mesma imagem, processos separados),
`apps/web` (Next.js) e `packages/contracts` (schemas Zod usados pelos dois lados). No backend, cada módulo segue
`routes` (HTTP, validação, autorização) → `service` (casos de uso, transações) → `repository` (SQL), e as regras de
negócio puras ficam em `src/domain/`, sem I/O.

### Por que fila e worker (e por que o Redis não é a fonte da verdade)

Não era obrigatório, e o enunciado avisa que complexidade não pontua. O componente se justifica por três problemas
concretos (ADR-0002):
1. **A ingestão é o caminho da receita** e não deve depender de nada além do Postgres. Com o Redis fora do ar, a API
   continua respondendo `201` (validado com o Compose real).
2. A evolução natural da distribuição é **entregar** o lead ao call center (HTTP externo, lento e falível), o que não
   pode ficar dentro da requisição da landing page.
3. Retentativas com backoff e falha definitiva observável já vêm prontas.

A fila **não** é usada para resolver concorrência: a consistência da distribuição é garantida no Postgres.

### Fluxo de um lead, do recebimento ao webhook

1. **Recebimento** — `POST /api/leads`: o Zod valida e normaliza; produto e funil são resolvidos (`422` se
   inválidos). Numa **única transação**: affiliate (upsert), lead (`INSERT … ON CONFLICT (idempotency_key) DO
   NOTHING`), histórico (`new`) e **evento de outbox**. Commit → `201`. Retry → `200` com o mesmo `lead_id`.
2. **Publicação** — o worker roda um relay que lê o outbox (`FOR UPDATE SKIP LOCKED`) e publica no BullMQ; falha
   de publicação → backoff no próprio outbox, nada se perde (transactional outbox).
3. **Distribuição** — um job por lead; vários workers em paralelo. Na transação: trava o lead (já distribuído → no-op),
   incrementa o **cursor global** com `UPDATE … RETURNING` (row lock), escolhe o call center pelo escalonamento
   ponderado e grava `distributions` + `leads.call_center_id`. Falha → retry exponencial (8×); esgotado → `failed`,
   que o ADMIN pode reprocessar.
4. **Reconciliação** — a cada 60 s, re-enfileira leads cujo job o Redis perdeu e marca como `failed` os que falharam
   sem registro.
5. **Atendimento** — o OPERATOR vê só os leads do seu call center e pode mudar o status.
6. **Webhook** — `POST /api/webhooks/callcenter` com HMAC: trava o lead, deduplica o evento, aplica se for mais novo e
   a transição for válida; grava no histórico **sempre** (aplicado, ignorado por ordem ou recusado).

## 4. Decisões técnicas

### 4.1 Duplicidade e idempotência (seção 8) — [ADR-0004](docs/decisions/0004-lead-idempotency.md)
- Header `Idempotency-Key` opcional → chave `client:<key>` (sem prazo). Sem header → chave
  `payload:<dia UTC>:<sha256 do payload normalizado>`: e-mail em minúsculas, telefone em E.164, chaves ordenadas.
- `UNIQUE(idempotency_key)` + `INSERT … ON CONFLICT DO NOTHING`: requisições simultâneas são serializadas pelo
  próprio Postgres; não há janela de "verifica e depois insere". Mesma chave com outro payload → `409`.
- A janela de um dia (decisão de produto): retries de rede viram um lead; a mesma pessoa voltando em outro dia é um
  lead novo (reengajamento).

### 4.2 Dispatcher (seção 12) — [ADR-0003](docs/decisions/0003-weighted-dispatch-and-concurrency.md)
**Smooth weighted round robin** (o algoritmo do nginx): os pesos 50/30/20 geram o escalonamento determinístico
`A B C A A B A C B A`. A cada 10 leads a proporção é **exata**, e o call center mais pesado é intercalado, sem
rajadas. Aleatório ponderado foi descartado: com 100 leads, A poderia receber 42 ou 58, sem como auditar nem testar.

### 4.3 Concorrência (seção 13)
- O estado compartilhado é **um inteiro**, `dispatcher_state.cursor`, incrementado com
  `UPDATE … SET cursor = cursor + 1 RETURNING cursor`. O `UPDATE` é atômico e segura o row lock até o commit: duas
  transações nunca recebem o mesmo valor; não existe "duas leem o mesmo estado e depois atualizam".
- Rollback desfaz o incremento: o cursor não tem buracos. Por isso não usei `SEQUENCE` (não volta em rollback) nem
  `INCR` no Redis (fora da transação do Postgres).
- Idempotência da distribuição: `FOR UPDATE` no lead + `UNIQUE(distributions.lead_id)`.
- Ordem fixa de locks (lead → `dispatcher_state`) contra deadlock. A configuração é lida antes do lock e validada de
  forma otimista por `config_version`, o que mantém a seção crítica em 2 statements + `COMMIT`.
- Limitação aceita: o cursor é global, então a proporção é exata no total, não por produto (ADR-0003).

### 4.4 Webhook (seções 14 a 17) — [ADR-0005](docs/decisions/0005-webhook-security-ordering.md)
- **Segurança:** HMAC-SHA256 por call center sobre `"<timestamp>.<corpo bruto>"`, comparação em tempo constante,
  janela anti-replay de 5 min. API key estática foi descartada: não protege a integridade do corpo nem impede replay.
  A identidade autenticada também autoriza: o call center B não altera um lead do A (`404`).
- **Duplicado:** `UNIQUE(lead_id, dedup_key)`, com a chave derivada de call center, lead, `external_id`, status e
  timestamp normalizado. Duplicado → `200 {"duplicate": true}`, sem efeito.
- **Fora de ordem:** o evento só é aplicado se for **mais novo** que o status atual (`occurred_at >
  status_changed_at`) **e** a transição for permitida pela máquina de estados (`sale` só vai para `refund`; `refund`
  e `invalid` são terminais). Um `contacted` que chega depois de um `sale` mais novo é gravado como
  `applied=false, reason=stale` e o lead continua `sale`. Webhook rejeitado responde `200` (um 4xx faria o parceiro
  reenviar para sempre); para o OPERATOR, a mesma regra responde `422`.

### 4.5 Autenticação e autorização (seções 20 e 21) — [ADR-0006](docs/decisions/0006-authentication-sessions.md)
Sessão opaca em cookie `HttpOnly` + `SameSite=Strict` (revogável, ao contrário de JWT), argon2id, bloqueio por conta
e rate limit por IP. O escopo do OPERATOR vem da sessão e é aplicado na própria query; o frontend só esconde menus.

## 5. Banco de dados

Entidades: `products`, `funnels`, `affiliates`, `call_centers`, `leads`, `distributions`, `lead_events` (histórico
de status, append-only), `lead_status` (enum), `dispatcher_state`, `outbox_events`, `users`, `sessions`.
Migrations versionadas em `apps/backend/prisma/migrations/`, com o SQL revisado e complementado à mão.

- **Integridade no banco, não só no código:** FK composta `leads(funnel_id, product_id) → funnels(id, product_id)`
  (o funil precisa ser do produto), `CHECK`s (lead distribuído ⇔ tem call center; evento rejeitado ⇔ tem motivo;
  operador ⇔ tem call center; peso > 0; `dispatcher_state` com linha única) e `ON DELETE RESTRICT` (exclusão lógica
  com `active = false`, a auditoria nunca é apagada em cascata).
- **IDs `uuidv7()`** (nativo no PG 18): ordenados no tempo, as inserções caem no fim da B-tree e os IDs não são
  enumeráveis.
- **Estado atual vs. histórico:** `leads.status` e `leads.call_center_id` são o estado atual (consulta quente do
  dashboard, sem join); `lead_events` e `distributions` são a auditoria.

### Índices (seção 10)

| Índice | Consulta otimizada |
|---|---|
| `leads(created_at DESC, id DESC)` | listagem padrão com paginação keyset, "leads hoje", filtro por período |
| `leads(call_center_id, created_at DESC, id DESC)` | listagem do OPERATOR (sempre escopada), filtro e total por call center |
| `leads(status, created_at DESC)` | vendas, filtro por status |
| `leads(product_id, funnel_id, created_at DESC)` | filtro por produto/funil |
| `leads(created_at) WHERE distribution_status <> 'distributed'` (parcial) | pendentes/falhos e reconciliação; minúsculo em regime normal |
| `outbox_events(id) WHERE published_at IS NULL` (parcial) | polling do relay |
| `outbox_events(aggregate_id, id DESC)` | reconciliação: último evento de outbox de um lead |
| `lead_events(lead_id, occurred_at)` | histórico de um lead |
| UNIQUE `leads(idempotency_key)`, `lead_events(lead_id, dedup_key)`, `distributions(lead_id)`, `funnels(product_id, slug)` | idempotência e deduplicação (também servem de índice) |

Sem índice em `source` e UTMs (baixa seletividade, sempre combinados com o período) nem em
`distributions(call_center_id)` (os totais saem de `leads`).

## 6. Segurança

Detalhes e a verificação de cada item em [`docs/security.md`](docs/security.md). Resumo: argon2id; sessão opaca
com só o hash no banco; bloqueio por conta + rate limit por IP; autorização no backend com escopo vindo da sessão;
SQL 100% parametrizado; React sem HTML cru; CSRF por `SameSite=Strict` + JSON obrigatório + checagem de `Origin`;
webhook com HMAC, anti-replay e dedup; rate limit na ingestão e no webhook; Zod em toda entrada; redaction de PII
nos logs; erros sem detalhes internos; segredos só por variável de ambiente.

## 7. Escalabilidade

Resumo de [`docs/scalability.md`](docs/scalability.md):
- **100k → 1M:** o modelo atende como está. Paginação keyset (custo constante em qualquer página), índices compostos
  terminando em `created_at`, inserções no fim da B-tree com `uuidv7`.
- **10M+:** particionar `leads` e `lead_events` por mês (`RANGE(created_at)`), métricas a partir de uma tabela de
  rollup diária em vez de `COUNT` ao vivo, réplica de leitura para o dashboard, PgBouncer.
- **Tráfego:** API sem estado (réplicas atrás de load balancer); workers escalam horizontalmente; um pico de entrada
  vira fila, não erro. O teto da distribuição é a seção crítica do cursor, medida em ~3 ms nesta máquina de
  desenvolvimento (não é benchmark de produção). Se virar gargalo: um cursor por produto ou blocos de cursor por worker.

## 8. Limitações

O que ficou de fora ou tem ressalva, por prioridade e tempo:
- **Testes:** os 4 workers do teste de concorrência rodam num único processo Node (as garantias estão no Postgres e
  valem entre processos, mas multi-processo só foi verificado manualmente com o Compose). Queda abrupta no meio de uma
  transação não é testada. O teste automatizado de "Redis fora" usa injeção de falha; o Redis real parado foi validado
  manualmente. **Intermitência conhecida:** em ~2 de ~14 execuções completas da suíte, o teste "ignores reprocessing"
  estourou o tempo esperando `20 leads distributed` (nunca reproduziu isolado). A causa não foi identificada a
  tempo; o teste agora anexa ao erro um retrato do estado (leads por status, outbox, jobs por estado, motivo da
  primeira falha) para a próxima ocorrência ser diagnosticável. Não aumentei o timeout para esconder o problema. Sem testes de
  frontend e sem medição de cobertura.
- **Números de desempenho** vêm de medições pontuais numa máquina de desenvolvimento; não há teste de carga
  sustentada nem script de benchmark versionado.
- **Proporção por produto:** o cursor global garante 50/30/20 no total; por produto, só na média.
- **Envio real ao call center** não existe: a distribuição é registrada (o enunciado permite).
- **Leads `failed`** não são reprocessados automaticamente (é intencional, mas depende de ação do ADMIN).
- **CORS** para landing pages postando do navegador em outros domínios não foi configurado.
- **Affiliate desconhecido** é criado automaticamente (risco de refs inventadas, mitigado por rate limit).
- **Auditoria de configuração:** mudanças de pesos ficam no log e em `config_version`, sem uma tabela de histórico.
- Sem CSP no dashboard, sem política de retenção/anonimização de dados pessoais (LGPD) e sem rotação de segredos HMAC.

## 9. Melhorias futuras

1. Script de carga reproduzível (`--scale worker=N`, números versionados) e teste multi-processo automatizado.
2. Entrega real ao call center (HTTP com retry e circuit breaker), aproveitando o worker existente.
3. Cursor por produto, se o negócio exigir justiça de mix por produto (também remove o ponto único de serialização).
4. Tabela de auditoria de mudanças do dispatcher; reprocessamento em lote de `failed`.
5. `LISTEN/NOTIFY` no relay para latência abaixo de 500 ms.
6. Particionamento + rollups de métricas quando o volume justificar (gatilhos em `docs/scalability.md`).
7. Observabilidade: métricas (idade do backlog, outbox não publicado, `failed`, tempo da seção crítica), tracing.
8. CORS por origem, CSP com nonce, rotação de segredos HMAC com dois segredos ativos, retenção LGPD.
9. Testes E2E do frontend (Playwright).

## 10. Como usei IA

Ferramenta: **Claude Code** (modelo Claude Opus), no VS Code. O registro completo, etapa por etapa, está em
[`docs/AI_LOG.md`](docs/AI_LOG.md); as instruções dadas à IA estão em [`CLAUDE.md`](CLAUDE.md); os planos e
decisões em `docs/`.

- **Como dividi o problema:** em etapas (planejamento → fundação → núcleo → webhook → autenticação → frontend →
  documentação), cada uma terminando com testes verdes e commits feitos por mim, revisando o que entrava.
- **O que deleguei:** a escrita do código, dos testes e o primeiro rascunho dos documentos.
- **O que decidi:** a stack (troquei a proposta inicial da IA: Drizzle, Vite e distribuição síncrona, por Prisma,
  Next.js, BullMQ e outbox), e numa revisão guiada do código: janela de deduplicação de um dia, cursor global,
  reprocessamento manual de `failed`, affiliate automático, enum para status, telefone em E.164.
- **O que a IA errou e foi corrigido:** validação de e-mail que rejeitava espaços (pego por teste); ferramenta de lint
  que desligou todas as regras ao migrar a config; formatter que quebrou Markdown; `jobId` que faria a fila ignorar
  reenvios legítimos; uma falha de reconciliação que deixava leads presos em `pending` (com teste de regressão
  comprovando a falha antes da correção); senhas de demonstração com `#` cortadas pelo parser de `.env`; hipótese de
  desempenho refutada por medição.
- **Como validei:** testes com Postgres e Redis reais (sem mock de banco), execuções repetidas para pegar
  intermitência, testes de regressão que falham sem a correção, e validação manual do Compose subindo do zero.
