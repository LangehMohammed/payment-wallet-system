import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { Prisma } from '@prisma/client';

/**
 * Canonical error payload returned to API clients.
 *
 * This shape is part of the public contract and must not change without
 * updating `docs/api-snapshot-before.json` and notifying consumers.
 */
export interface StandardErrorResponse {
  statusCode: number;
  message: string | string[];
  error: string;
  path: string;
  timestamp: string;
}

/**
 * Global exception filter.
 *
 * - `HttpException` (and subclasses like `NotFoundException`, `BadRequestException`,
 *   `ConflictException`, …): preserved status + message, normalized envelope.
 * - `Prisma.PrismaClientKnownRequestError`: mapped to a meaningful HTTP status
 *   (P2002 → 409, P2025 → 404), with a sanitized message that does NOT leak
 *   the raw Prisma error object.
 * - Anything else: 500 with a generic message. Full error is logged with
 *   request context (method + path only — never request bodies).
 */
@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    const payload = this.toStandardError(exception, request);

    // 5xx → log as error with full exception; 4xx → log as warning, no stack.
    if (payload.statusCode >= 500) {
      this.logger.error(
        `${request.method} ${request.url} → ${payload.statusCode} ${payload.error}`,
        exception instanceof Error ? exception.stack : String(exception),
      );
    } else {
      this.logger.warn(
        `${request.method} ${request.url} → ${payload.statusCode} ${payload.error}`,
      );
    }

    response.status(payload.statusCode).json(payload);
  }

  private toStandardError(
    exception: unknown,
    request: Request,
  ): StandardErrorResponse {
    const timestamp = new Date().toISOString();
    const path = request.url;

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const rawBody = exception.getResponse();
      const { message, errorName } = this.unpackHttpExceptionBody(
        rawBody,
        exception,
        status,
      );
      return {
        statusCode: status,
        message,
        error: errorName,
        path,
        timestamp,
      };
    }

    if (exception instanceof Prisma.PrismaClientKnownRequestError) {
      return this.mapPrismaKnownError(exception, path, timestamp);
    }

    if (exception instanceof Prisma.PrismaClientValidationError) {
      return {
        statusCode: HttpStatus.BAD_REQUEST,
        message: 'Invalid query parameters',
        error: 'Bad Request',
        path,
        timestamp,
      };
    }

    // Fallback: anything we don't recognize is a server fault. Do NOT leak
    // the raw error message — it may contain stack frames, file paths, or
    // sensitive identifiers from third-party SDKs.
    return {
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
      message: 'Internal server error',
      error: 'Internal Server Error',
      path,
      timestamp,
    };
  }

  /**
   * `HttpException.getResponse()` can return either a string or an object
   * (e.g. `ValidationPipe` returns `{ message: string[], error: string, statusCode: number }`).
   * Normalize both.
   */
  private unpackHttpExceptionBody(
    body: string | object,
    exception: HttpException,
    status: number,
  ): { message: string | string[]; errorName: string } {
    if (typeof body === 'string') {
      return {
        message: body,
        errorName: this.statusName(status),
      };
    }

    const obj = body as {
      message?: string | string[];
      error?: string;
    };

    return {
      message: obj.message ?? exception.message,
      errorName: obj.error ?? this.statusName(status),
    };
  }

  /**
   * Map a `PrismaClientKnownRequestError` to an HTTP response.
   *
   * Reference: https://www.prisma.io/docs/reference/api-reference/error-reference
   */
  private mapPrismaKnownError(
    exception: Prisma.PrismaClientKnownRequestError,
    path: string,
    timestamp: string,
  ): StandardErrorResponse {
    switch (exception.code) {
      case 'P2002': {
        // Unique constraint violation. `meta.target` may name the field(s).
        const target =
          (exception.meta?.target as string[] | string | undefined) ??
          undefined;
        const targetText = Array.isArray(target)
          ? target.join(', ')
          : typeof target === 'string'
            ? target
            : undefined;
        return {
          statusCode: HttpStatus.CONFLICT,
          message: targetText
            ? `A user with this ${targetText} already exists`
            : 'A user with these unique values already exists',
          error: 'Conflict',
          path,
          timestamp,
        };
      }

      case 'P2025': {
        // Record not found (during update/delete operations).
        return {
          statusCode: HttpStatus.NOT_FOUND,
          message: 'The requested record was not found',
          error: 'Not Found',
          path,
          timestamp,
        };
      }

      case 'P2003': {
        // Foreign key constraint failed.
        return {
          statusCode: HttpStatus.BAD_REQUEST,
          message: 'Referenced record does not exist',
          error: 'Bad Request',
          path,
          timestamp,
        };
      }

      case 'P2014': {
        // Required relation violation.
        return {
          statusCode: HttpStatus.BAD_REQUEST,
          message: 'Operation would violate a required relation',
          error: 'Bad Request',
          path,
          timestamp,
        };
      }

      default: {
        // Unknown Prisma code: treat as server fault but log the code itself
        // so we can extend the mapping over time.
        this.logger.error(
          `Unmapped Prisma error code ${exception.code} on ${path}`,
        );
        return {
          statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
          message: 'A database error occurred',
          error: 'Internal Server Error',
          path,
          timestamp,
        };
      }
    }
  }

  private statusName(status: number): string {
    // Mirror Nest's built-in error names. Anything we don't enumerate
    // falls back to a sanitized generic name.
    switch (status) {
      case HttpStatus.BAD_REQUEST:
        return 'Bad Request';
      case HttpStatus.UNAUTHORIZED:
        return 'Unauthorized';
      case HttpStatus.FORBIDDEN:
        return 'Forbidden';
      case HttpStatus.NOT_FOUND:
        return 'Not Found';
      case HttpStatus.CONFLICT:
        return 'Conflict';
      case HttpStatus.UNPROCESSABLE_ENTITY:
        return 'Unprocessable Entity';
      case HttpStatus.TOO_MANY_REQUESTS:
        return 'Too Many Requests';
      case HttpStatus.INTERNAL_SERVER_ERROR:
        return 'Internal Server Error';
      case HttpStatus.SERVICE_UNAVAILABLE:
        return 'Service Unavailable';
      default:
        return status >= 500 ? 'Internal Server Error' : 'Error';
    }
  }
}
