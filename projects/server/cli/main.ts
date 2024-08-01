import { CommandFactory } from 'nest-commander';
import { config } from '../config';
import { CliModule } from './cli.module';

await CommandFactory.run(CliModule, {
    logger: [
        'fatal',
        'error',
        'warn',
        ...(config.verbose ? (['log', 'verbose', 'debug'] as const) : [])
    ]
});
