import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { CurrentUser } from '@app/common/decorators';
import { JwtPayload } from '../auth/interfaces/jwt-payload.interface';
import { PaymentService } from './payment.service';
import {
  CreateDepositIntentDto,
  ConfirmDepositDto,
  CreatePayoutDto,
} from './dto';

@ApiTags('Payments')
@ApiBearerAuth()
@Controller('payments')
export class PaymentController {
  constructor(private readonly paymentService: PaymentService) {}

  // ── Deposit Intent ─────────────────────────────────────────────────────────

  @Post('deposits/intents')
  @HttpCode(HttpStatus.OK)
  // 20 intent creations per minute — generous for legitimate retries, protective against abuse
  @Throttle({ global: { ttl: 60_000, limit: 20 } })
  @ApiOperation({
    summary:
      'Create deposit intent — returns client_secret (Stripe) or client_token (Braintree) for frontend',
  })
  @ApiResponse({
    status: 200,
    description: 'Returns payment collection credential for frontend',
    schema: {
      oneOf: [
        {
          type: 'object',
          properties: {
            success: { type: 'boolean', example: true },
            clientSecret: {
              type: 'string',
              example: 'pi_1234567890_secret_abcdef',
              description: 'Stripe PaymentIntent client_secret',
            },
            intentId: { type: 'string', example: 'pi_1234567890' },
          },
        },
        {
          type: 'object',
          properties: {
            success: { type: 'boolean', example: true },
            clientToken: {
              type: 'string',
              example: 'eyJhbGciOiJIUzI1NiJ9...',
              description: 'Braintree client token',
            },
          },
        },
      ],
    },
  })
  @ApiResponse({ status: 400, description: 'Validation error' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Wallet is not active' })
  @ApiResponse({ status: 409, description: 'Wallet not found' })
  @ApiResponse({ status: 429, description: 'Rate limit exceeded' })
  createDepositIntent(
    @CurrentUser() user: JwtPayload,
    @Body() dto: CreateDepositIntentDto,
  ) {
    return this.paymentService.createDepositIntent(user.sub, dto);
  }

  // ── Deposit Confirmation ───────────────────────────────────────────────────

  @Post('deposits/confirm')
  @HttpCode(HttpStatus.ACCEPTED) // 202 — async settlement via outbox
  // 10 confirmations per minute — prevents rapid-fire retries
  @Throttle({ global: { ttl: 60_000, limit: 10 } })
  @ApiOperation({
    summary:
      'Confirm deposit after frontend payment collection — writes Transaction (INITIATED) + OutboxEvent',
    description:
      'The deposit is not immediately settled. The outbox processor will call the provider ' +
      'asynchronously to confirm the payment and settle the transaction. ' +
      'Clients should poll GET /transactions/:id or listen for webhooks to track settlement status.',
  })
  @ApiResponse({
    status: 202,
    description: 'Deposit initiated — settlement pending (async)',
    schema: {
      type: 'object',
      properties: {
        transactionId: {
          type: 'string',
          example: 'txn_1234567890',
          description: 'Transaction ID to track settlement status',
        },
        status: {
          type: 'string',
          enum: ['INITIATED'],
          example: 'INITIATED',
          description:
            'Initial status — will become SETTLED or FAILED after processor runs',
        },
      },
    },
  })
  @ApiResponse({ status: 400, description: 'Validation error' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Wallet is not active' })
  @ApiResponse({ status: 409, description: 'Idempotency key conflict' })
  @ApiResponse({ status: 429, description: 'Rate limit exceeded' })
  confirmDeposit(
    @CurrentUser() user: JwtPayload,
    @Body() dto: ConfirmDepositDto,
  ) {
    return this.paymentService.confirmDeposit(user.sub, dto);
  }

  // ── Payout ─────────────────────────────────────────────────────────────────

  @Post('payouts/create')
  @HttpCode(HttpStatus.ACCEPTED) // 202 — async settlement via outbox
  // 10 payouts per minute — same as deposit confirmations
  @Throttle({ global: { ttl: 60_000, limit: 10 } })
  @ApiOperation({
    summary:
      'Create payout (withdrawal) to external account — writes Transaction (INITIATED) + OutboxEvent',
    description:
      'The payout is not immediately processed. The outbox processor will call the provider ' +
      'asynchronously to execute the withdrawal and settle the transaction. ' +
      'Funds are locked (unavailable) until settlement completes. ' +
      'Clients should poll GET /transactions/:id or listen for webhooks to track settlement status.',
  })
  @ApiResponse({
    status: 202,
    description: 'Payout initiated — settlement pending (async)',
    schema: {
      type: 'object',
      properties: {
        transactionId: {
          type: 'string',
          example: 'txn_1234567890',
          description: 'Transaction ID to track settlement status',
        },
        status: {
          type: 'string',
          enum: ['INITIATED'],
          example: 'INITIATED',
          description:
            'Initial status — will become SETTLED or FAILED after processor runs',
        },
      },
    },
  })
  @ApiResponse({ status: 400, description: 'Validation error' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Wallet is not active' })
  @ApiResponse({ status: 409, description: 'Idempotency key conflict' })
  @ApiResponse({ status: 422, description: 'Insufficient balance' })
  @ApiResponse({ status: 429, description: 'Rate limit exceeded' })
  createPayout(@CurrentUser() user: JwtPayload, @Body() dto: CreatePayoutDto) {
    return this.paymentService.createPayout(user.sub, dto);
  }
}
