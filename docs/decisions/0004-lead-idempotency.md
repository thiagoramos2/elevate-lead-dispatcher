# ADR-0004 — Idempotência do `POST /api/leads`

**Status:** aceito · **Data:** 2026-10-23

## Decisão

- O cliente pode enviar `Idempotency-Key` (header, 8–255 caracteres) → chave `client:<key>`, **sem prazo**: o cliente está afirmando "é a mesma requisição".
- Sem header, a chave é `payload:<dia UTC>:<sha256 do payload canonicalizado>` (chaves ordenadas, e-mail em minúsculas, strings aparadas, telefone em E.164). Um retry idêntico no mesmo dia gera a mesma chave.
- Os prefixos `client:`/`payload:` impedem que uma chave enviada pelo cliente colida com uma derivada.
- `leads.idempotency_key` é `UNIQUE`. A inserção usa `INSERT ... ON CONFLICT (idempotency_key) DO NOTHING RETURNING id`.
- `leads.request_hash` = hash do payload canônico.

| Situação                       | Resposta                                                                           |
| ------------------------------ | ---------------------------------------------------------------------------------- |
| Primeira requisição            | `201 { success: true, lead_id, duplicate: false, distribution_status: "pending" }` |
| Mesma chave, mesmo payload     | `200 { success: true, lead_id, duplicate: true, ... }` (mesmo `lead_id`)           |
| Mesma chave, payload diferente | `409 IDEMPOTENCY_KEY_REUSED`                                                       |

## Requisições simultâneas

Duas transações inserem a mesma chave. O Postgres faz a segunda **esperar** o commit da primeira no índice único. Depois disso, o `ON CONFLICT DO NOTHING` da segunda não retorna linha, e ela lê o lead existente. Resultado: um lead, um evento de outbox, as duas respostas com o mesmo `lead_id`. Se a primeira fizer rollback, a segunda insere. Não há janela de "check-then-insert".

## Janela de 24 h na chave derivada do payload (decisão do candidato na revisão)

A primeira versão usava só o hash do payload, **sem prazo**: a mesma pessoa preenchendo o mesmo formulário com os
mesmos dados uma semana depois recebia `200 duplicate` com o lead antigo, e nenhum lead novo era distribuído.

| Opção | Comportamento | Decisão |
|---|---|---|
| Sem prazo | Igual é igual para sempre | Rejeitada: perde reengajamento real (lead quente que voltou) |
| **Dia UTC na chave** | Igual no mesmo dia = duplicado; em outro dia = lead novo | **Escolhida**: retries de rede (segundos/minutos) são deduplicados; um retorno em outro dia é um evento de negócio |
| Janela deslizante de 24 h | Igual nas últimas 24 h = duplicado | Rejeitada: não cabe numa unique constraint; exigiria lock ou consulta prévia, reabrindo a corrida check-then-insert |

**Limitação aceita:** um retry que cruze a meia-noite UTC (ex.: 23:59:59 → 00:00:01) cria um segundo lead. Isso exige
uma falha de rede exatamente na virada do dia; a chance é desprezível frente ao custo de uma janela deslizante.

## Fora de escopo (decisão de produto)

Deduplicação **de negócio** (mesma pessoa preenchendo o mesmo funil dias depois) não é responsabilidade da camada de transporte. Pode ser política de produto (ex.: janela de 24h por `email+product`), e caberia como regra configurável numa V2.
