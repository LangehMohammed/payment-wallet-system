import { Injectable } from '@nestjs/common';
import { Provider } from '@prisma/client';
import { IPaymentProvider } from '../interface/payment-provider.interface';
import { StripeProvider } from '../stripe.provider';
import { PaypalProvider } from '../paypal.provider';

/**
 * Registry that maps a Prisma `Provider` enum value to its concrete adapter.
 *
 * The processor calls `resolve(provider)` — no if/else chains anywhere in
 * the processing pipeline. Adding a new provider means:
 *   1. Add a new value to the Prisma `Provider` enum via migration.
 *   2. Create a new `XxxProvider` class implementing `IPaymentProvider`.
 *   3. Register it in the `registry` map below.
 *   4. Provide it in `PaymentModule`.
 *
 * `INTERNAL` is explicitly excluded — internal transfers settle synchronously
 * in `TransactionService.transfer()` and never enter the outbox as pending.
 * If an INTERNAL event appears in the outbox it is a data-integrity bug and
 * should surface loudly rather than being silently skipped.
 */
@Injectable()
export class PaymentProviderRegistry {
  private readonly registry: Partial<Record<Provider, IPaymentProvider>>;

  constructor(
    private readonly stripeProvider: StripeProvider,
    private readonly paypalProvider: PaypalProvider,
  ) {
    this.registry = {
      [Provider.STRIPE]: this.stripeProvider,
      [Provider.PAYPAL]: this.paypalProvider,
    };
  }

  /**
   * Returns the provider adapter for the given `Provider` enum value.
   *
   * @throws Error if the provider has no registered adapter.
   *   This is a programming error (missing registration), not a runtime
   *   recoverable failure — let it propagate so the processor increments
   *   retryCount and the misconfiguration is visible in logs/alerts.
   */
  resolve(provider: Provider): IPaymentProvider {
    const adapter = this.registry[provider];
    if (!adapter) {
      throw new Error(
        `No payment provider adapter registered for provider "${provider}". ` +
          'Register it in PaymentProviderRegistry.',
      );
    }
    return adapter;
  }
}
