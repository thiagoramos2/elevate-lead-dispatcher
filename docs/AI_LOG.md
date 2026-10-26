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
  Revisão humana da etapa: Revisei a estrutura inicial do projeto, a modelagem do banco e as regras principais implementadas nesta etapa. Dei atenção especial à integridade dos dados, à normalização dos leads, à distribuição ponderada e à possibilidade de processar eventos repetidos sem gerar inconsistências.
  Entendi que o Redis e o BullMQ são responsáveis por organizar o processamento assíncrono, mas que a consistência da distribuição precisa ser garantida no PostgreSQL. Por isso, considero importante manter as regras críticas no banco, com transações, restrições e mecanismos de sincronização, em vez de depender apenas do comportamento dos workers.

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
  código-fonte das dependências).
- **Revisão humana (revisão guiada das etapas 2 e 3):** percorri o código em 5 blocos (modelo de dados, ingestão e
  idempotência, dispatcher e concorrência, outbox/worker/reconciliação, testes). A IA explicava cada parte e
  levantava as decisões em aberto; eu decidi:
  - **Janela de deduplicação:** a primeira versão deduplicava por hash do payload **sem prazo**, então a mesma pessoa
    voltando dias depois recebia o lead antigo e nada era distribuído. Escolhi limitar ao **dia UTC** (retries viram
    um lead; retorno em outro dia é lead novo). Implementado com testes; ADR-0004 atualizado.
  - **Cursor global vs. por produto:** a IA apontou que o cursor global garante 50/30/20 no total, mas não por produto.
    Mantive o cursor global (o enunciado pede a proporção total; mais simples de operar) e documentei a limitação e o
    caminho de migração no ADR-0003.
  - **Leads `failed`:** escolhi adicionar o reprocessamento manual pelo ADMIN (endpoint + botão), em vez de só documentar.
  - **Mantidos após análise:** affiliate criado automaticamente (risco documentado), status como enum do Postgres,
    telefone obrigatório em E.164.
  - **Script de carga multi-processo:** adiado por causa do prazo; registrado como lacuna.
- **Falha encontrada na revisão:** o handler de falha do worker marcava o lead como `failed` em modo fire-and-forget;
  com o Postgres fora naquele instante, o lead ficaria `pending` para sempre e, 7 dias depois, seria reenfileirado por
  engano. A reconciliação passou a tratar jobs `failed`. O teste de regressão foi **comprovado falhando sem a correção**.
- **Comentários do código:** pedi que todos fossem reescritos em português (identificadores, logs e nomes de testes
  continuam em inglês). As migrations já aplicadas ficaram como estavam, porque o Prisma valida o checksum.
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

## Etapa 4: webhook, autenticação, autorização e API do dashboard

- **Delegado:** webhook com HMAC, módulo de eventos de status compartilhado entre webhook e operador, sessão, perfis,
  rate limit, CSRF, listagem keyset, métricas, configuração do dispatcher, reprocessamento de `failed`, testes.
- **IA errou / corrigido na implementação:**
  - Listener de erro do Redis registrado depois do `await` de inicialização (um erro na subida ficaria sem listener).
  - Teste que dependia da ordem das linhas sem `ORDER BY` (falhou uma vez; o Postgres não garante ordem).
  - **Intermitência:** numa de ~8 execuções completas, um teste do pipeline estourou o timeout; passou em todas as
    outras e não reproduziu isolado. Em vez de aumentar o timeout, o `waitFor` passou a nomear a condição e a expirar
    antes do teste, para a próxima ocorrência apontar onde travou. Registrado como limitação.
- **Decisões:** webhook rejeitado (fora de ordem/transição inválida) responde `200` para o parceiro não reenviar; para
  o operador humano, a mesma regra responde `422`. Rate limit fail-open (Redis fora não derruba a ingestão).
- **Validado com:** 162 testes, incluindo os ataques da seção 21 (OPERATOR acessando rota de admin e lead alheio por
  requisição direta).

## Etapa 5: frontend

- **Delegado:** dashboard Next.js (login, métricas, filtros na URL, paginação, detalhe com histórico, admin do
  dispatcher), Dockerfile standalone e serviço no Compose.
- **IA errou / corrigido:** um `as unknown as` para silenciar o compilador (proibido no `CLAUDE.md`), trocado por
  construção explícita; união de tipos mal resolvida pega pelo typecheck do build.
- **Bug pego na validação manual:** as senhas de demonstração continham `#`, que o parser de `.env` do Node trata como
  comentário (a senha gravada virou `"Admin"`). Trocadas por senhas sem `#`.
- **Validado com:** `docker compose up --build` num projeto Compose novo (volumes vazios): páginas, login, 100 leads
  simultâneos pelo frontend → 50/30/20 exato, OPERATOR restrito, CSRF, webhook assinado e replay.

## Etapa 6: documentação de entrega

- **Delegado:** README, `security.md`, checklist final, atualização dos ADRs para refletir o implementado (ex.: cookie
  `Secure` configurável em vez do prefixo `__Host-` previsto no plano).
- **Validado com:** cada afirmação de segurança conferida contra o código e os headers reais (zero SQL `Unsafe`, zero
  `dangerouslySetInnerHTML`, nenhum e-mail nos logs da API após 100 leads).

## Verificação pós-entrega (clone limpo do GitHub)

- **Feita como o avaliador faria:** `git clone` numa pasta vazia, `docker compose up --build` e os comandos do README
  executados literalmente; depois `pnpm install && pnpm test`.
- **Encontrado e corrigido:**
  - `pnpm install && pnpm test` falhava num clone limpo: o client do Prisma (pasta gerada, fora do Git) só era gerado
    no build/Docker. Na máquina de desenvolvimento funcionava porque tinha sido gerado à mão. Correção: `postinstall:
    prisma generate`.
  - Com Node 22, o `pnpm` só avisava sobre a versão e o Vitest morria com um erro obscuro. Correção:
    `engine-strict=true` (para no `install` com mensagem clara).
  - Depois de um reinício do Docker, `api`/`worker`/`web` voltavam sozinhos, mas `postgres`/`redis` não (sem política
    de restart). Correção: `restart: unless-stopped`.
  - Exemplo de webhook do README, repetido, responde `invalid_transition` (correto, mas confuso): nota adicionada.
- **Intermitência:** reapareceu (2 em ~14 execuções completas). O diagnóstico novo mostrou que trava em
  `waitFor("20 leads distributed")`; o teste agora anexa o estado do sistema ao erro. Causa ainda não identificada.

