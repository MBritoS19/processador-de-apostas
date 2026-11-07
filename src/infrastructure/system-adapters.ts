import { randomUUID } from 'node:crypto';
import type { Clock } from '../application/ports/clock';
import type { IdGenerator } from '../application/ports/id-generator';

export const systemClock: Clock = { now: () => new Date() };

export const randomIdGenerator: IdGenerator = { uuid: () => randomUUID() };
