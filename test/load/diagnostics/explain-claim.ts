/**
 * Custo do claim da outbox com backlog sintético (diagnóstico do teste de carga, docs/CARGA.md).
 * Lê o CLAIM_SQL de src/infrastructure/outbox/outbox-store.ts e roda EXPLAIN ANALYZE em dois
 * formatos de backlog: espalhado por muitos agregados e com uma wallet quente à frente.
 *
 *   bun test/load/diagnostics/explain-claim.ts
 *
 * ATENÇÃO: dá TRUNCATE em `outbox_messages` do banco wagering_test (só dele) antes e depois.
 * Não rode junto com outra suíte.
 */
import { SQL } from 'bun';
import { join } from 'node:path';

const url = 'postgres://wagering:wagering@localhost:5432/wagering_test';
if (!url.endsWith('/wagering_test')) throw new Error('só roda no banco wagering_test');
const sql = new SQL(url, { max: 1 });
const source = await Bun.file(join(import.meta.dir, '../../../src/infrastructure/outbox/outbox-store.ts')).text();
const claim = /const CLAIM_SQL = `([\s\S]*?)`;/.exec(source)?.[1];
if (!claim) throw new Error('CLAIM_SQL não encontrado');
// Parâmetros na ordem do SQL: agora e limite do lote.
const query = claim.replace('?', 'now()').replace('?', '10');

async function scenario(label: string, inserts: string[]): Promise<void> {
  await sql`truncate outbox_messages`;
  for (const insert of inserts) await sql.unsafe(insert);
  await sql`analyze outbox_messages`;
  const plan = await sql.begin((tx) => tx.unsafe(`explain (analyze) ${query}`));
  const lines = (plan as Array<Record<string, string>>).map((row) => row['QUERY PLAN']!.trim());
  console.log(`\n== ${label}`);
  console.log(lines.filter((line) => /Execution Time|Index Scan using uq_outbox_seq/.test(line)).join('\n'));
}

const spread = (transactions: number, wallets: number, perWallet: number) => [
  `insert into outbox_messages (id, aggregate_id, event_type, payload, occurred_at)
     select gen_random_uuid(), gen_random_uuid(), 'WagerTransactionProcessed', '{}'::jsonb, now() from generate_series(1, ${transactions})`,
  `insert into outbox_messages (id, aggregate_id, event_type, payload, occurred_at)
     select gen_random_uuid(), w.id, 'WalletBalanceChanged', '{}'::jsonb, now()
       from (select gen_random_uuid() as id from generate_series(1, ${wallets})) w, generate_series(1, ${perWallet})`,
];
const hotWallet = (events: number) => [
  `insert into outbox_messages (id, aggregate_id, event_type, payload, occurred_at)
     select gen_random_uuid(), '00000000-0000-0000-0000-000000000001', 'WalletBalanceChanged', '{}'::jsonb, now() from generate_series(1, ${events})`,
  `insert into outbox_messages (id, aggregate_id, event_type, payload, occurred_at)
     select gen_random_uuid(), gen_random_uuid(), 'WagerTransactionProcessed', '{}'::jsonb, now() from generate_series(1, 20)`,
];

await scenario('3k pendentes espalhados (1.500 transações + 150 wallets × 10)', spread(1_500, 150, 10));
await scenario('30k pendentes espalhados (15.000 transações + 300 wallets × 50)', spread(15_000, 300, 50));
await scenario('3k eventos de UMA wallet à frente + 20 outros', hotWallet(3_000));
await scenario('30k eventos de UMA wallet à frente + 20 outros', hotWallet(30_000));
await sql`truncate outbox_messages`;
process.exit(0);
