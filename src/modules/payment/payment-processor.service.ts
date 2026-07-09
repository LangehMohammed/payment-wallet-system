import { Injectable, Logger, Inject } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import Redis from 'ioredis';
import { PaymentRepository } from './payment.repository';
import { PaymentSettlementService } from './payment-settlement.service';
import { PaymentProviderRegistry } from './providers/registry/payment-provider.registry';

const PROCESSOR_LOCK_KEY = 'locks:payment_processor';

// Lock TTL must exceed the maximum expected processing duration.
// Worst case: 100 events * (5s provider timeout + 1s DB write) = 10 minutes.
// 15 minutes provides a 1.5× safety margin while ensuring a crashed instance's
// lock expires before the next poll cycle (30s intervals mean the lock should
// never naturally outlive 2-3 missed cycles). If the process is killed mid-run
// (SIGKILL), the lock expires automatically and the next instance can proceed.
const PROCESSOR_LOCK_TTL_SECONDS = 15 * 60; // 15 minutes

/**
 * Scheduled outbox consumer — polls pending OutboxEvents and initiates them
 * through external payment providers.
 *
 * ## Responsibility: INITIATE, not settle
 * The processor calls the provider and then branches on the result:
 *   - Braintree (sync):  result is final → call PaymentSettlementService.settle()
 *                        or .fail() immediately.
 *   - Stripe/PayPal (async): provider accepted the request but outcome is pending
 *                        → mark OutboxEvent delivered and exit.
 *                        The webhook module receives the authoritative status
 *                        and drives settlement.
 *
 * ## Decision matrix (from ProviderResult)
 *   requiresWebhook: true  + success: true  → markDelivered, await webhook
 *   requiresWebhook: true  + success: false → provider rejected synchronously
 *                                             before async processing → .fail()
 *   requiresWebhook: false + success: true  → .settle() immediately
 *   requiresWebhook: false + success: false → .fail() immediately
 *
 * ## Flow
 * Every 30 seconds:
 *   1. Acquire distributed Redis lock (prevents concurrent processing).
 *   2. Fetch up to 100 pending provider events (DEPOSIT_INITIATED, WITHDRAWAL_INITIATED).
 *   3. For each event (sequential — avoids DB contention on wallet rows):
 *      a. Extract userId from event.payload.
 *      b. Resolve provider adapter from transaction.provider.
 *      c. Call provider.process(payload, transactionType).
 *      d. Branch on requiresWebhook + success (see above).
 *      e. On exception → incrementRetry (max 5, then dead letter).
 */
@Injectable()
export class PaymentProcessorService {
  private readonly logger = new Logger(PaymentProcessorService.name);

  constructor(
    private readonly paymentRepository: PaymentRepository,
    private readonly settlementService: PaymentSettlementService,
    private readonly providerRegistry: PaymentProviderRegistry,
    @Inject('REDIS_CLIENT') private readonly redis: Redis,
  ) {}

  @Cron('*/30 * * * * *')
  async processOutbox(): Promise<void> {
    const acquired = await this.redis.set(
      PROCESSOR_LOCK_KEY,
      '1',
      'EX',
      PROCESSOR_LOCK_TTL_SECONDS,
      'NX',
    );

    if (!acquired) {
      this.logger.debug(
        'Payment processing skipped — another instance is running it',
      );
      return;
    }

    try {
      await this.processBatch();
    } catch (error) {
      this.logger.error('Payment processing batch failed', error);
    } finally {
      await this.redis.del(PROCESSOR_LOCK_KEY);
    }
  }

  // ── Private ────────────────────────────────────────────────────────────────

  private async processBatch(): Promise<void> {
    const events = await this.paymentRepository.findPendingProviderEvents(100);

    if (events.length === 0) {
      this.logger.debug('No pending outbox events to process');
      return;
    }

    this.logger.log(`Processing ${events.length} pending outbox events`);

    for (const event of events) {
      await this.processEvent(event);
    }

    this.logger.log(`Batch complete — processed ${events.length} events`);
  }

  /**
   * Processes a single outbox event.
   *
   * Branches on ProviderResult.requiresWebhook to determine whether to
   * settle immediately (Braintree) or defer to the webhook module (Stripe/PayPal).
   *
   * ## Branching
   *   - Provider throws                          → incrementRetry
   *   - requiresWebhook: true  + success: true   → markDelivered (webhook settles)
   *   - requiresWebhook: true  + success: false  → .fail() (provider rejected sync)
   *   - requiresWebhook: false + success: true   → .settle()
   *   - requiresWebhook: false + success: false  → .fail()
   *   - Settlement/fail throws                   → incrementRetry
   */
  private async processEvent(event: any): Promise<void> {
    try {
      const payload = event.payload as Record<string, unknown>;
      const userId = payload['userId'];

      if (typeof userId !== 'string' || userId.length === 0) {
        this.logger.error(
          'OutboxEvent payload missing userId — cannot build TransactionContext',
          { eventId: event.id, transactionId: event.transactionId },
        );
        await this.paymentRepository.incrementRetry(event.id);
        return;
      }

      const transaction = await this.paymentRepository.findTransactionById(
        event.transactionId,
      );

      if (!transaction) {
        this.logger.error('Transaction not found for outbox event', {
          eventId: event.id,
          transactionId: event.transactionId,
        });
        await this.paymentRepository.incrementRetry(event.id);
        return;
      }

      if (!transaction.provider) {
        this.logger.error('Transaction has no provider', {
          eventId: event.id,
          transactionId: event.transactionId,
        });
        await this.paymentRepository.incrementRetry(event.id);
        return;
      }
      
      const txCtx = { ...transaction, userId };

      const provider = this.providerRegistry.resolve(transaction.provider);

      this.logger.log('Calling provider', {
        provider: transaction.provider,
        transactionId: transaction.id,
        transactionType: transaction.type,
        eventId: event.id,
      });

      const result = await provider.process(payload, transaction.type);

      if (result.requiresWebhook && result.success) {
        await this.paymentRepository.markDelivered(event.id);
        this.logger.log(
          'Provider accepted (async) — outbox marked delivered, awaiting webhook',
          {
            provider: transaction.provider,
            transactionId: transaction.id,
            providerRef: result.providerRef,
          },
        );
      } else if (result.requiresWebhook && !result.success) {
        this.logger.warn(
          'Async provider rejected request synchronously — failing transaction',
          {
            provider: transaction.provider,
            transactionId: transaction.id,
            errorMessage: result.errorMessage,
          },
        );
        await this.settlementService.fail(txCtx, event.id, result);
      } else if (result.success) {
        await this.settlementService.settle(txCtx, event.id, result);
      } else {
        await this.settlementService.fail(txCtx, event.id, result);
      }
    } catch (error) {
      this.logger.error('Event processing failed — incrementing retry count', {
        eventId: event.id,
        transactionId: event.transactionId,
        error: error instanceof Error ? error.message : String(error),
      });

      await this.paymentRepository.incrementRetry(event.id);
    }
  }
}
