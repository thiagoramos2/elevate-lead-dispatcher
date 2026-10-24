# CLAUDE.md — Elevate Lead Dispatcher

Instruções para agentes de IA neste repositório.
Arquitetura: `docs/architecture.md`. Decisões: `docs/decisions/`. Progresso: `docs/requirements-checklist.md`.

## Contexto

Teste técnico (Full Stack Sênior, Grupo Elevate). Núcleo avaliado: recebimento de leads, modelagem,
dispatcher com concorrência e webhook do call center. Correção > consistência > integridade > segurança > testes > resto.

## Arquitetura em uma frase

A API grava lead + outbox numa transação (só Postgres). O worker publica o outbox no BullMQ e distribui
cada lead com smooth WRR indexado por um cursor gap-free travado no Postgres. O webhook aplica eventos
autenticados por HMAC com dedup e regras de ordenação.

## Regras de trabalho

- Trabalhe por etapa. Não avance sem testes verdes; reporte resultados reais, nunca presumidos.
- Decisão relevante → ADR em `docs/decisions/` com as alternativas descartadas.
- Sugestão da IA rejeitada/corrigida pelo humano → `docs/AI_LOG.md`.
- Atualize `docs/requirements-checklist.md` ao concluir um item.
- Conventional Commits, pequenos. Nunca reescrever histórico nem rodar comando destrutivo sem autorização.
- Nenhuma dependência, serviço ou camada nova sem justificativa escrita.

## Invariantes que não podem quebrar

- O lead é persistido (com o evento de outbox, na mesma transação) antes do `201`.
- A API não publica no Redis. Só o relay do worker publica.
- A distribuição é idempotente: `FOR UPDATE` no lead + `UNIQUE(distributions.lead_id)`.
- Ordem de locks: `leads` → `dispatcher_state`. Nunca o inverso.
- Escopo de OPERATOR vem da sessão, aplicado no service. Lead fora do escopo → 404.
- Webhook: corpo bruto para o HMAC, `timingSafeEqual`, todo evento é gravado (aplicado ou não).

## Convenções de código

- TypeScript strict. Sem `any`, sem `as` para calar o compilador.
- Código em inglês; documentação em português.
- `routes` (HTTP, validação, authz) → `service` (casos de uso, transação) → `repository` (SQL).
- Regras puras em `apps/backend/src/domain/` (sem I/O).
- Schemas Zod em `packages/contracts`; nunca duplicar validação.
- SQL cru só via `$queryRaw` com template tag (parametrizado). Nunca `$queryRawUnsafe` com input.
- Erros de domínio tipados (`AppError`) → handler global → HTTP. Nunca vazar stack/SQL.
- Logs pino com redaction de e-mail, telefone, senha, cookie, assinatura.

## Testes

- Vitest. `test/unit` sem infraestrutura; `test/integration` com Postgres e Redis reais (Testcontainers).
- Proibido mockar o banco para provar consistência transacional.

## Comandos

- `docker compose up --build` — sobe web, api, worker, postgres, redis (migrations + seed automáticos)
- `pnpm install` / `pnpm test` / `pnpm test:unit` / `pnpm test:integration` / `pnpm lint`
- `pnpm --filter backend prisma migrate dev --create-only --name <nome>` — nova migration (revisar o SQL!)
