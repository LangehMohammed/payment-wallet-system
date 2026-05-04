import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiHeader,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Response } from 'express';
import { TransactionService } from './transaction.service';
import {
  DepositDto,
  TransactionQueryDto,
  TransferDto,
  WithdrawalDto,
} from './dto/transaction.dto';
import { CurrentUser } from '@app/common/decorators';
import { JwtPayload } from '../auth/interfaces/jwt-payload.interface';

/** Header set on responses to idempotent replays so clients can distinguish
 *  a freshly created resource from a replayed one without inspecting the body. */
const IDEMPOTENCY_REPLAYED_HEADER = 'Idempotency-Replayed';

@ApiTags('Transactions')
@ApiBearerAuth()
@Controller('transactions')
export class TransactionController {
  constructor(private readonly transactionService: TransactionService) {}

  // ── Deposit ────────────────────────────────────────────────────────────────

  @Post('deposit')
  @HttpCode(HttpStatus.ACCEPTED)
  @Throttle({ global: { ttl: 60_000, limit: 10 } })
  @ApiOperation({
    summary: 'Initiate a deposit — funds held as pending until settled',
  })
  @ApiHeader({
    name: IDEMPOTENCY_REPLAYED_HEADER,
    description:
      'Present with value "true" when the idempotency key was already seen ' +
      'and the original result is being returned unchanged.',
    required: false,
  })
  @ApiResponse({ status: 202, description: 'Deposit initiated' })
  @ApiResponse({ status: 400, description: 'Validation error' })
  @ApiResponse({ status: 403, description: 'Wallet is not active' })
  @ApiResponse({ status: 429, description: 'Rate limit exceeded' })
  async deposit(
    @Body() dto: DepositDto,
    @CurrentUser() user: JwtPayload,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { data, replayed } = await this.transactionService.deposit(
      user.sub,
      dto,
    );
    if (replayed) res.setHeader(IDEMPOTENCY_REPLAYED_HEADER, 'true');
    return data;
  }

  // ── Withdrawal ─────────────────────────────────────────────────────────────

  @Post('withdrawal')
  @HttpCode(HttpStatus.ACCEPTED)
  @Throttle({ global: { ttl: 60_000, limit: 10 } })
  @ApiOperation({
    summary: 'Initiate a withdrawal — available balance locked until settled',
  })
  @ApiHeader({
    name: IDEMPOTENCY_REPLAYED_HEADER,
    description:
      'Present with value "true" when the idempotency key was already seen.',
    required: false,
  })
  @ApiResponse({ status: 202, description: 'Withdrawal initiated' })
  @ApiResponse({ status: 400, description: 'Validation error' })
  @ApiResponse({ status: 403, description: 'Wallet is not active' })
  @ApiResponse({ status: 422, description: 'Insufficient balance' })
  @ApiResponse({ status: 429, description: 'Rate limit exceeded' })
  async withdraw(
    @Body() dto: WithdrawalDto,
    @CurrentUser() user: JwtPayload,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { data, replayed } = await this.transactionService.withdraw(
      user.sub,
      dto,
    );
    if (replayed) res.setHeader(IDEMPOTENCY_REPLAYED_HEADER, 'true');
    return data;
  }

  // ── Transfer ───────────────────────────────────────────────────────────────

  @Post('transfer')
  @HttpCode(HttpStatus.CREATED)
  @Throttle({ global: { ttl: 60_000, limit: 20 } })
  @ApiOperation({
    summary: 'P2P transfer — atomic, instant settlement between wallets',
  })
  @ApiHeader({
    name: IDEMPOTENCY_REPLAYED_HEADER,
    description:
      'Present with value "true" when the idempotency key was already seen.',
    required: false,
  })
  @ApiResponse({ status: 201, description: 'Transfer settled' })
  @ApiResponse({
    status: 400,
    description: 'Validation error or self-transfer',
  })
  @ApiResponse({ status: 403, description: 'Wallet is not active' })
  @ApiResponse({ status: 422, description: 'Insufficient balance' })
  @ApiResponse({ status: 429, description: 'Rate limit exceeded' })
  async transfer(
    @Body() dto: TransferDto,
    @CurrentUser() user: JwtPayload,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { data, replayed } = await this.transactionService.transfer(
      user.sub,
      dto,
    );
    if (replayed) res.setHeader(IDEMPOTENCY_REPLAYED_HEADER, 'true');
    return data;
  }

  // ── History ────────────────────────────────────────────────────────────────

  @Get()
  @ApiOperation({
    summary: 'Paginated transaction history for the authenticated user',
  })
  @ApiResponse({ status: 200, description: 'Paginated transaction list' })
  getHistory(
    @Query() query: TransactionQueryDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.transactionService.getTransactionHistory(user.sub, query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a single transaction by ID' })
  @ApiResponse({ status: 200, description: 'Transaction detail' })
  @ApiResponse({ status: 403, description: 'Not your transaction' })
  getOne(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.transactionService.getTransaction(user.sub, id);
  }
}
