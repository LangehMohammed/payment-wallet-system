import { Injectable, Logger } from '@nestjs/common';
import {
  RequestContext,
  requestContextStore,
} from '../context/request-context.store';
import { AuditEvent } from './audit-events';

export interface AuditContext {
  userId?: string;
  userAgent?: string;
  meta?: Record<string, unknown>;
}

/**
 * Structured audit logger.
 *
 * Writes JSON lines to stdout via NestJS Logger — compatible with any log
 * aggregator (Datadog, Loki, CloudWatch) without schema migrations.
 * Each line is a self-contained audit record.
 */
@Injectable()
export class AuditLogger {
  private readonly logger = new Logger('Audit');

  private getContext() {
    return requestContextStore.getStore() ?? {};
  }

  log(event: AuditEvent, metadata: AuditContext): void {
    const ctx = this.getContext();
    this.logger.log(this.serialize(event, ctx, metadata));
  }

  error(event: AuditEvent, metadata: AuditContext): void {
    const ctx = this.getContext();
    this.logger.error(this.serialize(event, ctx, metadata));
  }

  warn(event: AuditEvent, metadata: AuditContext): void {
    const ctx = this.getContext();
    this.logger.warn(this.serialize(event, ctx, metadata));
  }

  /**
   * Serializes the audit event and context into a JSON string.
   * Combines request context and provided metadata for a complete audit record.
   */
  private serialize(
    event: AuditEvent,
    ctx: Partial<RequestContext>,
    metadata: AuditContext,
  ): string {
    return JSON.stringify({
      event,
      requestId: ctx.requestId,
      userId: ctx.userId ?? metadata.userId,
      userAgent: ctx.userAgent ?? metadata.userAgent,
      ipAddress: ctx.ip,
      timestamp: new Date().toISOString(),
      meta: metadata.meta,
    });
  }
}
