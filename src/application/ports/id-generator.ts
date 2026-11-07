/** Gera ids (UUID) para transações, lançamentos e eventos. */
export interface IdGenerator {
  uuid(): string;
}
