/**
 * Vazão do consumidor SQS por janela de 5s, contada pela inbox (diagnóstico do teste de carga,
 * docs/CARGA.md). Rode logo depois de uma rodada com SQS (o `test:load` só limpa as tabelas no
 * INÍCIO da rodada seguinte, então os dados da última rodada continuam no banco).
 *
 *   bun test/load/diagnostics/inbox-rate.ts
 *
 * `received_at` e `processed_at` da inbox são gravados no mesmo commit: servem para contar
 * mensagens por segundo, não para medir o tempo de processamento de cada uma.
 */
import { SQL } from 'bun';

const sql = new SQL('postgres://wagering:wagering@localhost:5432/wagering_test', { max: 1 });
const rows = await sql`
  with origin as (select min(processed_at) as t0 from inbox_messages)
  select floor(extract(epoch from i.processed_at - o.t0) / 5) * 5 as bucket, count(*)::int as n
    from inbox_messages i, origin o
   group by 1 order by 1`;
console.log('segundos desde a 1ª mensagem   msgs/s');
for (const row of rows) console.log(`${String(row.bucket).padStart(5)}   ${(row.n / 5).toFixed(1).padStart(8)}`);
process.exit(0);
