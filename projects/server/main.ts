import 'source-map-support/register'; // This doesn't work in Bun yet.
import * as path from 'node:path';
import * as url from 'node:url';
import { APP_BASE_HREF } from '@angular/common';
import { CommonEngine } from '@angular/ssr';
import {
    type ArgumentsHost,
    Catch,
    type ExceptionFilter,
    type HttpException,
    NotFoundException
} from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
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
        new NotFoundExceptionFilter(browserDistFolder, indexHtml)
    );

    await app.listen(4000);
}

@Catch(NotFoundException)
class NotFoundExceptionFilter implements ExceptionFilter {
    private readonly commonEngine = new CommonEngine();

    public constructor(
        private readonly browserDistFolder: string,
        private readonly indexHtml: string
    ) {}

    public async catch(_: HttpException, host: ArgumentsHost) {
        const ctx = host.switchToHttp();
        const req = ctx.getResponse<FastifyRequest>();
        const res = ctx.getResponse<FastifyReply>();

        const { protocol, originalUrl, headers } = req;

        const result = await this.commonEngine.render({
            bootstrap: bootstrapClient,
            documentFilePath: this.indexHtml,
            url: `${protocol}://${headers.host}${originalUrl}`,
            publicPath: this.browserDistFolder,
            providers: [{ provide: APP_BASE_HREF, useValue: '/' }]
        });

        res.header('Content-Type', 'text/html');
        res.send(result);
    }
}
