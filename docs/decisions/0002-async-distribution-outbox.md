# ADR-0002 — Distribuição assíncrona com Transactional Outbox + BullMQ

**Status:** aceito · **Data:** 2026-10-23

## Contexto

O enunciado não exige fila ("não será atribuída pontuação adicional simplesmente por utilizar uma arquitetura mais complexa"). Existem problemas concretos que a justificam:
1. A ingestão de leads é o caminho de receita. Ela não deve falhar nem ficar lenta por causa de qualquer coisa além do próprio Postgres.
2. A evolução natural da distribuição é **entregar** o lead ao call center (HTTP externo, lento e falível). Isso não pode ficar dentro da requisição da landing page.
3. Retentativas com backoff e falha definitiva observável são necessárias quando a entrega for real.

## Decisão

- A API grava `lead` + `outbox_events` **na mesma transação** e responde `201` com `distribution_status: "pending"`. A API não conversa com o Redis para publicar.
- O worker roda um **relay** que lê o outbox com `FOR UPDATE SKIP LOCKED` (vários relays podem rodar em paralelo), publica no BullMQ e marca `published_at`.
  - `jobId = lead-<lead_id>-o<outbox_id>`: a republicação do *mesmo* evento (relay caiu antes do commit) é ignorada pelo BullMQ. Um `jobId = lead_id` puro foi descartado porque um job antigo guardado em `failed` faria o BullMQ ignorar uma nova tentativa legítima vinda da reconciliação.
  - O producer usa `enableOfflineQueue: false`: com o Redis fora, a publicação falha na hora em vez de acumular em memória. O buffer é o outbox, não a RAM do processo.
- O worker roda o **consumidor** de distribuição, que é idempotente (ADR-0003).
- BullMQ: `attempts: 8`, backoff exponencial a partir de 1s. Erros não recuperáveis (lead inexistente) usam `UnrecoverableError`. Ao esgotar as tentativas, o lead fica com `distribution_status = 'failed'`.

## Por que não publicar direto da API

`INSERT` seguido de `queue.add()` tem uma janela de falha: se o processo morre ou o Redis falha entre os dois, o lead fica gravado e nunca é distribuído. Inverter a ordem (publicar e depois gravar) cria um job para um lead inexistente. Só a gravação atômica no mesmo banco elimina a janela.

## Garantias (e o que NÃO garantimos)

- **Publicação at-least-once.** O relay pode publicar duas vezes se cair entre o `add` e o commit. O `jobId` determinístico deduplica enquanto o job existir no Redis, e o consumidor é idempotente de qualquer forma.
- **Efeito exactly-once da distribuição** vem do Postgres (`FOR UPDATE` + `UNIQUE(distributions.lead_id)`), não do BullMQ.
- Retentativas do BullMQ **não** garantem processamento. Se o Redis perder o job (restart sem AOF, `FLUSHALL`), o outbox já estará marcado como publicado. Mitigação: AOF habilitado + **reconciliação** a cada 60 s. Para cada lead `pending` há mais de 5 min cujo último evento foi publicado, ela pergunta ao BullMQ pelo job (`getJobState`). Se o Redis não o conhece mais, grava um novo evento de outbox. Se o job está `failed` mas o lead continua `pending` (o handler de falha não conseguiu gravar, por exemplo com o Postgres fora naquele instante), marca o lead `failed`; sem isso ele ficaria `pending` para sempre e, quando o BullMQ apagasse o job, seria reenfileirado por engano. Jobs `waiting`, `delayed` ou `active` não são tocados, para não duplicar trabalho em backlog.
- Leads com tentativas esgotadas ficam `failed` e **não** são reprocessados automaticamente: falhar 8 vezes indica um problema que precisa de olho humano. A reexecução manual pelo ADMIN fica como melhoria.

## Comportamento em falhas

| Falha                 | API (ingestão)                                                   | Worker                                                                                |
| --------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Redis indisponível    | Continua aceitando leads (validado: `201` com o Redis parado). O rate limit fica _fail-open_ (logado) | O relay acumula no outbox com backoff (`attempts`, `last_error`). Quando o Redis volta, publica e distribui sozinho (validado) |
| Postgres indisponível | `503`; a landing page deve retentar                              | Jobs falham e são retentados com backoff. O relay pausa                               |
| Worker morto          | Nenhum impacto                                                   | Jobs ativos voltam à fila (stalled job check do BullMQ)                               |

## Alternativas consideradas

- **Distribuição síncrona na transação do lead** (revisão 1): mais simples e exata, sem Redis. É a opção certa se a distribuição for só um registro. Foi rejeitada pelos pontos 2 e 3 do contexto.
- **`LISTEN/NOTIFY` no lugar do polling do relay:** menor latência. Fica como melhoria; o polling de 500ms é suficiente e mais fácil de raciocinar.
- **Postgres como fila (`SKIP LOCKED` sem Redis):** viável e remove um componente. Escolhemos o BullMQ pelo retry/backoff/visibilidade prontos e por ser a stack da vaga.
