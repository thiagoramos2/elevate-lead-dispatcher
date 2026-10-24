# ADR-0003 — Algoritmo de distribuição e concorrência

**Status:** aceito · **Data:** 2026-10-23

## Contexto
Os leads devem ser distribuídos em A 50% / B 30% / C 20%. Vários workers, cada um com concorrência > 1, processam jobs em paralelo. O estado da decisão não pode viver na memória de um processo, e "dois processos leem o mesmo estado e depois atualizam" tem que ser impossível.

## Decisão
**Smooth weighted round robin (SWRR) indexado por um cursor global gap-free no Postgres.**

1. Os pesos são reduzidos pelo MDC (50/30/20 → 5/3/2). O SWRR (o mesmo algoritmo do nginx) gera um escalonamento determinístico de `Σpesos` slots, intercalado e sem rajadas: `A B C A A B A C B A`. É uma função pura, testada em unidade e cacheada por `config_version`.
2. Dentro da transação do job: `UPDATE dispatcher_state SET cursor = cursor + 1 WHERE id = 1 RETURNING cursor, config_version`.
   - O `UPDATE` é atômico e trava a linha até o commit, então dois workers nunca obtêm o mesmo cursor.
   - Se a transação faz rollback, o incremento é desfeito. O cursor não tem buracos, e a proporção é **exata** a cada `Σpesos` distribuições confirmadas.
3. `call_center = schedule[(cursor - 1) mod Σpesos]`.
4. Idempotência: antes do cursor, `SELECT ... FROM leads WHERE id = $1 FOR UPDATE`. Se já distribuído → no-op, sem consumir cursor. `UNIQUE(distributions.lead_id)` é a última barreira.
5. Ordem de locks fixa (lead → dispatcher_state) para evitar deadlock.

## Mudança de configuração (ADMIN)
Na mesma transação: `SELECT ... FROM dispatcher_state FOR UPDATE`, atualizar pesos/ativos, `config_version += 1`, `cursor = 0`. Como os workers leem os call centers *depois* de travar o `dispatcher_state`, eles nunca combinam um cursor com uma configuração parcial. Cada distribuição grava `config_version` para auditoria.

## Alternativas consideradas
| Alternativa | Por que não |
|---|---|
| Aleatório ponderado | Converge só no limite: com 100 leads, A pode receber 42 ou 58. Não é auditável nem testável de forma determinística |
| Contadores por call center ("escolher o mais atrás da meta") | Precisa ler N contadores e atualizar um: é a corrida clássica, a menos que tudo seja travado. Equivale a esta solução, só que mais complexa |
| Sequence do Postgres (`nextval`) como cursor (revisão 1) | Sem lock, mas com buracos em rollback. Com distribuição assíncrona e retries, rollbacks são esperados, e a proporção desviaria |
| Contador no Redis (`INCR`) | Atômico, mas não participa da transação do Postgres: um incremento de um job que falhou não volta. Seria uma segunda fonte da verdade |
| Lock na memória / um único worker | Viola "não depender da memória de um processo" e não escala |

## Consequências
- Distribuições são serializadas na linha do `dispatcher_state`. A vazão máxima ≈ 1 / (duração da transação). Com uma transação de poucos ms, estimamos centenas por segundo, **a confirmar por medição** (`docs/scalability.md`). Ingestão e distribuição são desacopladas, então um pico de entrada vira fila, não erro.
- Se um dia isso for o gargalo: particionar o cursor por produto (uma linha de estado por produto/pool) ou pré-alocar blocos de slots por worker.
