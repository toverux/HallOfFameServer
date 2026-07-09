import agnostic from '@toverux/blanc-hopital/oxlint/agnostic';
import all from '@toverux/blanc-hopital/oxlint/all';
import { defineConfig } from 'oxlint';

// oxlint-disable-next-line import/no-default-export - oxlint interface
export default defineConfig({
  extends: [all, agnostic],
  ignorePatterns: ['init-replica-set.js'],
  rules: {
    'id-length': [
      'deny',
      {
        ...agnostic.rules['id-length'][1],
        exceptions: [
          ...agnostic.rules['id-length'][1].exceptions,
          // `t`=used a lot in our GraphQL controllers
          't'
        ]
      }
    ],
    'new-cap': [
      'deny',
      {
        // Ignore Angular/Nest.js decorators.
        capIsNewExceptionPattern:
          'Body|Catch|Command|Component|Controller|Cron|Delete|Get|Inject|Module|Option|Param|Patch|Post|Put|Query|Question|QuestionSet|Req|Res|SubCommand|UseGuards'
      }
    ],
    'no-underscore-dangle': [
      'deny',
      {
        allow: ['_id']
      }
    ],
    // NestJS modules/providers and Angular components are decorated classes that legitimately
    // have only a constructor, only static members, or no body. The rule still fires for
    // undecorated extraneous classes.
    'typescript/no-extraneous-class': ['error', { allowWithDecorator: true }]
  },
  overrides: [
    {
      files: ['projects/server/**/*'],
      rules: {
        'import/no-nodejs-modules': 'off'
      }
    },
    {
      files: ['*.command.ts'],
      rules: {
        // Performance is not an issue in CLI commands (well except if I start finding a command too
        // slow, and then I can optimize it).
        'no-await-in-loop': 'off',
        // Sync can be fine in CLI commands.
        'node/no-sync': 'off',
        // `find(query, options)` is a MongoDB driver call, not an Array method with a thisArg.
        'unicorn/no-array-method-this-argument': 'off',
        // It's a common Commander pattern to throw raw strings to surface CLI errors easily.
        'typescript/only-throw-error': 'off'
      }
    },
    {
      // Prisma codegen and migration scripts run in Node and talk to the raw MongoDB driver.
      files: ['prisma/**/*.ts'],
      rules: {
        // Node built-ins are expected in these tooling/migration scripts.
        'import/no-nodejs-modules': 'off',
        // `find(query, options)` is a MongoDB driver call, not an Array method with a thisArg.
        'unicorn/no-array-method-this-argument': 'off',
        // Codegen wrapper scripts legitimately exit the process on failure.
        'unicorn/no-process-exit': 'off'
      }
    },
    {
      // The Angular SSR entry stub is intentionally empty until the compiler fills it in.
      // import/unambiguous can't be suppressed in the file, so we do it via overrides.
      files: ['projects/server/ssr.ts'],
      rules: {
        'import/unambiguous': 'off',
        'unicorn/no-empty-file': 'off'
      }
    },
    {
      // Declaration files follow different conventions than regular source.
      files: ['**/*.d.ts'],
      rules: {
        // Ambient module/global augmentations have no top-level import/export.
        'import/unambiguous': 'off',
        // Method signatures are idiomatic and often required to match augmented lib types.
        'typescript/method-signature-style': 'off'
      }
    }
  ]
});
