import * as path from 'node:path';
import fastifyMultipart from '@fastify/multipart';
import {
    type ArgumentsHost,
    BadRequestException,
    Catch,
    ForbiddenException,
    type HttpServer,
    Logger,
    NotFoundException
} from '@nestjs/common';
import { BaseExceptionFilter, NestFactory } from '@nestjs/core';
import {
    FastifyAdapter,
    type NestFastifyApplication
} from '@nestjs/platform-fastify';
import type { FastifyReply, FastifyRequest } from 'fastify';
// @ts-expect-error We can't import JS (allowJs: false) and can't declare a d.ts
import { ssrRender } from '../../dist/server/server.mjs';
import { AppModule } from './app.module';
import { StandardError } from './common';
import { ConfigService } from './services';
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
                'verbose',
                ...(process.env.NODE_ENV == 'development'
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
        new StandardErrorFilter(app.getHttpAdapter()),
        new NotFoundExceptionFilter(
            app.getHttpAdapter(),
            browserDistFolder,
            indexHtml
        )
    );

    const config = app.get(ConfigService);

    await app.listen(config.http.port);

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
 * Error filter that catches {@link StandardError}, which is a known error type,
 * that we can convert to a {@link BadRequestException} with the original error
 * message.
 */
@Catch(StandardError)
class StandardErrorFilter extends BaseExceptionFilter {
    public constructor(applicationRef: HttpServer) {
        super(applicationRef);
    }

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
    public override async catch(_: NotFoundException, host: ArgumentsHost) {
        const ctx = host.switchToHttp();
        const req = ctx.getResponse<FastifyRequest>();
        const res = ctx.getResponse<FastifyReply>();

        const { protocol, originalUrl, headers } = req;

        const url = `${protocol}://${headers.host}${originalUrl}`;

        try {
            const result = await (ssrRender as typeof ssrRenderType)(
                this.browserDistFolder,
                this.indexHtml,
                url
            );

            res.header('Content-Type', 'text/html');
            res.send(result);
        } catch (error) {
            super.catch(error, host);
        }
    }
}
