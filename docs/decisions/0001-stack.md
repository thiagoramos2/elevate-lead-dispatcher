# ADR-0001 — Stack

**Status:** aceito · **Data:** 2026-10-23

## Contexto
O enunciado deixa a stack livre, mas exige justificativa. A vaga pede Node.js/TypeScript, React/Next.js, PostgreSQL e Redis.

## Decisão
| Camada | Escolha | Motivo |
|---|---|---|
| Runtime | Node 22 LTS, TypeScript 6.0 strict | TS 7 (port nativo) ainda não tem a API programática estável que Next/Vitest/Prisma usam |
| HTTP | Fastify 5 | Schemas por rota, pino integrado, `inject()` para testes, ecossistema (helmet, rate-limit, cookie, swagger) |
| Validação | Zod 4 em `packages/contracts` | Um único schema valida a API, gera o OpenAPI e tipa o frontend |
| ORM/migrations | Prisma 7.10 (driver adapter `pg`) | Migrations SQL versionadas e revisáveis, client tipado. Locks e SQL avançado via `$queryRaw` parametrizado |
| Banco | PostgreSQL 18 | `uuidv7()` nativo, `FOR UPDATE SKIP LOCKED`, índices parciais |
| Fila | Redis 8 + BullMQ | Retry/backoff/DLQ prontos, workers escaláveis. Ver ADR-0002 |
| Frontend | Next.js 16 (App Router) + Tailwind 4 | Stack da vaga. `rewrites` fazem o proxy de `/api` e mantêm o cookie no mesmo origin |
| Testes | Vitest + Testcontainers (Postgres e Redis reais) | Concorrência e locks não são testáveis com mocks |
| Lint/format | Biome | Uma ferramenta só |

## Alternativas consideradas
- **Drizzle/Kysely** (proposta da revisão 1): SQL mais explícito. Escolhemos Prisma pela familiaridade do time e por migrations maduras. Custo aceito: locks e upserts condicionais ficam em `$queryRaw`.
- **Vite SPA** (proposta da revisão 1): mais simples para um painel autenticado. Escolhemos Next.js por ser a stack da vaga; usamos majoritariamente client components com TanStack Query.
- **Prisma 8**: no `latest` do npm há uma RC, que não é estável.

## Consequências
- Queries com `FOR UPDATE`, `SKIP LOCKED` e `ON CONFLICT ... RETURNING` ficam em SQL tipado à mão, isolado nos repositórios.
- Índices parciais e `uuidv7()` são escritos à mão no SQL da migration (`prisma migrate dev --create-only`).
