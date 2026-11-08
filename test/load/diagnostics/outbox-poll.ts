/**
 * Leitor da outbox (diagnóstico do teste de carga, docs/CARGA.md). Roda em paralelo ao
 * `bun run test:load` e grava, a cada 2s, os pendentes por `event_type` com o número de
 * agregados distintos, e o total já publicado. Mostra se o atraso é de muitos agregados
 * (vazão) ou de um só (serialização por agregado).
 *
 *   bun test/load/diagnostics/outbox-poll.ts <saida.jsonl> <segundos>
 */
import { SQL } from 'bun';

const [out, secondsArg] = process.argv.slice(2);
if (!out) throw new Error('uso: bun test/load/diagnostics/outbox-poll.ts <saida.jsonl> <segundos>');
const seconds = Number(secondsArg ?? 150);

const sql = new SQL('postgres://wagering:wagering@localhost:5432/wagering_test', { max: 1 });
const started = Date.now();
const lines: string[] = [];

while (Date.now() - started < seconds * 1_000) {
  const tick = Date.now();
  const pending = await sql`
    select event_type, count(*)::int as n, count(distinct aggregate_id)::int as aggs
      from outbox_messages where published_at is null group by 1`;
  const [published] = await sql`select count(*)::int as n from outbox_messages where published_at is not null`;
  lines.push(JSON.stringify({ t: tick, published: published.n, pending }));
  await Bun.sleep(Math.max(0, 2_000 - (Date.now() - tick)));
}

await Bun.write(out, lines.join('\n'));
process.exit(0);
