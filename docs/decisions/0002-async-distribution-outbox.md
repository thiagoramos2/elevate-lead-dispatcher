# ADR-0002 — Distribuição assíncrona com Transactional Outbox + BullMQ

**Status:** aceito · **Data:** 2026-10-23

## Contexto
O enunciado não exige fila ("não será atribuída pontuação adicional simplesmente por utilizar uma arquitetura mais complexa"). Existem problemas concretos que a justificam:
1. A ingestão de leads é o caminho de receita. Ela não deve falhar nem ficar lenta por causa de qualquer coisa além do próprio Postgres.
2. A evolução natural da distribuição é **entregar** o lead ao call center (HTTP externo, lento e falível). Isso não pode ficar dentro da requisição da landing page.
3. Retentativas com backoff e falha definitiva observável são necessárias quando a entrega for real.

## Decisão
- A API grava `lead` + `outbox_events` **na mesma transação** e responde `201` com `distribution_status: "pending"`. A API não conversa com o Redis para publicar.
- O worker roda um **relay** que lê o outbox com `FOR UPDATE SKIP LOCKED` (vários relays podem rodar em paralelo), publica no BullMQ com `jobId = lead_id` e marca `published_at`.
- O worker roda o **consumidor** de distribuição, que é idempotente (ADR-0003).
- BullMQ: `attempts: 8`, backoff exponencial a partir de 1s. Erros não recuperáveis (lead inexistente) usam `UnrecoverableError`. Ao esgotar as tentativas, o lead fica com `distribution_status = 'failed'`.

## Por que não publicar direto da API
`INSERT` seguido de `queue.add()` tem uma janela de falha: se o processo morre ou o Redis falha entre os dois, o lead fica gravado e nunca é distribuído. Inverter a ordem (publicar e depois gravar) cria um job para um lead inexistente. Só a gravação atômica no mesmo banco elimina a janela.

## Garantias (e o que NÃO garantimos)
- **Publicação at-least-once.** O relay pode publicar duas vezes se cair entre o `add` e o commit. O `jobId` determinístico deduplica enquanto o job existir no Redis, e o consumidor é idempotente de qualquer forma.
- **Efeito exactly-once da distribuição** vem do Postgres (`FOR UPDATE` + `UNIQUE(distributions.lead_id)`), não do BullMQ.
- Retentativas do BullMQ **não** garantem processamento. Se o Redis perder o job (restart sem AOF, `FLUSHALL`), o outbox já estará marcado como publicado. Mitigação: AOF habilitado e reconciliação periódica que reenfileira leads `pending` mais antigos que um limite.

## Comportamento em falhas
| Falha | API (ingestão) | Worker |
|---|---|---|
| Redis indisponível | Continua aceitando leads. O rate limit fica *fail-open* (logado) | O relay acumula no outbox e retenta com backoff. A distribuição para e retoma sozinha |
| Postgres indisponível | `503`; a landing page deve retentar | Jobs falham e são retentados com backoff. O relay pausa |
| Worker morto | Nenhum impacto | Jobs ativos voltam à fila (stalled job check do BullMQ) |

## Alternativas consideradas
- **Distribuição síncrona na transação do lead** (revisão 1): mais simples e exata, sem Redis. É a opção certa se a distribuição for só um registro. Foi rejeitada pelos pontos 2 e 3 do contexto.
- **`LISTEN/NOTIFY` no lugar do polling do relay:** menor latência. Fica como melhoria; o polling de 500ms é suficiente e mais fácil de raciocinar.
- **Postgres como fila (`SKIP LOCKED` sem Redis):** viável e remove um componente. Escolhemos o BullMQ pelo retry/backoff/visibilidade prontos e por ser a stack da vaga.
