import chalk from 'chalk';
import { CommandFactory } from 'nest-commander';
import { StandardError } from '../common';
import { config } from '../config';
import { CliModule } from './cli.module';

void CommandFactory.run(CliModule, {
  logger: {
    ...(config.verbose
      ? {
          debug: message => console.debug(chalk.dim(message)),
          verbose: message => console.debug(chalk.dim(message))
        }
      : {}),
    log: message => console.log(message),
    warn: message => console.warn(chalk.yellowBright(message)),
    error: message => console.error(chalk.redBright(message)),
    fatal: message => console.error(chalk.bgRedBright(message))
  },
  errorHandler: handleError,
  serviceErrorHandler: handleError
});

function handleError(error: Error): void {
  if (!config.verbose && error instanceof StandardError) {
    console.error(chalk.red(error.message));
  } else {
    // Do not recolor using chalk, this will use the standard formatting for errors which is
    // much better.
    console.error(error);
  }

  process.exitCode = 1;
}
