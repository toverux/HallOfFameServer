import { CommandFactory } from 'nest-commander';
import { StandardError } from '../common';
import { config } from '../config';
import { CliModule } from './cli.module';

await CommandFactory.run(CliModule, {
    logger: [
        'fatal',
        'error',
        'warn',
        ...(config.verbose ? (['log', 'verbose', 'debug'] as const) : [])
    ],
    errorHandler: handleError,
    serviceErrorHandler: handleError
});

function handleError(error: Error): void {
    if (!config.verbose && error instanceof StandardError) {
        console.error(error.message);
    } else {
        console.error(error);
    }

    process.exitCode = 1;
}
