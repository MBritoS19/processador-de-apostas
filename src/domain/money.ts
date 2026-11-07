import { CurrencyMismatchError, InvalidMoneyError } from './errors';

/** Contrato de entrada/saída: decimal em string, escala 2, ex.: { amount: "25.00", currency: "BRL" }. */
export interface MoneyProps {
  amount: string;
  currency: string;
}

const CENTS_PER_UNIT = 100n;
/** Limite do numeric(20,2): 18 dígitos inteiros + 2 decimais. */
const MAX_ABS_CENTS = 10n ** 20n - 1n;
/** Sem sinal, sem expoente, sem zeros à esquerda, até 18 dígitos inteiros e até 2 casas. */
const AMOUNT_PATTERN = /^(0|[1-9]\d{0,17})(?:\.(\d{1,2}))?$/;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;

/**
 * Valor monetário imutável. Internamente é um bigint em centavos: exato, sem `number`
 * em nenhum ponto e com escala fixa de 2. Pode ficar negativo como resultado de
 * operação (subtract/negate), mas a entrada (`from`) só aceita valores não negativos.
 */
export class Money {
  private constructor(
    private readonly cents: bigint,
    readonly currency: string,
  ) {
    if (cents > MAX_ABS_CENTS || cents < -MAX_ABS_CENTS) {
      throw new InvalidMoneyError('valor excede o limite de 18 dígitos inteiros');
    }
    Object.freeze(this);
  }

  static from(props: MoneyProps): Money {
    const { amount, currency } = props;
    if (typeof amount !== 'string') {
      throw new InvalidMoneyError('amount deve ser uma string decimal');
    }
    const match = AMOUNT_PATTERN.exec(amount);
    if (!match) {
      throw new InvalidMoneyError(
        'amount deve ser decimal não negativo, com até 18 dígitos inteiros e até 2 casas decimais',
      );
    }
    const [, integer = '0', fraction = ''] = match;
    const cents = BigInt(integer) * CENTS_PER_UNIT + BigInt(fraction.padEnd(2, '0'));
    return new Money(cents, Money.validCurrency(currency));
  }

  static zero(currency: string): Money {
    return new Money(0n, Money.validCurrency(currency));
  }

  /** Decimal com exatamente 2 casas, ex.: "25.00" ou "-0.50". */
  get amount(): string {
    const negative = this.cents < 0n;
    const abs = negative ? -this.cents : this.cents;
    const fraction = (abs % CENTS_PER_UNIT).toString().padStart(2, '0');
    return `${negative ? '-' : ''}${abs / CENTS_PER_UNIT}.${fraction}`;
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.cents + other.cents, this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.cents - other.cents, this.currency);
  }

  negate(): Money {
    return new Money(-this.cents, this.currency);
  }

  isZero(): boolean {
    return this.cents === 0n;
  }

  isPositive(): boolean {
    return this.cents > 0n;
  }

  isNegative(): boolean {
    return this.cents < 0n;
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.cents < other.cents;
  }

  /** Moedas diferentes não são iguais (não lança). */
  equals(other: Money): boolean {
    return this.currency === other.currency && this.cents === other.cents;
  }

  toJSON(): MoneyProps {
    return { amount: this.amount, currency: this.currency };
  }

  toString(): string {
    return `${this.amount} ${this.currency}`;
  }

  private assertSameCurrency(other: Money): void {
    if (other.currency !== this.currency) {
      throw new CurrencyMismatchError(this.currency, other.currency);
    }
  }

  private static validCurrency(currency: unknown): string {
    if (typeof currency !== 'string' || !CURRENCY_PATTERN.test(currency)) {
      throw new InvalidMoneyError('currency deve ser um código ISO-4217 de 3 letras maiúsculas');
    }
    return currency;
  }
}
