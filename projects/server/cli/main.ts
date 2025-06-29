import process from 'node:process';
import chalk from 'chalk';
import { CommandFactory } from 'nest-commander';
import { StandardError } from '../common';
import { config } from '../config';
import { iconsole } from '../iconsole';
import { CliModule } from './cli.module';

void CommandFactory.run(CliModule, {
  logger: {
    ...(config.verbose
      ? {
          debug: (message, scope) => iconsole.debug(chalk.dim(message), chalk.dim`[${scope}]`),
          verbose: (message, scope) => iconsole.debug(chalk.dim(message), chalk.dim`[${scope}]`)
        }
      : {}),
    log: (message, scope) => iconsole.log(message, chalk.dim`[${scope}]`),
    warn: (message, scope) => iconsole.warn(chalk.yellowBright(message), chalk.dim`[${scope}]`),
    error: (message, scope) => iconsole.error(chalk.redBright(message), chalk.dim`[${scope}]`),
    fatal: (message, scope) => iconsole.error(chalk.bgRedBright(message), chalk.dim`[${scope}]`)
  },
  errorHandler: handleError,
  serviceErrorHandler: handleError
});

function handleError(error: Error): void {
  if (!config.verbose && error instanceof StandardError) {
    iconsole.error(chalk.red(error.message));
  } else {
    // Do not recolor using chalk, this will use the standard formatting for errors which is
    // much better.
    iconsole.error(error);
  }

  process.exitCode = 1;
}
