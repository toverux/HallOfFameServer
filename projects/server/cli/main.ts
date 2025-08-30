import process from 'node:process';
import chalk from 'chalk';
import { CommandFactory } from 'nest-commander';
import { iconsole } from '../../shared/iconsole';
import { StandardError } from '../common';
import { config, setRuntimeType } from '../config';
import { CliModule } from './cli.module';

setRuntimeType('cli');

void CommandFactory.run(CliModule, {
  logger: {
    ...(config.verbose
      ? {
          debug: (message, scope) => iconsole.debug(chalk.dim(message), chalk.dim(`[${scope}]`)),
          verbose: (message, scope) => iconsole.debug(chalk.dim(message), chalk.dim(`[${scope}]`))
        }
      : {}),
    log: (message, scope) => iconsole.log(message, chalk.dim(`[${scope}]`)),
    warn: (message, scope) => iconsole.warn(chalk.yellowBright(message), chalk.dim(`[${scope}]`)),
    error: (message, scope) => iconsole.error(chalk.redBright(message), chalk.dim(`[${scope}]`)),
    fatal: (message, scope) => iconsole.error(chalk.bgRedBright(message), chalk.dim(`[${scope}]`))
  },
  errorHandler: handleError,
  serviceErrorHandler: handleError
});

function handleError(error: Error): void {
  // If it's a command not found, we just have to return, printing to the console and setting the
  // exit code is already handled by Commander.
  if ((error as { code?: string }).code?.startsWith('commander.')) {
    return;
  }

  if (!config.verbose && error instanceof StandardError) {
    iconsole.error(chalk.red(error.message));
  } else {
    // In verbose mode, we want to see the full stack trace and use the default error formatting.
    iconsole.error(error);
  }

  process.exitCode = 1;
}
