import chalk from 'chalk';
import { CommandFactory } from 'nest-commander';
import { StandardError } from '../common';
import { config } from '../config';
import { CliModule } from './cli.module';

void CommandFactory.run(CliModule, {
  logger: {
    ...(config.verbose
      ? {
          debug: (message, scope) => console.debug(chalk.dim(message), chalk.dim`[${scope}]`),
          verbose: (message, scope) => console.debug(chalk.dim(message), chalk.dim`[${scope}]`)
        }
      : {}),
    log: (message, scope) => console.log(message, chalk.dim`[${scope}]`),
    warn: (message, scope) => console.warn(chalk.yellowBright(message), chalk.dim`[${scope}]`),
    error: (message, scope) => console.error(chalk.redBright(message), chalk.dim`[${scope}]`),
    fatal: (message, scope) => console.error(chalk.bgRedBright(message), chalk.dim`[${scope}]`)
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
