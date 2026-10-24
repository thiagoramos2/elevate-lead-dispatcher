# Checklist de requisitos

Legenda: ⬜ pendente · 🟨 em andamento · ✅ feito e testado · ⚠️ parcial (ver limitações)

| §   | Requisito                                                                                             | Status | Onde / evidência                                                      |
| --- | ----------------------------------------------------------------------------------------------------- | ------ | --------------------------------------------------------------------- |
| 5   | Frontend → Backend → Database                                                                         | ⬜     |                                                                       |
| 5   | Componentes extras justificados no README                                                             | 🟨     | ADR-0002                                                              |
| 6   | `POST /api/leads`: valida, armazena, ID único, created_at, produto/funil, origem, HTTP adequado       | ⬜     |                                                                       |
| 7   | Validação: nome, e-mail, telefone, produto existente, funil válido, UTM, tipos; erros e status claros | ⬜     |                                                                       |
| 8   | Idempotência / duplicidade + explicação                                                               | 🟨     | ADR-0004                                                              |
| 9   | Entidades: Lead, Product, Funnel, Affiliate, Call Center, Distribution, Lead Status (+ histórico)     | ✅     | `prisma/schema.prisma`, `test/integration/schema-constraints.test.ts` |
| 9   | Migrations versionadas                                                                                | ✅     | `prisma/migrations/`, serviço `migrate`                               |
| 10  | Índices justificados                                                                                  | 🟨     | architecture.md §4 (criados; README pendente)                         |
| 11  | Escalabilidade 100k → 1M → 10M (explicação)                                                           | ⬜     | scalability.md                                                        |
| 12  | Dispatcher ponderado 50/30/20 + registro + explicação                                                 | 🟨     | ADR-0003                                                              |
| 13  | Concorrência (100 leads simultâneos) + explicação                                                     | 🟨     | ADR-0003                                                              |
| 14  | `POST /api/webhooks/callcenter`: localiza, atualiza, registra evento, histórico                       | ⬜     |                                                                       |
| 15  | Webhook duplicado                                                                                     | 🟨     | ADR-0005                                                              |
| 16  | Eventos fora de ordem                                                                                 | 🟨     | ADR-0005                                                              |
| 17  | Segurança do webhook                                                                                  | 🟨     | ADR-0005                                                              |
| 18  | Dashboard: total, hoje, distribuídos, pendentes, vendas, conversão + tabela                           | ⬜     |                                                                       |
| 19  | Filtros (período, produto, funil, origem, call center, status) + paginação                            | ⬜     |                                                                       |
| 20  | Auth com ADMIN e OPERATOR                                                                             | ⬜     | ADR-0006                                                              |
| 21  | Autorização no backend                                                                                | ⬜     |                                                                       |
| 22  | Segurança: authn, authz, SQLi, XSS, CSRF, brute force, rate limit, dados sensíveis, input, webhook    | ⬜     | security.md                                                           |
| 23  | Testes unitários: validação, distribuição, status                                                     | ✅     | `test/unit/` (64 testes)                                              |
| 23  | Testes de integração: leads, webhook                                                                  | ⬜     |                                                                       |
| 23  | Teste de concorrência                                                                                 | ⬜     |                                                                       |
| 24  | `docker compose up` (web, api, worker, db, redis)                                                     | 🟨     | db, redis, migrate+seed                                               |
| 25  | Commits incrementais, artefatos de IA no repo, sem reescrever histórico                               | 🟨     | git log, CLAUDE.md, docs/                                             |
| 26  | README completo (instalação, arquitetura, decisões, segurança, escala, limitações, melhorias, IA)     | ⬜     |                                                                       |
| —   | Transactional outbox + relay recuperável                                                              | ⬜     | ADR-0002                                                              |
| —   | OpenAPI/Swagger                                                                                       | ⬜     |                                                                       |
