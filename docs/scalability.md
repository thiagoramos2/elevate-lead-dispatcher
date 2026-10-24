# Escalabilidade

> Princípio: só afirmar o que foi medido. Os números abaixo vêm de uma máquina de desenvolvimento
> (Windows 11 + Docker Desktop, um processo Node 24, Postgres 18 e Redis 8 em containers locais).
> **Não são benchmarks de produção.** Servem para localizar gargalos, não para prometer capacidade.

## 1. Quatro dimensões diferentes

Elas crescem de forma independente e têm limites diferentes:

| Dimensão | O que limita | Onde se observa |
|---|---|---|
| **Volume armazenado** (100k → 1M → 10M+ leads) | Tamanho de tabelas e índices, custo das consultas do dashboard | `pg_total_relation_size`, planos de consulta |
| **Taxa de entrada** (leads/s no `POST /api/leads`) | Transação curta de inserção; pool de conexões da API | latência p95 da API, conexões ativas |
| **Jobs pendentes** (backlog) | Diferença entre a taxa de entrada e a vazão dos workers | `waiting`/`delayed` no BullMQ, outbox não publicado, leads `pending` |
| **Vazão de distribuição** | Seção crítica serializada no `dispatcher_state` (ADR-0003) | tempo de transação de `distributeLead`, espera por lock |

## 2. Medições (Etapa 3)

| Experimento | Resultado |
|---|---|
| Distribuição sequencial, por transação | p50 ≈ 11–14 ms, p95 ≈ 18–22 ms |
| 100 transações Prisma concorrentes **sem lock** (5 queries cada) | 1.170 ms |
| 100 distribuições concorrentes, seção crítica de 5 round trips (v1) | ~1.700 ms |
| 100 distribuições concorrentes, seção crítica de 2 statements + COMMIT (atual) | ~1.500 ms |
| 100 `POST /api/leads` HTTP simultâneos → relay → 4 workers × concorrência 10 | 100 leads, 100 distribuições, 50/30/20 exato, cursor 1..100 sem buracos |
| Redis parado durante a ingestão (Compose real) | API respondeu `201`; eventos ficaram no outbox com backoff; distribuídos sozinhos quando o Redis voltou |

**Leitura:** cerca de 78% do tempo de 100 distribuições concorrentes é custo do cliente (transação interativa do Prisma
num único event loop + rede do Docker Desktop no Windows). A parte serializada pelo lock fica em torno de 3 ms por
distribuição. Em produção, com vários processos de worker, o custo do cliente se paraleliza e o teto passa a ser a
seção crítica.

**O que não foi medido:** vazão sustentada por minutos, latência sob carga com vários processos de worker, banco com
milhões de linhas. Ficam como próximos passos (seção 6).

## 3. Volume armazenado: 100k → 1M → 10M+

- **Escrita:** IDs `uuidv7` são ordenados no tempo, então as inserções caem no fim das B-trees (sem a fragmentação do
  UUIDv4). A inserção não depende do tamanho da tabela.
- **Leitura do dashboard:** toda listagem usa paginação **keyset** sobre `(created_at, id)`, com custo constante em
  qualquer página. `OFFSET` degrada linearmente e foi descartado.
- **Índices compostos** começam pelo filtro de igualdade mais seletivo e terminam em `created_at DESC`
  (`architecture.md` §4). Filtros de baixa seletividade (`source`, UTM) sempre vêm combinados com o período.
- **Métricas:** `COUNT(*)` com filtro de período usa os índices e é aceitável até a casa do milhão. Acima disso, contar
  ao vivo deixa de ser razoável; ver a seção 5.

| Volume | Comportamento esperado | Ação |
|---|---|---|
| 100k | Tudo em memória (shared_buffers). Nenhuma ação | — |
| 1M | Índices ainda cabem em memória com folga. Contagens ao vivo em dezenas de ms | Monitorar planos (`pg_stat_statements`) |
| 10M+ | Contagens ao vivo e VACUUM de tabelas grandes ficam caros | Particionamento e rollups (seção 5), **quando as métricas mostrarem** |

## 4. Como escalar cada componente

| Componente | Como | Cuidado |
|---|---|---|
| **API** | Réplicas sem estado atrás de um load balancer (`docker compose up --scale api=N` em produção real) | Cada réplica abre `DB_POOL_MAX` conexões: o total precisa caber no `max_connections` |
| **Workers** | Mais processos (`--scale worker=N`) e/ou `WORKER_CONCURRENCY` | Mais concorrência não aumenta a vazão além do teto da seção crítica; só aumenta a espera por lock |
| **Relay** | Já pode rodar em N instâncias (`SKIP LOCKED`) | Um relay já publica lotes de 100 a cada 500 ms; raramente é gargalo |
| **Pool de conexões** | PgBouncer em *transaction mode* na frente do Postgres | Transações interativas do Prisma funcionam em transaction mode; prepared statements precisam de atenção |
| **Postgres** | Vertical primeiro (CPU, RAM para índices, IOPS). Réplica de leitura para o dashboard | Leituras na réplica toleram alguns segundos de atraso; o dispatcher sempre lê o primário |
| **Redis** | Uma instância com AOF atende ordens de grandeza acima do necessário. Sentinel/managed para HA | `noeviction` é obrigatório para o BullMQ; Redis Cluster exige hash tags no nome da fila |
| **Observabilidade** | Métricas: tamanho da fila, idade do job mais antigo, outbox não publicado, leads `pending` > 5 min, `failed`, tempo de transação de `distributeLead`, p95 da API | Alertar sobre a **idade** do backlog, não só o tamanho |

## 5. Quando adotar o que não foi implementado

| Técnica | Gatilho (evidência necessária) |
|---|---|
| Particionar `leads` e `lead_events` por `RANGE(created_at)` mensal | Tabela na casa de dezenas de milhões, VACUUM/índices pesando, necessidade de retenção por período |
| Tabela de rollup diária para as métricas | `COUNT` do dashboard acima de ~200 ms no p95 |
| Réplica de leitura para o dashboard | Consultas analíticas competindo por CPU/IO com a ingestão |
| Cursor por pool (produto) ou blocos de cursor por worker | Tempo de espera pelo lock do `dispatcher_state` dominando o tempo de `distributeLead` |
| `LISTEN/NOTIFY` no relay | Latência ingestão → distribuição precisando ficar abaixo de ~500 ms |

## 6. Próximos passos de medição

- Teste de carga sustentada (k6/autocannon) contra o Compose, medindo a vazão de ingestão e de distribuição com 1, 2
  e 4 processos de worker.
- Popular 1M e 10M de leads sintéticos e registrar `EXPLAIN (ANALYZE, BUFFERS)` das consultas do dashboard.
