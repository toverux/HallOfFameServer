/**
 * ! Attention
 * This file and function MUST NOT be imported directly as a TS module, this is
 * an entry point for Angular SSR and generates a much more complex AoT file,
 * from which this function can be imported (dist/server/server.mjs).
 */

import { APP_BASE_HREF } from '@angular/common';
import { CommonEngine } from '@angular/ssr';
import bootstrapClient from '../client/main.server';

const commonEngine = new CommonEngine({
    bootstrap: bootstrapClient,
    providers: [
        {
            provide: APP_BASE_HREF,
            useValue: '/'
        }
    ]
});

export function ssrRender(
    publicPath: string,
    documentFilePath: string,
    url: string
) {
    return commonEngine.render({
        documentFilePath,
        url,
        publicPath
    });
}
