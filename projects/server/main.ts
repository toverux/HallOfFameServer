import 'source-map-support/register'; // This doesn't work in Bun yet.
import * as path from 'node:path';
import * as url from 'node:url';
import { APP_BASE_HREF } from '@angular/common';
import { CommonEngine } from '@angular/ssr';
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
import bootstrapClient from '../client/main.server';
import { AppModule } from './app.module';

void bootstrap();

async function bootstrap() {
    const app = await NestFactory.create<NestFastifyApplication>(
        AppModule,
        new FastifyAdapter()
    );

    const serverDistFolder = path.dirname(url.fileURLToPath(import.meta.url));
    const browserDistFolder = path.resolve(serverDistFolder, '../browser');
    const indexHtml = path.join(serverDistFolder, 'index.server.html');

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
    private readonly commonEngine = new CommonEngine();

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

        try {
            const result = await this.commonEngine.render({
                bootstrap: bootstrapClient,
                documentFilePath: this.indexHtml,
                url: `${protocol}://${headers.host}${originalUrl}`,
                publicPath: this.browserDistFolder,
                providers: [{ provide: APP_BASE_HREF, useValue: '/' }]
            });

            res.header('Content-Type', 'text/html');
            res.send(result);
        } catch (error) {
            super.catch(error, host);
        }
    }
}
