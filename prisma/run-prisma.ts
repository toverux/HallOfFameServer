/**
 * This is a wrapper script to run Prisma CLI within Bun context, i.e. with Bun's logic to load
 * environment variables from `.env` and `.env.local` files, so we can use Prisma CLI without having
 * to manually set the environment.
 * Otherwise, Prisma only loads the .env file.
 */

import Bun from 'bun';

const argv = [process.argv0, 'node_modules/.bin/prisma', ...process.argv.slice(2)];

const { exitCode } = Bun.spawnSync(argv, {
  stdio: ['inherit', 'inherit', 'inherit'],
  windowsHide: true
});

process.exitCode = exitCode;
