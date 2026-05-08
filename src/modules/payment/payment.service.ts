import {
  Injectable,
  Logger,
  ConflictException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { Prisma, Provider, TransactionStatus } from '@prisma/client';
import { AuditLogger } from '@app/common/audit/audit-logger.service';
import { PrismaService } from '@app/prisma/prisma.service';
import { WalletRepository } from '../wallet/wallet.repository';
import { PaymentProviderRegistry } from './providers/registry/payment-provider.registry';
import {
  CreateDepositIntentDto,
  ConfirmDepositDto,
  CreatePayoutDto,
} from './dto';
import { DepositIntentResult } from './providers/interface/payment-provider.interface';

/**
 * Payment service — orchestrates deposit intent creation and confirmation.
 *
 * This service sits between the controller and the provider/repository layers.
 * It handles business logic like idempotency checks, wallet validation, and
 * transaction creation, delegating provider calls to the registry.
 */
@Injectable()
export class PaymentService {
  private readonly logger = new Logger(PaymentService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly walletRepository: WalletRepository,
    private readonly providerRegistry: PaymentProviderRegistry,
    private readonly audit: AuditLogger,
  ) {}

  // ── Deposit Intent ─────────────────────────────────────────────────────────

  /**
   * Creates a deposit intent with the selected provider.
   *
   * Returns client_secret (Stripe) or client_token (Braintree) for frontend
   * payment collection. No database writes — this is a pure provider call.
   *
   * The frontend will use this credential to initialize the payment UI
   * (Stripe Financial Connections or Braintree Drop-in).
   */
  async createDepositIntent(
    userId: string,
    dto: CreateDepositIntentDto,
  ): Promise<DepositIntentResult> {
    // Validate user has an active wallet
    const wallet = await this.walletRepository.findByUserId(userId);
    if (!wallet) {
      throw new ConflictException('Wallet not found');
    }

    this.walletRepository.assertActive(wallet);
    this.walletRepository.assertCurrencyMatch(wallet, dto.currency);

    // Resolve provider and call createDepositIntent
    const provider = this.providerRegistry.resolve(dto.provider);

    const result = await provider.createDepositIntent({
      userId,
      walletId: wallet.id,
      amount: dto.amount,
      currency: dto.currency,
      customerId: dto.braintreeCustomerId, // Only used by Braintree
    });

    if (!result.success) {
      this.logger.error('Deposit intent creation failed', {
        userId,
        provider: dto.provider,
        errorMessage: result.errorMessage,
      });
    }

    return result;
  }

  // ── Deposit Confirmation ───────────────────────────────────────────────────

  /**
   * Confirms a deposit after the frontend has collected payment details.
   *
   * Flow (Option B — async settlement):
   *   1. Check idempotency — return existing transaction if key already used.
   *   2. Lock wallet and validate.
   *   3. Credit pendingBalance (funds not yet spendable).
   *   4. Create Transaction (INITIATED) + LedgerEntry + OutboxEvent.
   *   5. Return transaction ID — the outbox processor will settle async.
   *
   * The provider.confirmDeposit() call happens in the outbox processor, not here.
   * This endpoint just writes the intent to the outbox for async processing.
   */
  async confirmDeposit(
    userId: string,
    dto: ConfirmDepositDto,
  ): Promise<{ transactionId: string; status: TransactionStatus }> {
    // Idempotency check (outside tx — cheap read first)
    const existing = await this.prisma.transaction.findUnique({
      where: { idempotencyKey: dto.idempotencyKey },
      select: { id: true, status: true },
    });

    if (existing) {
      this.audit.log('IDEMPOTENT_REPLAY', {
        userId,
        meta: {
          idempotencyKey: dto.idempotencyKey,
          transactionId: existing.id,
        },
      });
      return { transactionId: existing.id, status: existing.status };
    }

    const amount = new Prisma.Decimal(dto.amount);

    const result = await this.prisma.$transaction(async (tx) => {
      // Lock wallet row — prevents concurrent deposit/withdrawal races
      const wallet = await this.walletRepository.findByUserId(userId);
      const locked = await this.walletRepository.lockWallet(wallet.id, tx);

      this.walletRepository.assertActive(locked);
      this.walletRepository.assertCurrencyMatch(locked, dto.currency);

      // Credit pendingBalance — funds not yet spendable
      await this.walletRepository.creditPending(locked.id, amount, tx);

      // Prepare outbox payload with provider-specific fields
      const outboxPayload: Record<string, unknown> = {
        walletId: locked.id,
        userId,
        amount: amount.toString(),
        currency: dto.currency,
      };

      // Add Stripe-specific fields
      if (dto.provider === Provider.STRIPE && dto.paymentIntentId) {
        outboxPayload.paymentIntentId = dto.paymentIntentId;
      }

      // Add Braintree-specific fields
      if (dto.provider === Provider.PAYPAL) {
        if (dto.nonce) outboxPayload.nonce = dto.nonce;
        if (dto.braintreeCustomerId) {
          outboxPayload.customerId = dto.braintreeCustomerId;
        }
      }

      // Create Transaction (INITIATED) + OutboxEvent
      // NOTE: No LedgerEntry here — ledger is only written on settlement when
      // funds move from pending → available. This prevents double-accounting.
      const transaction = await tx.transaction.create({
        data: {
          idempotencyKey: dto.idempotencyKey,
          type: 'DEPOSIT',
          status: TransactionStatus.INITIATED,
          amount,
          currency: dto.currency,
          description: dto.description,
          receiverWalletId: locked.id,
          provider: dto.provider,
        },
      });

      await tx.outboxEvent.create({
        data: {
          transactionId: transaction.id,
          eventType: 'DEPOSIT_INITIATED',
          payload: outboxPayload as Prisma.InputJsonValue,
        },
      });

      return transaction;
    });

    this.audit.log('DEPOSIT_INITIATED', {
      userId,
      meta: {
        transactionId: result.id,
        amount: dto.amount,
        currency: dto.currency,
        provider: dto.provider,
      },
    });

    return { transactionId: result.id, status: result.status };
  }

  // ── Payout ─────────────────────────────────────────────────────────────────

  /**
   * Creates a payout (withdrawal) to an external account.
   *
   * Flow:
   *   1. Check idempotency — return existing transaction if key already used.
   *   2. Lock wallet and validate sufficient available balance.
   *   3. Debit availableBalance, credit lockedBalance (funds held until settlement).
   *   4. Create Transaction (INITIATED) + OutboxEvent.
   *   5. Return transaction ID — the outbox processor will call provider.createPayout() async.
   *
   * The provider.createPayout() call happens in the outbox processor, not here.
   * This follows the same async pattern as deposits for consistency.
   */
  async createPayout(
    userId: string,
    dto: CreatePayoutDto,
  ): Promise<{ transactionId: string; status: TransactionStatus }> {
    // Idempotency check (outside tx — cheap read first)
    const existing = await this.prisma.transaction.findUnique({
      where: { idempotencyKey: dto.idempotencyKey },
      select: { id: true, status: true },
    });

    if (existing) {
      this.audit.log('IDEMPOTENT_REPLAY', {
        userId,
        meta: {
          idempotencyKey: dto.idempotencyKey,
          transactionId: existing.id,
        },
      });
      return { transactionId: existing.id, status: existing.status };
    }

    const amount = new Prisma.Decimal(dto.amount);

    const result = await this.prisma.$transaction(async (tx) => {
      // Lock wallet row — prevents concurrent races
      const wallet = await this.walletRepository.findByUserId(userId);
      const locked = await this.walletRepository.lockWallet(wallet.id, tx);

      this.walletRepository.assertActive(locked);
      this.walletRepository.assertCurrencyMatch(locked, dto.currency);

      // Check sufficient balance
      if (locked.availableBalance.lessThan(amount)) {
        this.audit.warn('WITHDRAWAL_FAILED', {
          userId,
          meta: {
            reason: 'INSUFFICIENT_BALANCE',
            available: locked.availableBalance.toString(),
            required: amount.toString(),
          },
        });
        throw new UnprocessableEntityException('Insufficient balance.');
      }

      // Debit available, credit locked — funds unavailable until settlement
      await this.walletRepository.debitAvailableAndLock(locked.id, amount, tx);

      // Prepare outbox payload with provider-specific fields
      const outboxPayload: Record<string, unknown> = {
        walletId: locked.id,
        userId,
        amount: amount.toString(),
        currency: dto.currency,
      };

      // Add Stripe-specific fields
      if (dto.provider === Provider.STRIPE && dto.stripeConnectedAccountId) {
        outboxPayload.stripeConnectedAccountId = dto.stripeConnectedAccountId;
      }

      // Add PayPal-specific fields
      if (dto.provider === Provider.PAYPAL && dto.paypalEmail) {
        outboxPayload.paypalEmail = dto.paypalEmail;
      }

      // Create Transaction (INITIATED) + OutboxEvent
      // NOTE: No LedgerEntry here — ledger is only written on settlement when
      // locked balance is decremented (funds leave the system).
      const transaction = await tx.transaction.create({
        data: {
          idempotencyKey: dto.idempotencyKey,
          type: 'WITHDRAWAL',
          status: TransactionStatus.INITIATED,
          amount,
          currency: dto.currency,
          description: dto.description,
          senderWalletId: locked.id,
          provider: dto.provider,
        },
      });

      await tx.outboxEvent.create({
        data: {
          transactionId: transaction.id,
          eventType: 'WITHDRAWAL_INITIATED',
          payload: outboxPayload as Prisma.InputJsonValue,
        },
      });

      return transaction;
    });

    this.audit.log('WITHDRAWAL_INITIATED', {
      userId,
      meta: {
        transactionId: result.id,
        amount: dto.amount,
        currency: dto.currency,
        provider: dto.provider,
      },
    });

    return { transactionId: result.id, status: result.status };
  }
}
