import {
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { Prisma, Provider, TransactionStatus } from '@prisma/client';
import { AuditLogger } from '@app/common/audit/audit-logger.service';
import { PrismaService } from '@app/prisma/prisma.service';
import { WalletRepository } from '../wallet/wallet.repository';
import { UsersRepository } from '../user/users.repository';
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
    private readonly usersRepository: UsersRepository,
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
    const wallet = await this.walletRepository.findByUserId(userId);
    if (!wallet) throw new NotFoundException('Wallet not found');

    this.walletRepository.assertActive(wallet);
    this.walletRepository.assertCurrencyMatch(wallet, dto.currency);

    const provider = this.providerRegistry.resolve(dto.provider);

    let braintreeCustomerId: string | undefined;
    if (dto.provider === Provider.PAYPAL) {
      const userInternal =
        await this.usersRepository.findPaymentInternalById(userId);
      braintreeCustomerId = userInternal?.braintreeCustomerId ?? undefined;
    }

    const result = await provider.createDepositIntent({
      userId,
      walletId: wallet.id,
      amount: dto.amount,
      currency: dto.currency,
      customerId: braintreeCustomerId, // Passed to Braintree only; undefined for Stripe (ignored by StripeProvider).
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
   *   4. Create Transaction (INITIATED) + OutboxEvent.
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
      const wallet = await this.walletRepository.findByUserId(userId);
      if (!wallet) throw new NotFoundException('Wallet not found');

      const locked = await this.walletRepository.lockWallet(wallet.id, tx);

      this.walletRepository.assertActive(locked);
      this.walletRepository.assertCurrencyMatch(locked, dto.currency);

      await this.walletRepository.creditPending(locked.id, amount, tx);

      const outboxPayload: Record<string, unknown> = {
        walletId: locked.id,
        userId,
        amount: amount.toString(),
        currency: dto.currency,
      };

      if (dto.provider === Provider.STRIPE && dto.paymentIntentId) {
        outboxPayload.paymentIntentId = dto.paymentIntentId;
      }

      if (dto.provider === Provider.PAYPAL) {
        if (dto.nonce) outboxPayload.nonce = dto.nonce;
        if (dto.braintreeCustomerId) {
          outboxPayload.customerId = dto.braintreeCustomerId;
        }
      }

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
   */
  async createPayout(
    userId: string,
    dto: CreatePayoutDto,
  ): Promise<{ transactionId: string; status: TransactionStatus }> {
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
      const wallet = await this.walletRepository.findByUserId(userId);
      if (!wallet) throw new NotFoundException('Wallet not found');

      const locked = await this.walletRepository.lockWallet(wallet.id, tx);

      this.walletRepository.assertActive(locked);
      this.walletRepository.assertCurrencyMatch(locked, dto.currency);

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

      await this.walletRepository.debitAvailableAndLock(locked.id, amount, tx);

      const outboxPayload: Record<string, unknown> = {
        walletId: locked.id,
        userId,
        amount: amount.toString(),
        currency: dto.currency,
      };

      if (dto.provider === Provider.STRIPE && dto.stripeConnectedAccountId) {
        outboxPayload.stripeConnectedAccountId = dto.stripeConnectedAccountId;
      }

      if (dto.provider === Provider.PAYPAL && dto.paypalEmail) {
        outboxPayload.paypalEmail = dto.paypalEmail;
      }

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
