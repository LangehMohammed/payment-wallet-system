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
 * Scheduled outbox consumer — polls pending OutboxEvents and processes them
 * through external payment providers.
 *
 * ## Flow
 * Every 30 seconds (configurable via @Cron):
 *   1. Acquire a distributed Redis lock to prevent concurrent processing.
 *   2. Fetch up to 100 pending provider events (DEPOSIT_INITIATED, WITHDRAWAL_INITIATED).
 *   3. For each event (sequential, not parallel):
 *      a. Resolve the provider adapter from transaction.provider.
 *      b. Call provider.process(event.payload).
 *      c. On success → settle (balance mutation + status → SETTLED + PaymentLog).
 *      d. On failure → fail (balance reversal + status → FAILED + PaymentLog).
 *      e. On exception → increment retryCount (max 5, then dead letter).
 *
 * ## Concurrency control
 * The Redis lock ensures only one instance processes the outbox at a time.
 * Events are processed sequentially to avoid DB contention on wallet rows.
 *
 * ## Retry strategy
 * Linear retry count (no backoff yet). Events with retryCount >= 5 are filtered
 * out by `findPendingProviderEvents` and require manual intervention (DLQ sweep).
 *
 * ## Error boundaries
 * - Provider throws → catch → incrementRetry → event stays pending.
 * - Settlement write fails → transaction rolls back → incrementRetry → event stays pending.
 * - Lock unavailable → skip cycle → next poll in 30s.
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

  /**
   * Scheduled task that runs every 30 seconds to process pending provider events.
   * Uses a distributed lock in Redis to ensure only one instance performs processing.
   */
  @Cron('*/30 * * * * *') // Every 30 seconds
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

  /**
   * Fetches and processes a batch of pending outbox events.
   * Sequential processing — no parallel execution to avoid wallet lock contention.
   */
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
   * Processes a single outbox event through the provider and settlement flow.
   *
   * Error handling:
   *   - Provider throws → catch → incrementRetry.
   *   - Settlement throws → catch → incrementRetry.
   *   - Provider returns { success: false } → fail transaction.
   *   - Provider returns { success: true } → settle transaction.
   */
  private async processEvent(event: any): Promise<void> {
    try {
      // Fetch the associated transaction
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

      // Resolve the provider adapter
      const provider = this.providerRegistry.resolve(transaction.provider);

      // Call the provider
      this.logger.log('Calling provider', {
        provider: transaction.provider,
        transactionId: transaction.id,
        transactionType: transaction.type,
        eventId: event.id,
      });

      // Pass transactionType to provider.process() for routing
      const result = await provider.process(
        event.payload as Record<string, unknown>,
        transaction.type,
      );

      // Route based on provider result
      if (result.success) {
        await this.settlementService.settle(transaction, event.id, result);
      } else {
        await this.settlementService.fail(transaction, event.id, result);
      }
    } catch (error) {
      // Any exception (provider throw, settlement write failure, etc.) increments retry.
      // The event stays pending and will be retried next cycle (up to 5 times).
      this.logger.error('Event processing failed — incrementing retry count', {
        eventId: event.id,
        transactionId: event.transactionId,
        error: error instanceof Error ? error.message : String(error),
      });

      await this.paymentRepository.incrementRetry(event.id);
    }
  }
}
