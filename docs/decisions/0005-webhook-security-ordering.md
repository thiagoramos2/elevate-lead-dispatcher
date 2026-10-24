# ADR-0005 — Webhook do call center: autenticação, duplicidade e ordenação

**Status:** aceito · **Data:** 2026-10-23

## Autenticação: HMAC-SHA256 por call center
- Headers: `X-CallCenter-Id: <slug>` e `X-Signature: t=<unix_seconds>,v1=<hex>`.
- Assinatura: `HMAC_SHA256(secret, "<t>.<raw_body>")`, sobre o corpo **bruto** (o JSON re-serializado não bate byte a byte).
- `timingSafeEqual` na comparação. Tolerância de ±300s em `t`: uma requisição capturada não pode ser reenviada depois da janela, e dentro dela a dedup cobre.
- Os segredos vêm de variável de ambiente (`CALLCENTER_WEBHOOK_SECRETS`), nunca do banco nem do repositório. Em produção, ficariam num secrets manager, com suporte a dois segredos ativos para rotação.
- A identidade autenticada **autoriza**: o call center só altera leads distribuídos a ele. Lead de outro call center ou inexistente → `404`, sem distinguir os casos.

Alternativas: uma API key estática viaja em texto, não protege a integridade do corpo e não impede replay. mTLS é forte, mas operacionalmente caro para parceiros.

## Duplicidade
- `dedup_key` = `sha256(call_center | lead_id | external_id | status | timestamp)`.
- `UNIQUE(lead_id, dedup_key)` em `lead_events` + `ON CONFLICT DO NOTHING`.
- Duplicado → `200 { duplicate: true }`, sem efeito. O 2xx faz o parceiro parar de reenviar.

## Fora de ordem e transições
Com o lead travado (`FOR UPDATE`), webhooks concorrentes do mesmo lead são serializados.
1. **Temporal:** aplica somente se `occurred_at > leads.status_changed_at`. Um `contacted` de 11h que chega depois de um `sale` de 12h é **gravado** com `applied = false, rejection_reason = 'stale'`.
2. **Máquina de estados:** mesmo mais novo, `sale → contacted` é rejeitado (`invalid_transition`).

```
new        → contacted | no_answer | callback | qualified | sale | invalid
contacted  → no_answer | callback | qualified | sale | invalid
no_answer  → contacted | no_answer | callback | qualified | sale | invalid
callback   → contacted | no_answer | callback | qualified | sale | invalid
qualified  → contacted | no_answer | callback | sale | invalid
sale       → refund
refund     → ∅ (terminal)
invalid    → ∅ (terminal)
```
- Evento rejeitado → `200 { applied: false, reason }`. O evento foi recebido e auditado; um 4xx faria o parceiro retentar algo que nunca será aceito.
- `timestamp` mais de 5 min no futuro → `422`.
- Toda tentativa fica em `lead_events` (aplicada ou não), com o payload bruto: a trilha de auditoria completa.

Alternativa considerada: "o último que chega vence". É simples, mas deixa um evento atrasado desfazer uma venda. Outra: reordenar via buffer. Adiciona latência e não resolve atrasos maiores que o buffer.
