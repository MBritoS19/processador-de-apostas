/** Relógio injetado: o use case não lê o relógio do sistema diretamente (testes determinísticos). */
export interface Clock {
  now(): Date;
}
