# Log de uso de IA

Registro do que foi delegado à IA, o que ela sugeriu, o que foi rejeitado ou corrigido e como foi validado.
Alimenta a seção "Como usei IA" do README.

Ferramenta: Claude Code (Claude Opus), no VS Code.

## Fase 0: planejamento inicial (revisão 1)
- **Contexto fornecido:** enunciado completo (PDF), descrição da vaga, instruções globais de padrão de engenharia.
- **Delegado:** primeiro rascunho da arquitetura, do modelo de dados e das estratégias de concorrência/idempotência.
- **IA sugeriu:** Drizzle, SPA com Vite, sem Redis, distribuição síncrona na transação do lead, cursor via `nextval()`.

## Etapa 1: redefinição da stack e da arquitetura (revisão 2)
- **Decisão humana:** troquei a stack proposta. Prisma, Next.js + Tailwind, Redis + BullMQ com worker separado, transactional outbox, OpenAPI.
  Motivo: alinhamento com a stack da vaga e desacoplar a ingestão da distribuição (preparando a entrega real ao call center).
- **Exigências que impus à IA:** não tratar a fila como solução de concorrência; não afirmar garantias que o BullMQ não dá;
  documentar falhas de Redis/Postgres; testes com infraestrutura real.
- **Mudança de design decorrente:** o cursor via `nextval()` (rev. 1) deixou de servir. Com retries assíncronos,
  rollbacks são frequentes e a sequence deixaria buracos, desviando a proporção. Passou a ser `UPDATE ... RETURNING`
  numa linha travada, que é gap-free (ADR-0003).
- **Validação de versões:** a IA consultou o npm. A tag `latest` do Prisma aponta para uma RC da 8, então fixei a 7.10.1.
  O TypeScript 7 (port nativo) foi evitado por falta de API estável para o tooling.

<!-- Formato:
## Etapa N: título
- Delegado:
- IA sugeriu / errou:
- Rejeitei / corrigi porque:
- Validado com:
-->
