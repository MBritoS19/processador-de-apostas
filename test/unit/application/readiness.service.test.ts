import { describe, expect, it } from 'bun:test';
import { ReadinessService, type ReadinessFailureReason } from '../../../src/application/health/readiness.service';
import { DependencyUnreachableError, type ReadinessCheck } from '../../../src/application/ports/readiness-check';

const check = (name: string, impl: (signal: AbortSignal) => Promise<void>): ReadinessCheck => ({ name, check: impl });
const up = (name: string) => check(name, async () => {});
const never = (name: string, seen?: { signal?: AbortSignal }) =>
  check(name, (signal) => {
    if (seen) seen.signal = signal;
    return new Promise<void>(() => {});
  });

const ignore = () => {};

describe('ReadinessService', () => {
  it('ready quando todos os checks passam', async () => {
    const report = await new ReadinessService([up('postgres'), up('sqs')], 100, ignore).evaluate();
    expect(report).toEqual({
      status: 'ready',
      dependencies: { postgres: { status: 'up' }, sqs: { status: 'up' } },
    });
  });

  it('ready sem checks registrados', async () => {
    expect(await new ReadinessService([], 100, ignore).evaluate()).toEqual({ status: 'ready', dependencies: {} });
  });

  it('dependência inalcançável → down/unreachable, sem afetar as demais', async () => {
    const failing = check('sqs', async () => {
      throw new DependencyUnreachableError('sqs');
    });
    const report = await new ReadinessService([up('postgres'), failing], 100, ignore).evaluate();

    expect(report.status).toBe('not_ready');
    expect(report.dependencies).toEqual({
      postgres: { status: 'up' },
      sqs: { status: 'down', reason: 'unreachable' },
    });
  });

  it('check que nunca responde → down/timeout dentro do prazo, e o signal é abortado', async () => {
    const seen: { signal?: AbortSignal } = {};
    const startedAt = performance.now();

    const report = await new ReadinessService([never('postgres', seen)], 50, ignore).evaluate();

    expect(performance.now() - startedAt).toBeLessThan(1000);
    expect(report.dependencies['postgres']).toEqual({ status: 'down', reason: 'timeout' });
    expect(seen.signal?.aborted).toBe(true);
  });

  it('erro genérico → reason "error", sem vazar a mensagem do driver', async () => {
    const leaky = check('postgres', async () => {
      throw new Error('connect ECONNREFUSED 10.0.3.7:5432 user=wagering');
    });
    const report = await new ReadinessService([leaky], 100, ignore).evaluate();

    expect(report.dependencies['postgres']).toEqual({ status: 'down', reason: 'error' });
    expect(JSON.stringify(report)).not.toContain('10.0.3.7');
  });

  it('erro não-Error (throw de string) também vira "error"', async () => {
    const weird = check('sqs', async () => {
      throw 'boom';
    });
    const report = await new ReadinessService([weird], 100, ignore).evaluate();
    expect(report.dependencies['sqs']).toEqual({ status: 'down', reason: 'error' });
  });

  it('notifica cada falha com o erro original, para log no servidor', async () => {
    const original = new DependencyUnreachableError('sqs');
    const failures: Array<[string, ReadinessFailureReason, unknown]> = [];
    const service = new ReadinessService(
      [up('postgres'), check('sqs', async () => Promise.reject(original)), never('slow')],
      50,
      (...args) => failures.push(args),
    );

    await service.evaluate();

    expect(failures).toHaveLength(2);
    expect(failures).toContainEqual(['sqs', 'unreachable', original]);
    expect(failures.find(([name]) => name === 'slow')?.[1]).toBe('timeout');
  });

  it('reason pertence sempre ao conjunto fechado', async () => {
    const report = await new ReadinessService(
      [
        check('a', async () => Promise.reject(new DependencyUnreachableError('a'))),
        check('b', async () => Promise.reject(new TypeError('x'))),
        never('c'),
      ],
      50,
      ignore,
    ).evaluate();

    for (const dependency of Object.values(report.dependencies)) {
      expect(dependency.status).toBe('down');
      if (dependency.status === 'down') expect(['timeout', 'unreachable', 'error']).toContain(dependency.reason);
    }
  });
});
