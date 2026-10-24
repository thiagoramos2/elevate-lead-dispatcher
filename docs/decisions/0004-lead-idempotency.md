# ADR-0004 — Idempotência do `POST /api/leads`

**Status:** aceito · **Data:** 2026-10-23

## Decisão

- O cliente pode enviar `Idempotency-Key` (header, 8–255 caracteres). Sem header, a chave é `sha256` do payload **canonicalizado** (chaves ordenadas, e-mail em minúsculas, strings aparadas), então um retry idêntico gera a mesma chave.
- `leads.idempotency_key` é `UNIQUE`. A inserção usa `INSERT ... ON CONFLICT (idempotency_key) DO NOTHING RETURNING id`.
- `leads.request_hash` = hash do payload canônico.

| Situação                       | Resposta                                                                           |
| ------------------------------ | ---------------------------------------------------------------------------------- |
| Primeira requisição            | `201 { success: true, lead_id, duplicate: false, distribution_status: "pending" }` |
| Mesma chave, mesmo payload     | `200 { success: true, lead_id, duplicate: true, ... }` (mesmo `lead_id`)           |
| Mesma chave, payload diferente | `409 IDEMPOTENCY_KEY_REUSED`                                                       |

## Requisições simultâneas

Duas transações inserem a mesma chave. O Postgres faz a segunda **esperar** o commit da primeira no índice único. Depois disso, o `ON CONFLICT DO NOTHING` da segunda não retorna linha, e ela lê o lead existente. Resultado: um lead, um evento de outbox, as duas respostas com o mesmo `lead_id`. Se a primeira fizer rollback, a segunda insere. Não há janela de "check-then-insert".

## Fora de escopo (decisão de produto)

Deduplicação **de negócio** (mesma pessoa preenchendo o mesmo funil dias depois) não é responsabilidade da camada de transporte. Pode ser política de produto (ex.: janela de 24h por `email+product`), e caberia como regra configurável numa V2.
