# Teste de carga: outbox lag e acúmulo na fila

Este documento investiga dois sintomas da execução oficial do `bun run test:load` ([`docs/carga/resultado.json`](carga/resultado.json), gerada sobre o commit `4dd9bd7` com o teste de carga ainda não commitado; o código do teste é o do commit `35e1619`): o **outbox lag alto mesmo com 10 clientes** e o **acúmulo na fila do cenário misto com 50 clientes**. No fim, propõe melhorias. **Nada foi implementado.** A metodologia do teste está em ARCHITECTURE.md → "Estratégia de testes".

## Resumo

1. **O outbox lag tem duas causas, e cada uma aparece num cenário.**
   - **Wallet disputada (causa estrutural):** a regra de ordem por agregado ("só o pendente de menor `seq` é elegível") serializa os `WalletBalanceChanged` de uma wallet. Eles saem **um por ciclo de claim**, qualquer que seja o número de publishers. O teto medido é ~37 eventos/s sob carga e ~45–57 eventos/s com a máquina ociosa. A wallet gera 63–94 eventos/s, então o atraso cresce linearmente durante toda a janela.
   - **Muitas wallets e misto (vazão do publisher):** cada instância tem **um único laço sequencial**, com ~14 idas e voltas ao banco e 1 chamada ao SQS a cada 10 eventos. Esse laço disputa o event loop, o pool e a CPU com a API. Com a máquina ociosa, a capacidade fica em 400–550 eventos/s, só um pouco acima da demanda de 10 clientes (~480/s). Sob CPU a 100%, cai para 350/s com 10 clientes, 146/s com 50 e 51/s no misto/50, em que o LocalStack também está saturado.
2. **O acúmulo na fila do misto/50 é sobrecarga absorvida pela fila, como projetado.** Os produtores SQS têm taxa fixa (alvo de 125 msg/s; o LocalStack lento limitou a 75). Os clientes HTTP estão em laço fechado e se autolimitam quando o sistema fica lento; os produtores SQS, não. Durante a carga, o consumo cai para **~7–14 msg/s**. Sem carga HTTP, os mesmos consumidores fazem **~50–110 msg/s**. A queda vem da barreira por lote do consumidor (o próximo receive espera a mensagem mais lenta do lote e o `DeleteMessage` dela), de um LocalStack preso em 1 núcleo (RTT de 150–290ms contra ~5ms ocioso) e da CPU do host em 100%. Parte da queda **não está explicada** pelos dados que temos (ver "O que não está explicado").
3. **A correção não foi afetada.** Não houve DLQ, retry, conflito de lock nem perda de evento, e todas as rodadas passaram nas verificações de consistência. O que piora é só o tempo até o efeito chegar ao downstream.

## Evidências

### Execução oficial (janela de 45s)

A demanda de eventos é `publicados/s + crescimento dos pendentes/s`. O crescimento vem das amostras de 1s (`samples`) entre t=10s e t=55s.

| Rodada | tx/s | Eventos publicados/s | Pendentes crescem | Demanda estimada | Lag no fim da janela |
|---|---:|---:|---:|---:|---:|
| wallet-disputada/10 | 63,6 | 100,3 | +27/s | ~127/s | 15,5s |
| wallet-disputada/50 | 93,8 | 119,4 | +68/s | ~187/s | 40,5s |
| muitas-wallets/10 | 250,8 | 350,7 | +126/s | ~477/s | 14,6s |
| muitas-wallets/50 | 389,6 | 146,2 | +594/s | ~740/s | 44,3s |
| misto/10 | 136,2 | 164,7 | +66/s | ~231/s | 15,3s |
| misto/50 | 221,6 | 50,7 | +334/s | ~385/s | 48,1s |

`tx/s` e "publicados/s" vêm do delta de `/metrics` das 3 instâncias (`wagering_transactions_total` e `wagering_outbox_published_total`). Nos seis casos a demanda passa da vazão, e o lag, que é a idade do pendente mais antigo, cresce sem parar até a carga acabar. Por isso o p95 do lag fica quase igual ao máximo. Nenhuma rodada teve falha de publicação nem retry da outbox, a não ser 3 falhas de lote no misto/10, todas recuperadas.

### Rodadas diagnósticas

Para separar as causas, rodei de novo, com janelas mais curtas, o misto/50 (5s + 30s) e o wallet-disputada/10 com o muitas-wallets/10 (5s + 20s). Junto rodaram duas sondas independentes, em [`test/load/diagnostics/`](../test/load/diagnostics/):
- **[`probe.ts`](../test/load/diagnostics/probe.ts), a cada 1s:** latência de `select 1` no Postgres, de `GetQueueAttributes` no LocalStack, CPU do host e `docker stats` de cada container.
- **[`outbox-poll.ts`](../test/load/diagnostics/outbox-poll.ts), a cada 2s:** pendentes por `event_type`, com o número de agregados distintos.

| Rodada | Resultado do `test:load` | Sonda de recursos | Leitor da outbox |
|---|---|---|---|
| misto/50 | [`diagnostico-misto-50.json`](carga/diagnostico-misto-50.json) | **perdida** (ver abaixo) | não rodou |
| wallet-disputada/10 + muitas-wallets/10 | [`diagnostico-10-clientes.json`](carga/diagnostico-10-clientes.json) | [`diagnostico-10-clientes-sonda.jsonl`](carga/diagnostico-10-clientes-sonda.jsonl) | [`diagnostico-10-clientes-outbox.jsonl`](carga/diagnostico-10-clientes-outbox.jsonl) |

Os instantes `t` dos JSONL são epoch em ms do relógio do host, o mesmo dos `samples` do `test:load` (que são relativos ao início da rodada). Os trechos citados abaixo usam segundos desde a primeira linha da sonda.

**Arquivo perdido:** o JSONL bruto da sonda de recursos do misto/50 foi apagado por engano antes da segunda rodada diagnóstica. A tabela "Misto, 50 clientes" abaixo foi transcrita da saída de terminal daquela execução e **não pode ser conferida por arquivo**. Os demais números do misto/50, isto é, profundidade da fila, outbox e consumo pela inbox, vêm do `diagnostico-misto-50.json` e da inbox lida logo após a rodada ([`inbox-rate.ts`](../test/load/diagnostics/inbox-rate.ts)). A inbox também não está arquivada; só o resultado ficou.

**Wallet disputada, 10 clientes: o atraso é todo de um único agregado.**

```
 t   outbox pendentes (agregados distintos)
 10s TxProcessed=1(1)  WalletBalanceChanged=48(1)
 20s TxProcessed=1(1)  WalletBalanceChanged=211(1)
 28s TxProcessed=3(3)  WalletBalanceChanged=338(1)    ← fim da carga
 30s                   WalletBalanceChanged=323(1)
 32s                   WalletBalanceChanged=211(1)
 34s                   WalletBalanceChanged=94(1)
 36s                   (vazio)
```

- `TxProcessed` (um agregado por transação) é publicado na hora.
- O acúmulo é só de `WalletBalanceChanged` da wallet disputada. Depois da carga, ele esvazia a **~57 eventos/s** (323→94 em 4s), e esse é o teto serial dessa wallet com a máquina quase ociosa.
- Na execução oficial, sob carga, a vazão desse agregado foi `100,3 − 63,6 ≈ 37/s` com 10 clientes e `119,4 − 93,8 ≈ 26/s` com 50.
- A CPU do host ficou em 53–75%, sem saturar. Então o lag do wallet-disputada/10 **não é falta de máquina**: é a regra de ordem.

**Muitas wallets, 10 clientes: o que limita é a vazão.**
- Os pendentes se espalham por centenas de agregados (`TxProcessed=760(760) WalletBalanceChanged=678(260)`), sem cabeça de fila.
- Durante a carga, a CPU do host ficou em 98–100%, o Postgres usou ~190% de CPU e o LocalStack ~100–115%.
- Com a carga encerrada, a outbox esvazia a **400–550 eventos/s**. Essa é a capacidade dos 3 publishers sem competição, só um pouco acima dos ~480/s que 250 tx/s geram.

**Misto, 50 clientes: tudo saturado ao mesmo tempo.**

```
 sonda          CPU host  Postgres(CPU)  LocalStack(CPU)  RTT LocalStack
 durante carga     100%     270–460%        90–130%        150–290 ms
 depois            20%        ~5%             ~8%            4–9 ms
```

Consumo do consumidor, contado pela inbox (`processed_at`) em janelas de 5s:

```
 durante a carga:  14,4  12,0  2,0  0,0  0,4  10,4  10,0  msg/s
 carga encerrada: 112,6 109,2 104,4 90,8              msg/s
```

### Custo do claim com backlog (EXPLAIN ANALYZE, backlog sintético)

Reproduzível com [`explain-claim.ts`](../test/load/diagnostics/explain-claim.ts), que dá TRUNCATE na outbox do `wagering_test`. Os tempos são de duas execuções.

| Backlog | Plano | Tempo |
|---|---|---:|
| 30k pendentes espalhados (15k transações + 300 wallets) | Index Scan em `uq_outbox_seq`, para em 10 linhas | ~0,1 ms |
| 3k eventos de **uma** wallet à frente + 20 outros | percorre 3.009 linhas (anti-join descarta as seguidoras) | 10–11 ms |
| 30k eventos de **uma** wallet à frente + 20 outros | percorre 30.009 linhas | 105–118 ms |

Com backlog espalhado, o claim custa pouco. Quando uma wallet quente acumula eventos à frente, porém, cada claim fica O(backlog), e isso deixa mais lento o ciclo de **todos** os agregados. É uma realimentação: mais atraso deixa o claim mais lento, e o claim lento aumenta o atraso. No wallet-disputada/50 o backlog chegou a ~3.800, o que dá ~12ms extras por ciclo.

## Causa 1: serialização por agregado (wallet disputada)

O claim ([`outbox-store.ts`](../src/infrastructure/outbox/outbox-store.ts)) só considera elegível o pendente de menor `seq` do agregado. Isso decorre da decisão documentada em ARCHITECTURE.md → "Outbox publisher", "Ordem por agregado". Para uma wallet quente, isso tem três consequências:

- **Um evento por ciclo:** o lote de 10 contém **no máximo 1** evento dessa wallet, porque o 2º tem um anterior pendente, que é justamente o 1º do mesmo lote.
- **Publishers extras não ajudam:** enquanto o publisher A segura a cabeça (`FOR UPDATE`, inclusive durante o `SendMessageBatch`), B e C pulam a cabeça (`SKIP LOCKED`) e o `not exists` exclui as seguintes. Os 3 publishers equivalem a 1 para esse agregado.
- **Teto:** a vazão máxima do agregado é `1 / duração do ciclo`. Medimos ~17ms com a máquina ociosa (~57/s), ~27ms sob carga com 10 clientes (~37/s) e ~38ms com 50 (~26/s). Uma wallet que processa mais transações/s que isso acumula atraso sem limite.

A garantia de ordem está correta; o custo dela é que não estava medido. Ele só aparece com uma wallet que recebe dezenas de transações por segundo.

## Causa 2: vazão do publisher sob competição (muitas wallets, misto)

Por instância, o ciclo ([`outbox-publisher.ts`](../src/interfaces/workers/outbox-publisher.ts), [`outbox-store.ts`](../src/infrastructure/outbox/outbox-store.ts)) é **um laço sequencial**:

```
BEGIN; SET LOCAL ×2; claim; SendMessageBatch (≤10); UPDATE ×10 (um por evento); COMMIT
```

São ~14 idas e voltas ao Postgres e 1 ao LocalStack para no máximo 10 eventos, todas encadeadas por `await` num event loop que também atende a API, o consumidor e o worker de pendentes. Com a máquina ociosa, cada ida e volta é curta e os 3 publishers fazem 400–550 eventos/s. Sob CPU a 100%, cada `await` paga o atraso de agendamento de um event loop cheio. Além disso, no misto o `SendMessageBatch` passa a custar 150–290ms porque o LocalStack está saturado. A vazão cai bem quando a demanda é maior: 350/s → 146/s → 51/s.

**Hipótese não medida:** com 50 clientes, há ~17 requisições HTTP em voo por instância para um pool de 10 conexões ([`mikro-orm.config.ts`](../src/infrastructure/persistence/mikro-orm.config.ts)), e o publisher espera na mesma fila do pool. Isso explicaria parte da queda de 10 para 50 clientes. Com 10 clientes (~3–4 em voo por instância), o pool não deve ser o gargalo. Não há métrica de espera do pool para confirmar.

## Causa do acúmulo na fila (misto, 50 clientes)

**Chegada maior que serviço.** Chegaram 75 msg/s. O alvo eram 125 msg/s (25 produtores × `LOAD_SQS_RATE=5`), mas cada produtor espera o `SendMessage` terminar antes de agendar o próximo, e com o LocalStack respondendo em centenas de ms eles ficaram para trás. Ou seja, **a chegada SQS só é aberta enquanto o LocalStack responde rápido**, uma limitação do gerador (proposta 9). No misto/10, o alvo de 25 msg/s foi atingido. No misto/10 chegavam 25 msg/s e a fila não passou de 23 mensagens. No misto/50 ela cresceu a ~68 msg/s, ou seja, o consumo total ficou em **~7–8 msg/s** durante a janela. Depois da carga, a fila esvaziou a ~50 msg/s na execução oficial e a ~110 msg/s na diagnóstica.

O mecanismo está no [`wager-consumer.ts`](../src/interfaces/sqs/wager-consumer.ts):

- **Barreira por lote:** cada instância roda **um laço**: `receive` (≤10) → processa os grupos do lote em paralelo → `Promise.all` → só então o próximo `receive`. A vazão por instância fica em `mensagens do lote / (receive + mensagem mais lenta do lote + o DeleteMessage dela)`. Num lote de 10, o tempo é ditado pela cauda (~p99), não pela mediana.
- **Três idas ao LocalStack por mensagem** (o receive, amortizado no lote; o `DeleteMessage`, um por mensagem), contra um LocalStack que, sob carga, responde em 150–290ms em média e está preso em 1 núcleo. Ele é um processo Python que atende ao mesmo tempo os 75 `SendMessage`/s dos produtores, os receives e deletes dos consumidores, os `SendMessageBatch` da outbox e os leitores de eventos e o amostrador do próprio teste.
- **Leitura de inbox e use case no Postgres**, disputando CPU com a API (as latências HTTP desta rodada ficaram em p50 112ms e p95 183ms).

**Por que aparece na fila e não no HTTP:** os clientes HTTP estão em laço fechado. Quando o sistema fica lento, eles mandam menos (o req/s sobe só de 111 para 215 quando os clientes vão de 10 para 50). Os produtores SQS estão em chegada aberta e continuam mandando 75 msg/s. A fila é o único ponto em que a sobrecarga se acumula em vez de se autolimitar. É o comportamento esperado de uma fila, e a latência ponta a ponta (p50 64s) é o tempo de espera nela (Lei de Little: ~3.400 mensagens ÷ ~55 msg/s ≈ 62s).

### O que não está explicado

Pela barreira, com receive e delete de ~200–300ms e a cauda do use case, cada instância deveria fazer ~10–15 msg/s, ou seja, 30–45 msg/s no total. O medido foi ~7–8 msg/s. Não temos dados para fechar essa diferença. As hipóteses, em ordem de plausibilidade:

1. A cauda do RTT do LocalStack (p99) é muito maior que a média que a sonda mede.
2. O LocalStack saturado devolve lotes menores que 10. Ocioso, ele devolve lotes cheios de grupos distintos, como verifiquei com uma sonda de 200 grupos ([`fifo-batch.ts`](../test/load/diagnostics/fifo-batch.ts): 10 mensagens por receive, ~6ms).
3. Falta de event loop para o laço do consumidor.

O consumidor não mede o tamanho do lote nem o tempo de cada etapa. Isso está na primeira proposta abaixo.

## Fatores do ambiente (valem para todos os números)

- **Uma máquina só:** i7-1165G7 (4 núcleos / 8 threads), 7,7 GiB de RAM, Docker Desktop com VM de 8 CPUs e 3,7 GiB. Gerador, 3 instâncias, Postgres e LocalStack disputam a mesma CPU, que fica em 100% em todas as rodadas com 50 clientes e no muitas-wallets/10.
- **Paginação:** no início da execução havia 0,6 GiB livres, e havia 15,9 GiB comprometidos para 7,7 GiB físicos. Na rodada diagnóstica do misto/50, o host inteiro parou por ~13s: o amostrador do teste e a sonda, que são processos independentes, ficaram sem amostras no mesmo intervalo, e o consumo da inbox foi a zero. **Na execução oficial isso não aconteceu** (nenhum intervalo entre amostras acima de 2,5s), exceto por uma lacuna de 3,2s no misto/10 aos 32s, que coincide com o salto de pendentes de 1.164 para 2.703.
- **LocalStack não é SQS:** é um único processo Python, e preso em 1 núcleo ele é o teto de tudo o que passa por SQS (consumo, publicação e os leitores do teste). Cada evento de transação usa o próprio `MessageGroupId`, o que gera milhares de grupos FIFO; o custo disso no LocalStack não diz nada sobre o SQS real. **Os números dos caminhos SQS são limitados pelo ambiente**, e só a análise de mecanismo (barreira, serialização) vale fora dele.
- **O próprio teste carrega o LocalStack:** 4 leitores da fila de eventos e o amostrador de profundidade.

## Propostas (nenhuma implementada)

As propostas estão em ordem de prioridade. Cada uma traz o efeito esperado, o custo e como validar. **Valide sempre com o `test:load` de antes e de depois**, comparando "publicados/s" com a demanda, a taxa de esvaziamento depois da carga e o consumo da fila durante a janela.

### 0. Instrumentar antes de otimizar (pré-requisito)

| Métrica | Onde | Responde |
|---|---|---|
| Histograma do tamanho do lote recebido | consumidor | o LocalStack devolve lotes pequenos sob carga? |
| Duração de `receive`, use case, `delete` e do lote inteiro | consumidor | onde está a diferença entre 7 e 30 msg/s |
| Duração do ciclo, do claim e do `SendMessageBatch`; eventos por ciclo | publisher | quanto é banco, quanto é SQS, quanto é event loop |
| Tempo de espera por conexão do pool | infraestrutura | a hipótese do pool com 50 clientes |

O risco é baixo: são só labels de conjunto fechado, seguindo a regra de ARCHITECTURE.md → "Observabilidade". Sem essas métricas, as propostas 3 e 4 são palpites calibrados.

### Outbox

**1. Publicar uma sequência de eventos do mesmo agregado por ciclo (ataca a causa 1).**

> **Atenção:** esta proposta, e também a alternativa mais simples abaixo, mexe na garantia de ordem por agregado da outbox, que hoje é testada (ARCHITECTURE.md → "Outbox publisher", "Ordem por agregado"). Ela só seria feita junto com uma nova rodada dos testes de concorrência e multi-instância (`bun run test:concurrency`, `bun run test:multi`), mais os testes novos de ordem com falha parcial descritos abaixo.

- **Mudança:** o claim trava a cabeça de um agregado (`SKIP LOCKED`) e também as próximas K pendentes dele, em ordem de `seq`, e envia todas no mesmo `SendMessageBatch`, com o mesmo `MessageGroupId` e na ordem das entradas.
- **Efeito estimado:** o teto por wallet sobe até K vezes (até 10, o limite do lote), de ~37 para ~370 eventos/s sob a mesma carga.
- **Custo:** o caso de falha parcial. Se a entrada k do lote falha e a k+1 é aceita, a k+1 chega antes da k. Isso exige confirmar como o SQS FIFO trata as entradas seguintes do mesmo grupo quando uma falha, ou então limitar o envio a um grupo por chamada. Também é preciso reagendar a k e todas as seguintes do agregado. A mudança mexe na garantia de ordem, que hoje é simples e testada, e precisa de testes novos de ordem com falha parcial.
- **Alternativa mais simples:** relaxar a ordem só para `WalletBalanceChanged`, que já carrega `walletVersion`, e documentar que o consumidor descarta versões menores ou iguais à última aplicada (ARCHITECTURE.md → "Outbox publisher"). O custo é que a mudança passa para o contrato do consumidor.

**2. Gravar o resultado do lote em 1 comando em vez de 10 (ataca a causa 2).**
- **Mudança:** um `update … where id = any(?) and published_at is null` para os publicados, e outro, ou um `update … from (values …)`, para os reagendados. A checagem de `affectedRows` passa a comparar contagens.
- **Efeito estimado:** o ciclo cai de ~14 para ~6 idas ao banco. É o ganho mais barato para todos os cenários e também encurta o ciclo serial da causa 1.
- **Custo:** baixo. Mantém a mesma transação e o mesmo lock.

**3. Paralelismo do publisher por instância.**
- **Mudança:** N laços concorrentes por instância (`OUTBOX_CONCURRENCY`, padrão 1). O claim com `SKIP LOCKED` já é seguro com vários publishers, e isso está testado.
- **Efeito:** multiplica a vazão nos cenários com muitos agregados. Não ajuda a wallet quente (precisa da proposta 1).
- **Custo:** cada laço segura uma conexão durante o `SendMessageBatch`. Com pool de 10, isso tira conexões da API. Seria preciso aumentar o pool ou dar um pool próprio ao publisher, e o total no Postgres é `instâncias × pool`.
- **Variante equivalente:** um claim de até 50 linhas por ciclo, com 5 `SendMessageBatch` em paralelo dentro da mesma transação.

**4. Claim que não percorre o backlog da wallet quente.**
- **Problema:** com uma cabeça de fila longa, o claim fica O(backlog) (105–118ms com 30k).
- **Mudança:** selecionar por cabeça de agregado (por exemplo, `distinct on (aggregate_id) … order by aggregate_id, seq`, ou uma tabela de cabeças mantida no INSERT).
- **Custo:** um índice ou uma tabela a mais, e um plano a revalidar com EXPLAIN. Só vale junto com a proposta 1 ou se a 1 não for feita.

### Consumidor

**5. Separar a API dos workers (configuração, sem código).**
- **Mudança:** já existem as flags `SQS_CONSUMER_ENABLED`, `OUTBOX_PUBLISHER_ENABLED` e `PENDING_REFERENCE_WORKER_ENABLED`. Dá para rodar processos só de API e processos só de workers, escalando cada grupo de forma independente.
- **Efeito:** o caminho assíncrono para de disputar o event loop e o pool com a API.
- **Custo:** um papel a mais no deploy. Nesta máquina, porém, os processos continuariam disputando a mesma CPU; o ganho real depende de mais CPU. **Esta é a forma mais barata de "aumentar o número de consumidores".**

**6. Tirar a barreira por lote.**
- **Mudança:** manter até N mensagens em voo por instância (sequenciais por grupo, como hoje) e chamar o próximo `receive` quando houver vaga, em vez de esperar o lote inteiro.
- **Efeito:** a vazão passa a seguir a mediana do processamento, não a cauda.
- **Custo:** o shutdown e o release ficam mais delicados, embora o conjunto `unfinished` já exista para isso. Os testes de ordem por grupo e de shutdown precisam continuar passando.

**7. Vários laços de consumo por instância (`SQS_CONSUMER_CONCURRENCY`).**
- **Efeito:** é o mais simples de implementar.
- **Custo:** no SQS real, o grupo FIFO fica bloqueado enquanto tem mensagem em voo, então a ordem por wallet se mantém. **No LocalStack o grupo não é bloqueado** (comentário no `processGroup`), então dois laços podem processar a mesma wallet fora de ordem. A idempotência e o lock por wallet mantêm o saldo correto, e uma reversão antes da referência vira pendente, mas a ordem de entrega muda, e os testes rodam no LocalStack. Prefira a 6.

**8. `DeleteMessageBatch` ao fim do lote, em vez de um `DeleteMessage` por mensagem.**
- **Efeito:** corta até 9 de cada 10 chamadas de ack ao SQS, que é o recurso saturado no misto.
- **Custo:** o ack demora um pouco mais. Uma reentrega nesse intervalo cai na inbox (`DUPLICATE_MESSAGE`), então continua seguro.

### Medição

**9. Melhorar o próprio experimento.**
- Rodar o gerador em outra máquina, ou ao menos limitar a CPU dos containers e fechar o que estiver paginando.
- Medir os caminhos SQS contra o SQS real, ou contra um emulador multi-thread, antes de concluir algo sobre a vazão do consumidor.
- Desligar os leitores de eventos do teste durante a janela e drenar depois.
- Produtores SQS de chegada realmente aberta: disparar cada envio no horário agendado sem esperar o anterior. Hoje o misto/50 entregou 75 dos 125 msg/s pedidos.
- Registrar a RAM livre e a paginação no ambiente, e marcar as rodadas com lacunas de amostra acima de 2s como suspeitas.

### Ordem sugerida

Primeiro a **0**, que mostra quanto do problema é ambiente. Depois a **2**, barata e sem efeito colateral, e a **5**, que é só configuração. Em seguida a **6** ou a **3**, conforme o que a 0 mostrar. A **1** vem por último, só se uma wallet com dezenas de transações/s for um caso real de negócio, porque ela troca simplicidade da garantia de ordem por vazão.
