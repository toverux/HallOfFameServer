/**
 * This is a wrapper script to run Prisma CLI within Bun context, i.e. with Bun's logic to load
 * environment variables from `.env` and `.env.local` files, so we can use Prisma CLI without having
 * to manually set the environment.
 * Otherwise, Prisma only loads the .env file.
 */

import process from 'node:process';
import { $ } from 'bun';

const { exitCode } = await $`prisma ${process.argv.slice(2)}`.nothrow();

process.exit(exitCode);
