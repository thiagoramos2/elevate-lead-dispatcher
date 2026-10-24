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

## Etapa 2: fundação (monorepo, schema, migrations, seed, testes)

- **Delegado:** estrutura do monorepo, schema Prisma, migration inicial, seed, setup de testes com Testcontainers,
  regras puras de domínio (SWRR, máquina de estados, idempotência) e seus testes unitários.
- **Origem dos itens abaixo:** detectados e corrigidos pela própria IA durante a revisão (SQL gerado, testes, lint).
  Revisão humana da etapa: _pendente; anotar aqui o que for alterado ou rejeitado_.
- **Revisão do SQL gerado pelo Prisma** (`--create-only` antes de aplicar). Faltavam:
  FK em `lead_events.call_center_id`/`actor_user_id`; garantia de que o funil pertence ao produto
  (resolvida com FK composta `leads(funnel_id, product_id) → funnels(id, product_id)`); `CHECK`s de consistência
  (peso > 0, linha única no `dispatcher_state`, `distributed ⇔ call_center_id`, `applied ⇔ sem motivo`, papel ⇔ call center);
  índices parciais. Adicionados à mão e confirmado com `prisma migrate diff` que o Prisma não gera drift sobre eles.
- **Índice removido:** o primeiro schema tinha `distributions(call_center_id, created_at)`. Removido porque nenhuma consulta o usa
  (o relatório por call center sai de `leads`, que já tem esse índice).
- **Bug pego por teste:** `z.email().trim()` valida o formato _antes_ do trim, então `" Joao@Email.COM "` era rejeitado.
  Corrigido para normalizar e só então validar (`z.string().trim().toLowerCase().pipe(z.email())`).
- **Ferramenta errou:** `biome migrate` converteu `recommended: true` em `preset: "none"`, desligando todo o lint.
  Revertido para `preset: "recommended"`.
- **Runtime:** o Testcontainers 12 depende do undici 8, que exige Node ≥ 22.19 (zstd). Em vez de fazer downgrade de
  biblioteca, padronizei no Node 24 LTS (engines, `.nvmrc`, imagens Docker).
- **Validado com:** 64 testes unitários + 9 de integração (constraints provadas escrevendo linhas inválidas direto no
  banco), `tsc --noEmit`, Biome, e `migrate` + seed do zero num projeto Compose isolado.

## Etapa 3: núcleo (ingestão, outbox, relay, worker, dispatcher)

- **Delegado:** `POST /api/leads` com idempotência, transactional outbox, relay, worker BullMQ, dispatcher com lock no
  Postgres, reconciliação, testes de integração e de concorrência.
- **Origem dos itens abaixo:** detectados pela IA durante a implementação e a revisão (medições, testes, leitura do
  código-fonte das dependências). Revisão humana da etapa: _pendente; anotar aqui o que for alterado ou rejeitado_.
- **Hipótese corrigida por medição:** o teste de 100 distribuições concorrentes falhou com
  `Unable to start a transaction in the given time` (o `maxWait` padrão de 2 s do Prisma). A primeira hipótese foi a
  seção crítica longa demais. Encurtá-la (configuração lida antes do lock com checagem otimista por `config_version`,
  escrita num único CTE) ajudou pouco: de ~1,7 s para ~1,5 s. A medição de controle (100 transações **sem lock**:
  1,17 s) mostrou que ~78% do tempo era custo do cliente, não contenção. Decisões: manter a seção crítica curta (é o
  que limita a escala com vários processos), configurar `maxWait`/`timeout` explicitamente com justificativa, e
  registrar os números em `scalability.md` em vez de afirmar capacidade.
- **Design do plano corrigido:** o plano dizia `jobId = lead_id`. Com `removeOnFail` de 7 dias, um job antigo em
  `failed` faria o BullMQ ignorar o reenfileiramento da reconciliação. Passou a ser um id por evento de outbox. A IA
  também verificou no código do BullMQ 6 que ids customizados não podem conter `:`.
- **Ferramenta errou de novo:** o formatter de Markdown do Biome quebrou listas aninhadas no `architecture.md`
  (já commitado em `029a90b`). Markdown foi excluído do Biome e a seção foi reescrita.
- **Teste reescrito:** um teste de `Idempotency-Key` gerado com um cast forçado (`as unknown as`) para ler o corpo da
  requisição foi substituído por duas asserções diretas.
- **Validado com:** 107 testes (64 unitários + 43 de integração) em 3 execuções seguidas sem intermitência;
  `docker compose up` real com `curl` (201 → 200 replay → 400); Redis parado durante a ingestão (API seguiu com `201`,
  leads distribuídos sozinhos quando o Redis voltou).

<!-- Formato:
## Etapa N: título
- Delegado:
- IA sugeriu / errou:
- Rejeitei / corrigi porque:
- Validado com:
-->
