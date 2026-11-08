import { expect } from 'bun:test';
import type { SQSClient } from '@aws-sdk/client-sqs';
import { queueDepth } from '../integration/interfaces/sqs-harness';
import { eventually } from './harness';

/**
 * Verificações de quiescência e de consistência final por SQL, usadas pelo `test:multi` e pelo
 * `test:load`. Algumas repetem garantias do schema de propósito: o teste não confia no schema
 * para afirmar o resultado (ARCHITECTURE.md → "Estratégia de testes").
 */

export type Rows = <T>(sql: string, bindings?: string[]) => Promise<T[]>;

/** Fila principal vazia (inclui em voo e atrasadas), outbox sem pendentes e nenhuma pendência. */
async function quiescentOnce(rows: Rows, sqs: SQSClient, queueUrl: string): Promise<void> {
  const depth = await queueDepth(sqs, queueUrl);
  if (depth !== 0) throw new Error(`fila principal ainda tem ${depth} mensagens (visíveis + em voo + atrasadas)`);
  const [pending] = await rows<{ outbox: string; waiting: string; overdue: string }>(
    `select (select count(*) from outbox_messages where published_at is null)::text as outbox,
            (select count(*) from wager_transactions where status in ('PENDING','PENDING_REFERENCE'))::text as waiting,
            (select count(*) from wager_transactions
              where status = 'PENDING_REFERENCE' and next_reference_check_at <= now())::text as overdue`,
  );
  if (pending?.outbox !== '0') throw new Error(`outbox com ${pending?.outbox} pendentes`);
  if (pending?.waiting !== '0') throw new Error(`${pending?.waiting} transações ainda em PENDING/PENDING_REFERENCE (vencidas: ${pending?.overdue})`);
}

export async function waitQuiescence(rows: Rows, sqs: SQSClient, queueUrl: string, timeoutMs = 90_000): Promise<void> {
  await eventually(
    'sistema quiescente (fila vazia, nada em voo, outbox sem pendentes, nenhuma pendência)',
    async () => {
      // Duas leituras seguidas: "ApproximateNumberOf…" do SQS é aproximado.
      await quiescentOnce(rows, sqs, queueUrl);
      await Bun.sleep(300);
      await quiescentOnce(rows, sqs, queueUrl);
    },
    timeoutMs,
    250,
  );
}

/**
 * Invariantes de todo o banco, depois da quiescência. `deliveredEventIds` são os `eventId` lidos
 * da fila de eventos; `dlqDepth`, a profundidade da DLQ. Devolve o número de linhas da outbox.
 */
export async function expectConsistent(
  rows: Rows,
  options: { deliveredEventIds: ReadonlySet<string>; dlqDepth: number },
): Promise<{ outboxEvents: number }> {
  // 1. Invariante: wallet.balance == saldo reconstruído pelo ledger, para todas as wallets.
  expect(
    await rows(
      `select w.id, w.balance::text as balance,
              coalesce(sum(case l.direction when 'CREDIT' then l.amount else -l.amount end), 0)::numeric(20,2)::text as ledger
         from wallets w left join wallet_ledger_entries l on l.wallet_id = w.id
        group by w.id, w.balance
       having w.balance <> coalesce(sum(case l.direction when 'CREDIT' then l.amount else -l.amount end), 0)`,
    ),
    'wallet.balance == saldo do ledger',
  ).toEqual([]);

  // 2. Nenhum saldo negativo.
  expect(await rows('select id from wallets where balance < 0'), 'saldo negativo').toEqual([]);

  // 3. Uma linha por idempotency key e no máximo um lançamento por transação.
  expect(
    await rows('select provider_id, idempotency_key from wager_transactions group by 1, 2 having count(*) > 1'),
    'idempotency key duplicada',
  ).toEqual([]);
  expect(
    await rows('select wallet_id, transaction_id from wallet_ledger_entries group by 1, 2 having count(*) > 1'),
    'mais de um lançamento por transação',
  ).toEqual([]);

  // 4. Nenhuma referência revertida duas vezes.
  expect(
    await rows(
      `select reference_transaction_id from wager_transactions
        where status = 'PROCESSED' and kind in ('REFUND','ROLLBACK')
        group by 1 having count(*) > 1`,
    ),
    'referência revertida mais de uma vez',
  ).toEqual([]);

  // 5. Quem move saldo tem exatamente um lançamento; LOSS, REJECTED e FAILED, nenhum.
  expect(
    await rows(
      `select t.id, t.kind, t.status, count(l.id) as entries
         from wager_transactions t left join wallet_ledger_entries l on l.transaction_id = t.id
        group by t.id, t.kind, t.status
       having (t.status = 'PROCESSED' and t.kind <> 'LOSS' and count(l.id) <> 1)
           or ((t.status <> 'PROCESSED' or t.kind = 'LOSS') and count(l.id) <> 0)`,
    ),
    'lançamentos fora da regra (1 por transação que move saldo, 0 em LOSS/REJECTED/FAILED)',
  ).toEqual([]);
  expect(
    await rows(`select l.id from wallet_ledger_entries l join wager_transactions t on t.id = l.transaction_id where t.amount <> l.amount`),
    'valor do lançamento diferente do valor da transação',
  ).toEqual([]);

  // 5b. Diário de partidas dobradas: saldo da conta PLAYER == wallet.balance (== ledger, pelo item 1),
  // um lançamento de diário por lançamento do ledger e vice-versa, e débito = crédito em cada um.
  expect(
    await rows(
      `select w.id, w.balance::text as balance, coalesce(j.total, 0)::numeric(20,2)::text as journal
         from wallets w
         left join (select a.wallet_id, sum(case p.direction when 'CREDIT' then p.amount else -p.amount end) as total
                      from accounts a join journal_postings p on p.account_id = a.id
                     where a.kind = 'PLAYER' group by a.wallet_id) j on j.wallet_id = w.id
        where w.balance <> coalesce(j.total, 0)`,
    ),
    'saldo da conta PLAYER no diário == wallet.balance',
  ).toEqual([]);
  expect(
    await rows(
      `select l.transaction_id from wallet_ledger_entries l
         left join journal_entries j on j.wager_transaction_id = l.transaction_id where j.id is null
       union all
       select j.wager_transaction_id from journal_entries j
         left join wallet_ledger_entries l on l.transaction_id = j.wager_transaction_id where l.id is null`,
    ),
    'lançamento do ledger sem diário, ou diário sem lançamento do ledger',
  ).toEqual([]);
  expect(
    await rows(
      `select journal_entry_id from journal_postings group by journal_entry_id
       having sum(case direction when 'DEBIT' then amount else 0 end) <> sum(case direction when 'CREDIT' then amount else 0 end)`,
    ),
    'lançamento de diário com débito ≠ crédito',
  ).toEqual([]);

  // 6. Outbox toda publicada, e cada eventId da outbox chegou à fila de eventos (duplicata pode, perda não).
  const outboxIds = (await rows<{ id: string }>('select id from outbox_messages')).map((row) => row.id);
  expect(outboxIds.length, 'houve eventos').toBeGreaterThan(0);
  expect(await rows('select id from outbox_messages where published_at is null'), 'evento não publicado').toEqual([]);
  const delivered = options.deliveredEventIds;
  expect(
    outboxIds.filter((id) => !delivered.has(id)),
    'eventos da outbox que NÃO chegaram à fila de eventos (perda)',
  ).toEqual([]);
  const outboxSet = new Set(outboxIds);
  expect(
    [...delivered].filter((id) => !outboxSet.has(id)),
    'eventIds na fila que não existem na outbox',
  ).toEqual([]);
  expect(delivered.size, 'eventIds distintos na fila == linhas da outbox').toBe(outboxIds.length);

  // 6b. Nenhum evento faltando na ORIGEM: toda transação terminal (exceto OPENING) tem exatamente
  // um evento terminal do tipo certo, e todo lançamento tem exatamente um WalletBalanceChanged.
  expect(
    await rows(
      `select t.id, t.kind, t.status,
              count(o.id) filter (where o.event_type = 'WagerTransactionProcessed') as processed_events,
              count(o.id) filter (where o.event_type = 'WagerTransactionRejected') as rejected_events
         from wager_transactions t
         left join outbox_messages o on o.aggregate_id::text = t.id::text
        where t.kind <> 'OPENING'
        group by t.id, t.kind, t.status
       having not (
             (t.status = 'PROCESSED' and count(o.id) filter (where o.event_type = 'WagerTransactionProcessed') = 1
                                     and count(o.id) filter (where o.event_type = 'WagerTransactionRejected') = 0)
          or (t.status in ('REJECTED', 'FAILED') and count(o.id) filter (where o.event_type = 'WagerTransactionProcessed') = 0
                                                 and count(o.id) filter (where o.event_type = 'WagerTransactionRejected') = 1))`,
    ),
    'transação terminal sem o evento terminal certo (ou com mais de um)',
  ).toEqual([]);
  expect(
    await rows(
      `select l.id, l.transaction_id, count(o.id) as balance_events
         from wallet_ledger_entries l
         left join outbox_messages o
           on o.event_type = 'WalletBalanceChanged' and o.payload->'data'->>'transactionId' = l.transaction_id::text
        group by l.id, l.transaction_id
       having count(o.id) <> 1`,
    ),
    'lançamento sem exatamente um WalletBalanceChanged',
  ).toEqual([]);

  // 7. Nada na DLQ (todas as mensagens enviadas eram válidas; rejeição de negócio é ack).
  expect(options.dlqDepth, 'DLQ vazia').toBe(0);

  return { outboxEvents: outboxIds.length };
}
