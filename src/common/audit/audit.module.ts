import { Global, Module } from '@nestjs/common';
import { AuditLogger } from './audit-logger.service';

@Global()
@Module({
  providers: [AuditLogger],
  exports: [AuditLogger],
})
export class AuditModule {}
