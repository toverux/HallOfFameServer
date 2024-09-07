import './sentry';

import fastifyMultipart from '@fastify/multipart';
import {
    type ArgumentsHost,
    BadRequestException,
    Catch,
    ForbiddenException,
    HttpException,
    type HttpServer,
    Logger,
    NotFoundException
} from '@nestjs/common';
import { BaseExceptionFilter, NestFactory } from '@nestjs/core';
import {
    FastifyAdapter,
    type NestFastifyApplication
} from '@nestjs/platform-fastify';
import * as sentry from '@sentry/bun';
import type { FastifyReply, FastifyRequest } from 'fastify';

import * as path from 'node:path';
// @ts-expect-error We can't import JS (allowJs: false) and can't declare a d.ts
import { ssrRender } from '../../dist/server/server.mjs';
import { AppModule } from './app.module';
import { StandardError } from './common';
import { config } from './config';
import type { ssrRender as ssrRenderType } from './ssr';

void linkEnvFilesForWatchMode();

void bootstrap();

async function bootstrap(): Promise<void> {
    const fastify = new FastifyAdapter({ trustProxy: '127.0.0.1' });
    const logger = new Logger(bootstrap.name);

    // @ts-expect-error
    // Errors due to our strict config on types we don't control.
    fastify.register(fastifyMultipart);

    const app = await NestFactory.create<NestFastifyApplication>(
        AppModule,
        fastify,
        {
            logger: [
                'fatal',
                'error',
                'warn',
                'log',
                ...(config.env == 'development' || config.verbose
                    ? (['verbose', 'debug'] as const)
                    : [])
            ]
        }
    );

    const browserDistFolder = path.resolve(
        import.meta.dir,
        '../../dist/browser'
    );

    const indexHtml = path.join(
        import.meta.dir,
        '../../dist/server/index.server.html'
    );

    app.useStaticAssets({
        root: browserDistFolder
    });

    app.useGlobalFilters(
        // The catch-all error filter should actually come first to let the
        // other more specific filters take precedence.
        new GlobalExceptionFilter(app.getHttpAdapter()),
        new StandardErrorFilter(app.getHttpAdapter()),
        new NotFoundExceptionFilter(
            app.getHttpAdapter(),
            browserDistFolder,
            indexHtml
        )
    );

    await app.listen(config.http.port, config.http.address);

    logger.log(`Server is running on: ${await app.getUrl()}`);
}

/**
 * Link the `.env` and `.env.local` files for auto-restart in watch mode.
 * `{ with: { type: 'text' } }` is needed for Bun to not ignore the files.
 */
async function linkEnvFilesForWatchMode(): Promise<void> {
    try {
        // @ts-ignore
        await import('../../.env', { with: { type: 'text' } });
        // @ts-ignore
        await import('../../.env.local', { with: { type: 'text' } });
    } catch {
        // Ignore, we're just checking if the files exist.
    }
}

/**
 * Catch-all error filter, uses the base exception filter to handle all errors
 * that reach it, but adds Sentry error reporting for all errors that are not
 * {@link HttpException} (unless status 500+) or {@link StandardError}.
 */
@Catch()
class GlobalExceptionFilter extends BaseExceptionFilter {
    public override catch(error: unknown, host: ArgumentsHost): void {
        // Report unknown errors and 500+ errors to Sentry.
        if (!(error instanceof HttpException) || error.getStatus() >= 500) {
            sentry.captureException(error);
        }

        super.catch(error, host);
    }

    /**
     * The default implementation of this method isn't great, it's called for
     * "unknown errors" (i.e. errors that aren't HttpException) it's supposed to
     * catch http-errors lib's errors (which we don't use btw), but just checks
     * if the error has a `statusCode` and `message` property.
     *
     * In our case this was a problem with the Azure SDK errors which has
     * `statusCode` and `message`, but they're not user errors, we want to treat
     * that as an unknown errors too (resulting in a 500 error to the end user).
     *
     * So right now we don't ever want to return true for anything else as
     * HttpException and {@link StandardError} are already properly handled.
     */
    public override isHttpError(
        _error: unknown
    ): _error is { statusCode: number; message: string } {
        return false;
    }
}

/**
 * Error filter that catches {@link StandardError}, which is a known error type,
 * that we can convert to a {@link BadRequestException} with the original error
 * message.
 */
@Catch(StandardError)
class StandardErrorFilter extends BaseExceptionFilter {
    public override catch(error: StandardError, host: ArgumentsHost) {
        const ErrorConstructor =
            error.kind == 'forbidden'
                ? ForbiddenException
                : BadRequestException;

        super.catch(
            new ErrorConstructor(error.message, { cause: error }),
            host
        );
    }
}

/**
 * Error filter that's meant to catch 404 errors from the static file router,
 * and render the Angular application instead, either SSG or SSR.
 * This is the most robust way I've found for now to handle static files + SPA
 * routing with the same base URL in Nest, a previous middleware attempt did not
 * succeed.
 */
@Catch(NotFoundException)
class NotFoundExceptionFilter extends BaseExceptionFilter {
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
