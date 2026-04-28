import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { AuditLogger } from '@app/common/audit/audit-logger.service';
import { UsersService } from './users.service';
import { UsersController } from './users.controller';
import { UsersRepository } from './users.repository';

@Module({
  imports: [AuthModule],
  providers: [UsersService, UsersRepository, AuditLogger],
  controllers: [UsersController],
})
export class UsersModule {}
