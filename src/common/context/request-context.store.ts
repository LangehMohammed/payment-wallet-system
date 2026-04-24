import { AsyncLocalStorage } from 'async_hooks';

export interface RequestContext {
  requestId: string;
  ip: string;
  userId?: string;
  userAgent?: string;
}

export const requestContextStore = new AsyncLocalStorage<RequestContext>();
