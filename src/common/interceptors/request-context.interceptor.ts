import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { v4 as uuidv4 } from 'uuid';
import {
  requestContextStore,
  RequestContext,
} from '../context/request-context.store';

@Injectable()
export class RequestContextInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const request = context.switchToHttp().getRequest();

    // 1. Extract context data
    const contextData: RequestContext = {
      requestId: request.headers['x-request-id'] || uuidv4(),
      // Handle proxy IPs (X-Forwarded-For) if behind a load balancer
      ip: request.ip,
      userAgent: request.headers['user-agent'],
      userId: request.user?.sub,
    };

    // 2. Wrap the execution in the ALS store
    return requestContextStore.run(contextData, () => next.handle());
  }
}
