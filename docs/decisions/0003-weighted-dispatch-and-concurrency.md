# ADR-0003 — Algoritmo de distribuição e concorrência

**Status:** aceito · **Data:** 2026-10-23

## Contexto

Os leads devem ser distribuídos em A 50% / B 30% / C 20%. Vários workers, cada um com concorrência > 1, processam jobs em paralelo. O estado da decisão não pode viver na memória de um processo, e "dois processos leem o mesmo estado e depois atualizam" tem que ser impossível.

## Decisão

**Smooth weighted round robin (SWRR) indexado por um cursor global gap-free no Postgres.**

1. Os pesos são reduzidos pelo MDC (50/30/20 → 5/3/2). O SWRR (o mesmo algoritmo do nginx) gera um escalonamento
   determinístico de `Σpesos` slots, intercalado e sem rajadas: `A B C A A B A C B A`. É uma função pura
   (`domain/weighted-schedule.ts`), testada em unidade. Ela é recalculada a cada distribuição, porque custa
   microssegundos para dezenas de slots; um cache seria estado a mais para invalidar.
2. Transação do job (`distributeLead`):
   1. `SELECT ... FROM leads WHERE id = $1 FOR UPDATE`. Se já distribuído → no-op, **sem consumir cursor**.
   2. Lê `config_version` e os call centers ativos **sem lock** (ordenados por `slug`, para o escalonamento ser reproduzível).
   3. **Seção crítica:** `UPDATE dispatcher_state SET cursor = cursor + 1 WHERE id = 1 AND config_version = $lida RETURNING cursor`.
      - O `UPDATE` é atômico e trava a linha até o commit, então dois workers nunca obtêm o mesmo cursor.
      - Se um ADMIN mudou a configuração enquanto esperávamos o lock, o Postgres reavalia o `WHERE` sobre a nova
        versão da linha e nada é atualizado. O serviço relê a configuração (controle otimista).
      - Em rollback o incremento é desfeito: o cursor não tem buracos, e a proporção é **exata** a cada `Σpesos`
        distribuições confirmadas.
   4. `call_center = schedule[(cursor - 1) mod Σpesos]`.
   5. Um único statement (CTE) grava `distributions` e atualiza `leads`. Commit.
3. `UNIQUE(distributions.lead_id)` é a última barreira contra duplicidade, mesmo se o código acima estivesse errado.
4. Ordem de locks fixa (lead → dispatcher_state) para evitar deadlock.

### Por que a configuração é lida antes do lock

A primeira versão lia os call centers *depois* do `UPDATE`, dentro da seção crítica, e fazia `INSERT` e `UPDATE` em
statements separados: o lock ficava preso por 5 round trips. Ler antes (com a checagem otimista por `config_version`)
e juntar a escrita num CTE reduz a seção crítica para 2 statements + `COMMIT`. Ver as medições abaixo.

## Mudança de configuração (ADMIN)

Na mesma transação: `SELECT ... FROM dispatcher_state FOR UPDATE`, atualizar pesos/ativos, `config_version += 1`,
`cursor = 0`. Um worker que leu a configuração antiga falha no `WHERE config_version = $lida` e relê, então nunca
combina um cursor com uma configuração que não é a dele. Cada distribuição grava `config_version`, e o cursor é
gap-free **dentro de cada versão** (coberto por teste de integração com a mudança no meio de uma rajada).

## Escopo do cursor: global, não por produto (decisão do candidato na revisão)

O cursor é **um só para todos os produtos**. Isso garante 50/30/20 **no total**, mas **não por produto**. Num caso
patológico, com leads chegando alternados NutraLean/GlucoShield, o NutraLean ficaria sempre com as posições ímpares do
escalonamento (`A C A A B` = 60/20/20) e o GlucoShield com 40/40/20. Com chegadas reais (aleatórias), o desvio se dilui.

| Opção | Proporção | Escala | Decisão |
|---|---|---|---|
| **Cursor global** | Exata no total; por produto, só na média | Uma linha = um ponto de serialização | **Escolhida**: o enunciado pede 50/30/20 no total; é mais simples de operar e explicar |
| Cursor por produto | Exata por produto e no total (±1 por produto) | Uma linha por produto = locks independentes | Melhoria futura: adotar se o negócio exigir justiça de mix por produto (ex.: um produto converte muito mais) ou se o lock global virar gargalo |

A migração para cursor por produto é localizada: `dispatcher_state` passa a ter uma linha por produto e
`advanceCursor` recebe o `product_id`; o algoritmo e o resto do fluxo não mudam.

## Alternativas consideradas

| Alternativa                                                  | Por que não                                                                                                                                 |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Aleatório ponderado                                          | Converge só no limite: com 100 leads, A pode receber 42 ou 58. Não é auditável nem testável de forma determinística                         |
| Contadores por call center ("escolher o mais atrás da meta") | Precisa ler N contadores e atualizar um: é a corrida clássica, a menos que tudo seja travado. Equivale a esta solução, só que mais complexa |
| Sequence do Postgres (`nextval`) como cursor (revisão 1)     | Sem lock, mas com buracos em rollback. Com distribuição assíncrona e retries, rollbacks são esperados, e a proporção desviaria              |
| Contador no Redis (`INCR`)                                   | Atômico, mas não participa da transação do Postgres: um incremento de um job que falhou não volta. Seria uma segunda fonte da verdade       |
| Lock na memória / um único worker                            | Viola "não depender da memória de um processo" e não escala                                                                                 |

## Consequências

- As distribuições são serializadas na seção crítica. Medido nesta máquina de desenvolvimento (Windows + Docker
  Desktop, um único processo Node, pool de 40 conexões), com 100 distribuições concorrentes:

  | Cenário | Tempo |
  |---|---|
  | 100 transações Prisma sem lock nenhum (5 queries cada), concorrentes | 1.170 ms |
  | 100 distribuições concorrentes (versão inicial, seção crítica de 5 round trips) | ~1.700 ms |
  | 100 distribuições concorrentes (versão atual, 2 statements + COMMIT) | ~1.500 ms |

  A maior parte do tempo é custo do cliente (transações interativas do Prisma num único event loop + rede do Docker
  Desktop), não contenção. O custo serializado pelo lock fica em torno de 3 ms por distribuição, um teto da ordem de
  ~300/s **neste ambiente**. Não é um benchmark de produção; ver `docs/scalability.md`.
- Ingestão e distribuição são desacopladas: um pico de entrada vira fila (`waiting` no BullMQ), não erro na API.
- Se um dia isso for o gargalo: um cursor por pool (ex.: por produto), ou pré-alocar blocos de cursor por worker
  (perde a intercalação perfeita entre workers, mas mantém a proporção por bloco).
