// Medianas do A/B quente-frias (main × feat/partidas-dobradas). Uso: bun docs/carga/partidas-dobradas/compare.ts docs/carga/partidas-dobradas
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
const dir = process.argv[2]!;
const load = (label: string) => JSON.parse(readFileSync(join(dir, `${label}.json`), 'utf8')).runs[0];
const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]!; };
const metrics: Array<[string, (r: any) => number]> = [
  ['Geral p50 (ms)', (r) => r.http.latencyMs.p50],
  ['Geral p95 (ms)', (r) => r.http.latencyMs.p95],
  ['Geral p99 (ms)', (r) => r.http.latencyMs.p99],
  ['Quente p50 (ms)', (r) => r.groups.quente.latencyMs.p50],
  ['Quente p95 (ms)', (r) => r.groups.quente.latencyMs.p95],
  ['Quente p99 (ms)', (r) => r.groups.quente.latencyMs.p99],
  ['Frias p50 (ms)', (r) => r.groups.frias.latencyMs.p50],
  ['Frias p95 (ms)', (r) => r.groups.frias.latencyMs.p95],
  ['Frias p99 (ms)', (r) => r.groups.frias.latencyMs.p99],
  ['Quente PROCESSED/s', (r) => r.hotWallet.processedPerSecond],
  ['Frias ops/s', (r) => r.groups.frias.logicalOpsPerSecond],
  ['Transações/s (total)', (r) => r.throughput.transactionsPerSecond],
  ['Outbox lag p95 (ms)', (r) => r.outbox.lagMs.p95],
  ['HTTP erros (5xx/rede)', (r) => r.http.errors],
  ['HTTP 4xx inesperados', (r) => r.http.unexpected4xx],
  ['503 (quente+frias)', (r) => r.groups.quente.http503 + r.groups.frias.http503],
];
const labels = (p: string) => [1, 2, 3].map((i) => `${p}-${i}`).filter((l) => existsSync(join(dir, `${l}.json`)));
const A = labels('antes').map(load), B = labels('depois').map(load);
console.log(`antes: ${A.length} rodadas, depois: ${B.length} rodadas`);
console.log('| Métrica (mediana) | Antes (main) | Depois (branch) | Δ | rodadas antes | rodadas depois |');
console.log('|---|---:|---:|---:|---|---|');
for (const [name, f] of metrics) {
  const a = A.map(f), b = B.map(f), ma = median(a), mb = median(b);
  const d = ma === 0 ? (mb === 0 ? '0' : 'novo') : `${(((mb - ma) / ma) * 100).toFixed(1)}%`;
  const fmt = (x: number) => (Number.isInteger(x) ? String(x) : x.toFixed(1));
  console.log(`| ${name} | ${fmt(ma)} | ${fmt(mb)} | ${d} | ${a.map(fmt).join(' / ')} | ${b.map(fmt).join(' / ')} |`);
}
console.log('consistência:', A.map((r) => r.consistency.ok), B.map((r) => r.consistency.ok));
