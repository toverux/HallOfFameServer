import * as path from 'node:path';
import fastifyMultipart from '@fastify/multipart';
import {
    type ArgumentsHost,
    Catch,
    type HttpServer,
    NotFoundException
} from '@nestjs/common';
import { BaseExceptionFilter, NestFactory } from '@nestjs/core';
import {
    FastifyAdapter,
    type NestFastifyApplication
} from '@nestjs/platform-fastify';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { AppModule } from './app.module';

// @ts-expect-error We can't import JS (allowJs: false) and can't declare a d.ts
import { ssrRender } from '../../dist/server/server.mjs';
import type { ssrRender as ssrRenderType } from './ssr';

void bootstrap();

async function bootstrap() {
    const fastify = new FastifyAdapter();

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
        new NotFoundExceptionFilter(
            app.getHttpAdapter(),
            browserDistFolder,
            indexHtml
        )
    );

    await app.listen(4000);
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
