# Checklist de requisitos

Estado na entrega (26/10/2026). Legenda: ⬜ pendente · 🟨 em andamento · ✅ feito e testado · ⚠️ parcial (ver limitações)

| §   | Requisito                                                                                             | Status | Onde / evidência                                                      |
| --- | ----------------------------------------------------------------------------------------------------- | ------ | --------------------------------------------------------------------- |
| 5   | Frontend → Backend → Database                                                                         | ✅ | `apps/web`, `apps/backend`, PostgreSQL |
| 5   | Componentes extras justificados no README                                                             | ✅ | README §3 ("Por que fila e worker"), ADR-0002 |
| 6   | `POST /api/leads`: valida, armazena, ID único, created_at, produto/funil, origem, HTTP adequado       | ✅ | `modules/leads/`, `leads-api.test.ts` |
| 7   | Validação: nome, e-mail, telefone, produto existente, funil válido, UTM, tipos; erros e status claros | ✅ | `packages/contracts/src/lead.ts`, `lead-validation.test.ts`, `leads-api.test.ts` |
| 8   | Idempotência / duplicidade + explicação                                                               | ✅ | ADR-0004; testes de replay, 409 e 25 requisições simultâneas |
| 9   | Entidades: Lead, Product, Funnel, Affiliate, Call Center, Distribution, Lead Status (+ histórico)     | ✅     | `prisma/schema.prisma`, `test/integration/schema-constraints.test.ts` |
| 9   | Migrations versionadas                                                                                | ✅     | `prisma/migrations/`, serviço `migrate`                               |
| 10  | Índices justificados                                                                                  | ✅ | README §5, `architecture.md` §4 |
| 11  | Escalabilidade 100k → 1M → 10M (explicação)                                                           | ✅ | README §7, `docs/scalability.md` |
| 12  | Dispatcher ponderado 50/30/20 + registro + explicação                                                 | ✅ | ADR-0003, `modules/dispatch/`, `distribution-service.test.ts` |
| 13  | Concorrência (100 leads simultâneos) + explicação                                                     | ✅ | ADR-0003; `distribution-pipeline.test.ts` (100 HTTP + 4 workers × 10) |
| 14  | `POST /api/webhooks/callcenter`: localiza, atualiza, registra evento, histórico                       | ✅ | `modules/webhooks/`, `modules/status/`, `webhook-api.test.ts` |
| 15  | Webhook duplicado                                                                                     | ✅ | ADR-0005; `UNIQUE(lead_id, dedup_key)`; testes de duplicado e de 15 webhooks concorrentes |
| 16  | Eventos fora de ordem                                                                                 | ✅ | ADR-0005; `domain/lead-status.ts`; testes stale e invalid_transition |
| 17  | Segurança do webhook                                                                                  | ✅ | ADR-0005; `webhooks/signature.ts` (HMAC + janela anti-replay); 14 testes unitários + integração |
| 18  | Dashboard: total, hoje, distribuídos, pendentes, vendas, conversão + tabela                           | ✅ | `apps/web/src/app/page.tsx`, `GET /api/leads/metrics` |
| 19  | Filtros (período, produto, funil, origem, call center, status) + paginação                            | ✅ | filtros na URL + paginação keyset (`GET /api/leads`) |
| 20  | Auth com ADMIN e OPERATOR                                                                             | ✅ | ADR-0006, `modules/auth/`, `auth-and-access.test.ts` |
| 21  | Autorização no backend                                                                                | ✅ | guards no backend; testes de 403/404 por requisição direta à API |
| 22  | Segurança: authn, authz, SQLi, XSS, CSRF, brute force, rate limit, dados sensíveis, input, webhook    | ✅ | `docs/security.md` (ameaça → medida → teste) |
| 23  | Testes unitários: validação, distribuição, status                                                     | ✅     | `test/unit/` (64 testes)                                              |
| 23  | Testes de integração: leads, webhook                                                                  | ✅ | `leads-api.test.ts`, `webhook-api.test.ts` |
| 23  | Teste de concorrência                                                                                 | ✅ | `distribution-service.test.ts`, `distribution-pipeline.test.ts` |
| 24  | `docker compose up` (web, api, worker, db, redis)                                                     | ✅ | `docker compose up --build` (web, api, worker, postgres, redis, migrate) validado do zero |
| 25  | Commits incrementais, artefatos de IA no repo, sem reescrever histórico                               | ✅ | histórico incremental, `CLAUDE.md`, `docs/`, `docs/AI_LOG.md` |
| 26  | README completo (instalação, arquitetura, decisões, segurança, escala, limitações, melhorias, IA)     | ✅ | `README.md` |
| —   | Transactional outbox + relay recuperável                                                              | ✅ | ADR-0002, `outbox-relay.ts`, `reconciler.ts`, testes de falha do transporte |
| —   | OpenAPI/Swagger                                                                                       | ✅ | `/api/docs` (gerado dos schemas Zod) |
