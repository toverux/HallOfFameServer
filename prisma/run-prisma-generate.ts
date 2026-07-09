/**
 * This is a wrapper script to extend the codegen logic to perform additional changes on the
 * generated files.
 */

import path from 'node:path';
import * as process from 'node:process';
import * as Bun from 'bun';
import chalk from 'chalk';
import { iconsole } from '../projects/shared/iconsole';

const prismaPath = path.join(import.meta.dir, '../node_modules/.bin/prisma');

const exitCode = await Bun.spawn({
  cmd: ['bun', prismaPath, 'generate', '--no-hints'],
  stdio: ['inherit', 'inherit', 'inherit']
}).exited;

if (exitCode != 0) {
  process.exit(exitCode);
}

const pothosSrcPath = path.join(import.meta.dir, 'lib/pothos-prisma-types.ts');

iconsole.info(`Patching ${chalk.bold(path.relative('.', pothosSrcPath))}... `);

const pothosSrc = await Bun.file(pothosSrcPath).text();

await Bun.write(
  pothosSrcPath,
  pothosSrc.replace(
    /JSON.parse\((?<arg>.*)\)/u,
    'JSON.parse($<arg>) as unknown as PothosPrismaDatamodel'
  )
);
