import process from 'node:process';
import * as util from 'node:util';
import chalk, { type ChalkInstance } from 'chalk';
import { CommandFactory } from 'nest-commander';
import { iconsole } from '../../shared/iconsole';
import { StandardError } from '../common/standard-error';
import { config, setRuntimeType } from '../config';
import { CliModule } from './cli.module';

setRuntimeType('cli');

void CommandFactory.run(CliModule, {
  logger: {
    ...(config.verbose
      ? {
          debug: log.bind(null, chalk.dim),
          verbose: log.bind(null, chalk.dim)
        }
      : {}),
    log: log.bind(null, chalk),
    warn: log.bind(null, chalk.yellowBright),
    error: log.bind(null, chalk.redBright),
    fatal: log.bind(null, chalk.bgRedBright)
  },
  errorHandler: handleError,
  serviceErrorHandler: handleError
});

function log(formatter: ChalkInstance, ...args: unknown[]): void {
  const context = args.pop();

  for (const arg of args) {
    const argStr =
      typeof arg == 'string'
        ? arg
        : util.inspect(arg, { colors: true, depth: Number.POSITIVE_INFINITY });

    iconsole.log(formatter(argStr), chalk.dim(`[${context}]`));
  }
}

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
