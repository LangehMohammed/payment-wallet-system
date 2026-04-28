import { Decimal } from '@prisma/client/runtime/client';

/**
 * Serializes a Prisma Decimal to a fixed-precision string.
 *
 * Usage:
 *   serializeDecimal(wallet.availableBalance) → "100.50"
 *   serializeDecimal(new Decimal("0"))        → "0.00"
 *   serializeDecimal(new Decimal("1234.5678")) → "1234.57"
 */
export function serializeDecimal(value: Decimal): string {
  return value.toFixed(2);
}
