import { Role } from '@prisma/client';

export interface JwtPayload {
  sub: string; // user id
  email: string;
  role: Role;
  jti: string;
}
