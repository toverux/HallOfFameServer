import {
    ArgumentsHost,
    Catch,
    type HttpServer,
    NotFoundException
} from '@nestjs/common';
import { BaseExceptionFilter } from '@nestjs/core';
import { FastifyReply, FastifyRequest } from 'fastify';
import type { ssrRender as ssrRenderType } from '../ssr';

// @ts-expect-error We can't import JS (allowJs: false) and can't declare a d.ts
import { ssrRender } from '../../../dist/server/server.mjs';

/**
 * Error filter that's meant to catch 404 errors from the static file router,
 * and render the Angular application instead, either SSG or SSR.
 * This is the most robust way I've found for now to handle static files + SPA
 * routing with the same base URL in Nest, a previous middleware attempt did not
 * succeed.
 */
@Catch(NotFoundException)
export class NotFoundExceptionFilter extends BaseExceptionFilter {
    public constructor(
        applicationRef: HttpServer,
        private readonly browserDistFolder: string,
        private readonly indexHtml: string
    ) {
        super(applicationRef);
    }

    /**
     * ###### Implementation Notes
     * A synchronous error filter can rethrow errors, we can't as Angular SSR
     * engine is asynchronous, therefore we need to catch the error and let the
     * default Nest.js error handler, that we inherit from, handle it.
     * Well, even then it's just the default implementation, not what might be
     * configured as the default error handler elsewhere, but it's the best I've
     * found so far.
     */
    public override async catch(error: NotFoundException, host: ArgumentsHost) {
        const ctx = host.switchToHttp();
        const req = ctx.getRequest<FastifyRequest>();
        const res = ctx.getResponse<FastifyReply>();

        const { protocol, originalUrl, url, headers } = req;

        // If it's an API request, let the default error handler handle it.
        if (url.startsWith('/api/')) {
            return super.catch(error, host);
        }

        // Otherwise, render the Angular application.
        const fullUrl = `${protocol}://${headers.host}${originalUrl}`;

        try {
            const result = await (ssrRender as typeof ssrRenderType)(
                this.browserDistFolder,
                this.indexHtml,
                fullUrl
            );

            res.header('Content-Type', 'text/html');
            res.send(result);
        } catch (error) {
            super.catch(error, host);
        }
    }
}
