import { ArgumentsHost, Catch, NotFoundException } from '@nestjs/common';
import { BaseExceptionFilter } from '@nestjs/core';
import { FastifyReply, FastifyRequest } from 'fastify';
import {
  angularAppEngine,
  createWebRequestFromNodeRequest,
  writeResponseToNodeResponse
} from '../angular-app-engine';

/**
 * Error filter that's meant to catch 404 errors from the static file router, and render the Angular
 * application instead, either SSG or SSR.
 * This is the most robust way I've found for now to handle static files + SPA routing with the same
 * base URL in Nest, a previous middleware attempt did not succeed.
 */
@Catch(NotFoundException)
export class NotFoundExceptionFilter extends BaseExceptionFilter {
  /**
   * ###### Implementation Notes
   * A synchronous error filter can rethrow errors, we can't as Angular SSR engine is
   * asynchronous, therefore we need to catch the error and let the default Nest.js error handler,
   * that we inherit from, handle it.
   * Well, even then it's just the default implementation, not what might be configured as the
   * default error handler elsewhere, but it's the best I've found so far.
   */
  public override async catch(error: NotFoundException, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const req = ctx.getRequest<FastifyRequest>();
    const res = ctx.getResponse<FastifyReply>();

    // If it's an API request, let the default error handler handle it.
    if (req.url.startsWith('/api/')) {
      return super.catch(error, host);
    }

    try {
      const ngResponse = await angularAppEngine?.handle(createWebRequestFromNodeRequest(req.raw));

      if (ngResponse) {
        await writeResponseToNodeResponse(ngResponse, res.raw);
      } else {
        // Angular returns null if it 404s, let the default error
        // handler handle it.
        super.catch(error, host);
      }
    } catch (error) {
      super.catch(error, host);
    }
  }
}
