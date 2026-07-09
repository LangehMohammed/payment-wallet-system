import { Injectable } from '@nestjs/common';
import {
  OutboxEvent,
  Prisma,
  PrismaClient,
  Provider,
  TransactionStatus,
} from '@prisma/client';
import { PrismaService } from '@app/prisma/prisma.service';

export interface CreatePaymentLogInput {
  transactionId: string;
  provider: Provider;
  providerRef?: string;
  payload: Prisma.InputJsonValue;
  status: TransactionStatus;
}

export type TransactionClient = Omit<
  PrismaClient,
  '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'
>;

@Injectable()
export class PaymentRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Centralized transaction wrapper
   */
  async withTransaction<T>(
    callback: (tx: TransactionClient) => Promise<T>,
  ): Promise<T> {
    return this.prisma.$transaction(async (tx) => {
      return callback(tx as TransactionClient);
    });
  }

  // ── Outbox reads ───────────────────────────────────────────────────────────

  /**
   * Fetches pending outbox events ordered oldest-first.
   *
   * Filters:
   *   - deliveredAt IS NULL  — not yet processed
   *   - retryCount < maxRetries — not exhausted (default 5, matches schema index)
   *   - eventType IN ('DEPOSIT_INITIATED', 'WITHDRAWAL_INITIATED') — only events
   *     that require external provider calls; TRANSFER_SETTLED events are
   *     informational (internal settlement) and excluded here.
   *
   * The @@index([deliveredAt, retryCount]) on OutboxEvent covers this query.
   */
  async findPendingProviderEvents(
    limit = 100,
    maxRetries = 5,
  ): Promise<OutboxEvent[]> {
    return this.prisma.outboxEvent.findMany({
      where: {
        deliveredAt: null,
        retryCount: { lt: maxRetries },
        eventType: {
          in: ['DEPOSIT_INITIATED', 'WITHDRAWAL_INITIATED'],
        },
      },
      orderBy: { createdAt: 'asc' },
      take: limit,
    });
  }

  // ── Outbox mutations ───────────────────────────────────────────────────────

  async markDelivered(
    id: string,
    tx?: TransactionClient,
  ): Promise<void> {
    const client = tx ?? this.prisma;
    await client.outboxEvent.update({
      where: { id },
      data: { deliveredAt: new Date() },
    });
  }

  async incrementRetry(id: string): Promise<void> {
    await this.prisma.outboxEvent.update({
      where: { id },
      data: { retryCount: { increment: 1 } },
    });
  }

  // ── PaymentLog writes ──────────────────────────────────────────────────────

  /**
   * Writes a PaymentLog row.
   *
   * Called inside the settlement/failure atomic block so the log and the
   * balance mutation land in the same transaction.
   */
  async createPaymentLog(
    input: CreatePaymentLogInput,
    tx: TransactionClient,
  ): Promise<void> {
    await tx.paymentLog.create({
      data: {
        transactionId: input.transactionId,
        provider: input.provider,
        providerRef: input.providerRef,
        payload: input.payload,
        status: input.status,
      },
    });
  }

  // ── Transaction mutations ──────────────────────────────────────────────────

  /**
   * Stamps the external provider reference onto the Transaction row.
   * Called inside the settlement atomic block alongside status → SETTLED.
   */
  async setProviderRef(
    transactionId: string,
    providerRef: string,
    tx: TransactionClient,
  ): Promise<void> {
    await tx.transaction.update({
      where: { id: transactionId },
      data: { providerRef },
    });
  }

  /**
   * Fetches the Transaction with its associated wallet IDs and type.
   * Used by the settlement service to route the correct balance mutation.
   */
  async findTransactionById(transactionId: string) {
    return this.prisma.transaction.findUnique({
      where: { id: transactionId },
      select: {
        id: true,
        type: true,
        status: true,
        amount: true,
        currency: true,
        provider: true,
        senderWalletId: true,
        receiverWalletId: true,
      },
    });
  }

  /**
   * Returns the user's paypalEmail only.
   * Intentionally narrow — this repository owns nothing beyond the Connect field.
   */
  async findUserById(id: string): Promise<{ paypalEmail: string } | null> {
    return this.prisma.user.findUnique({
      where: { id },
      select: { paypalEmail: true },
    });
  }
}
