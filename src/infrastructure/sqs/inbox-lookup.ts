import type { EntityManager } from '@mikro-orm/postgresql';
import { InboxMessageRecord } from '../persistence/messages.persistence';
import { translatePersistenceError } from '../persistence/mikro-orm-wager-unit-of-work';

/**
 * Leitura da inbox fora da transação do use case. Só decide o caminho rápido (mensagem já
 * processada) e o diagnóstico de payload divergente; a garantia continua sendo a PK
 * `(consumer_name, message_id)` gravada junto com o efeito.
 */
export class InboxLookup {
  constructor(private readonly em: EntityManager) {}

  async payloadHashOf(consumerName: string, messageId: string): Promise<string | undefined> {
    try {
      const row = await this.em.fork().findOne(InboxMessageRecord, { consumerName, messageId });
      return row?.payloadHash;
    } catch (error) {
      throw translatePersistenceError(error);
    }
  }
}
