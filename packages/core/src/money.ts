/**
 * Money is handled as integer paise in application code to avoid floating point drift.
 * Postgres stores NUMERIC(18,2) rupees, which node-postgres returns as strings.
 */
export type Paise = number;

export function toPaise(rupees: number | string): Paise {
  const n = typeof rupees === 'string' ? Number(rupees) : rupees;
  if (!Number.isFinite(n)) throw new Error(`Invalid money value: ${rupees}`);
  return Math.round(n * 100);
}

export function toRupees(paise: Paise): number {
  return paise / 100;
}

/** Format paise as a NUMERIC literal for SQL parameters, e.g. 123456 -> "1234.56". */
export function toSql(paise: Paise): string {
  if (!Number.isSafeInteger(paise)) throw new Error(`Paise must be a safe integer: ${paise}`);
  const sign = paise < 0 ? '-' : '';
  const abs = Math.abs(paise);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}
