# CLAUDE.md — Elevate Lead Dispatcher

Instruções para agentes de IA neste repositório. Fonte da verdade da arquitetura: `docs/PLAN.md`.

## Contexto
Teste técnico (Full Stack Sênior, Grupo Elevate). O núcleo avaliado: recebimento de leads,
modelagem, dispatcher com concorrência e webhook do call center. Profundidade > abrangência.

## Regras de trabalho
- Trabalhe por fase (`docs/PLAN.md` §8). Não avance de fase sem testes verdes e revisão humana.
- Toda decisão não trivial vai para `docs/PLAN.md` (com alternativa descartada) e, se a IA sugeriu algo rejeitado, para `docs/AI_LOG.md`.
- Commits pequenos e em Conventional Commits (`feat(scope):`, `fix:`, `test:`, `docs:`, `chore:`). Nunca reescrever histórico.
- Não adicione dependência, serviço ou camada sem justificativa escrita.

## Convenções de código
- TypeScript strict. Sem `any`. Sem `as` para silenciar o compilador.
- Código e identificadores em inglês; documentação em português.
- Camadas: `routes` (HTTP, validação, authz) → `service` (casos de uso, transações) → `repository` (SQL).
- Regras de negócio puras ficam em `apps/api/src/domain/`, sem I/O.
- Schemas de entrada/saída vêm de `packages/contracts` (Zod). Nunca duplicar validação.
- SQL sempre parametrizado (Drizzle ou template `sql`). Nunca concatenar strings.
- Escopo de OPERATOR é aplicado no backend (service/repository), nunca confiando em parâmetro do cliente.
- Erros: lançar erros de domínio tipados; o handler global mapeia para HTTP. Nunca vazar stack/SQL na resposta.
- Logs via pino; e-mail, telefone, senha, cookies e assinaturas são redigidos.

## Testes
- Vitest. Integração contra Postgres real (Testcontainers), nunca mock de banco.
- Toda regra de negócio crítica tem teste: validação, WRR, máquina de estados, idempotência, HMAC, autorização, concorrência.
- `pnpm test` precisa passar antes de cada commit.

## Comandos
- `docker compose up` — sobe tudo (db, migrate, api, web)
- `pnpm test` — todos os testes
- `pnpm --filter api db:generate` — gera migration a partir do schema
