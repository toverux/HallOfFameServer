/**
 * This is a wrapper script to:
 *  - Run Prisma CLI within Bun context, i.e., with Bun's logic to load environment variables from
 *    `.env` and `.env.local` files, so we can use Prisma CLI without having to manually set the
 *    environment (otherwise, Prisma only loads the .env file).
 *  - Extend the codegen logic to perform additional changes on the generated files.
 *    We are adding the `@public` JSDoc tag to exports of the generated files so we can use Biome's
 *    `noPrivateImports` rule.
 */

import * as path from 'node:path';
import * as process from 'node:process';
import Bun from 'bun';
import chalk from 'chalk';
import { iconsole } from '../projects/shared/iconsole';

const exitCode = await Bun.spawn({
  cmd: ['bunx', 'prisma', 'generate', '--no-hints'],
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
  pothosSrc
    .replace(/JSON.parse\((.*)\)/, 'JSON.parse($1) as unknown as PothosPrismaDatamodel')
    .replace(/^export /gm, '/** @public */\nexport ')
);

const prismaClientPath = path.join(import.meta.dir, 'lib/client/index.d.ts');

const prismaClientSrc = await Bun.file(prismaClientPath).text();

iconsole.info(`Patching ${chalk.bold(path.relative('.', prismaClientPath))}... `);

// noinspection RegExpUnexpectedAnchor This is intentional.
await Bun.write(
  prismaClientPath,
  prismaClientSrc.replace(
    /(\/\*\*[\s\S]*?\*\/(\s+))?^export /gm,
    (_match, jsDocWithSpace: string) => {
      if (jsDocWithSpace) {
        // It has an existing JSDoc. Insert @public before the closing tag.
        // We use a regex replacement on the JSDoc part to ensure correct spacing/asterisks
        // biome-ignore lint/performance/useTopLevelRegex: not performance-sensitive.
        return `${jsDocWithSpace.replace(/\n\s*\*\//, '\n * @public\n */')}export `;
      }

      // No JSDoc found, create a new one
      return `/** @public */\nexport `;
    }
  )
);
