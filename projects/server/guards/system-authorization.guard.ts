import assert from 'node:assert/strict';
import { CanActivate, ExecutionContext, ForbiddenException } from '@nestjs/common';
import { FastifyRequest } from 'fastify';
import { config } from '../config';

export class SystemAuthorizationGuard implements CanActivate {
  public canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<FastifyRequest>();

    try {
      const header = request.headers.authorization;
      assert(header, `Header must not be empty`);

      const [scheme, password] = header.split(' ');
      assert(scheme?.toLowerCase() == 'system', `Scheme must be "System"`);
      assert(password == config.systemPassword, `Invalid system password`);

      return true;
    } catch (error) {
      // biome-ignore lint/suspicious/noMisplacedAssertion: false positive
      if (error instanceof assert.AssertionError) {
        throw new ForbiddenException(`Invalid Authorization header (${error.message}).`);
      }

      throw error;
    }
  }
}
