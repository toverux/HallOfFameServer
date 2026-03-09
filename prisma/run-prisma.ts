/**
 * This is a wrapper script to run Prisma CLI within Bun context, i.e., with Bun's logic to load
 * environment variables from `.env` and `.env.local` files, so we can use Prisma CLI without having
 * to manually set the environment.
 * Otherwise, Prisma only loads the .env file.
 */

import path from 'node:path';
import process from 'node:process';
import Bun from 'bun';

const prismaPath = path.join(import.meta.dir, '../node_modules/.bin/prisma');

const exitCode = await Bun.spawn({
  cmd: ['bun', prismaPath, ...process.argv.slice(2)],
  stdio: ['inherit', 'inherit', 'inherit']
}).exited;

process.exit(exitCode);
