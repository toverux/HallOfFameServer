import {
  type CanActivate,
  type ExecutionContext,
  Inject,
  Injectable,
  NotFoundException,
  type RawBodyRequest
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { UnauthorizedError } from '../common/standard-error';
import { config } from '../config';
import { DiscordService } from '../services';

/**
 * Lets through only the requests Discord signed, and none while Discord is disabled.
 * The signature covers the raw body, which the app keeps with Nest's `rawBody` option.
 */
@Injectable()
export class DiscordSignatureGuard implements CanActivate {
  @Inject(DiscordService)
  private readonly discord!: DiscordService;

  public async canActivate(context: ExecutionContext): Promise<boolean> {
    if (!config.discord.isEnabled) {
      throw new NotFoundException(`Discord is disabled.`);
    }

    const request = context.switchToHttp().getRequest<RawBodyRequest<FastifyRequest>>();

    const signature = request.headers['x-signature-ed25519'];
    const timestamp = request.headers['x-signature-timestamp'];

    if (
      typeof signature != 'string' ||
      typeof timestamp != 'string' ||
      !request.rawBody ||
      !(await this.discord.verifyInteractionSignature(request.rawBody, signature, timestamp))
    ) {
      throw new UnauthorizedError(`Invalid request signature.`);
    }

    return true;
  }
}
