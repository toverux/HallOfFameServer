import assert from 'node:assert/strict';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { UnauthorizedError } from '../common/standard-error';
import { config } from '../config';

export class SystemAuthorizationGuard implements CanActivate {
  public canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<FastifyRequest>();

    try {
      const header = request.headers.authorization;
      assert.ok(header, `Header must not be empty`);

      const [scheme, password] = header.split(' ');
      assert.ok(scheme?.toLowerCase() == 'system', `Scheme must be "System"`);
      assert.ok(password == config.systemPassword, `Invalid system password`);

      return true;
    } catch (error) {
      if (error instanceof assert.AssertionError) {
        throw new UnauthorizedError(`Invalid Authorization header (${error.message}).`);
      }

      throw error;
    }
  }
}
