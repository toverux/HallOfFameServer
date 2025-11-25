# <img src="logo.png" alt="Hall of Fame logo" align="right" style="width: 256px">Hall of Fame Server

[![Discord](https://img.shields.io/badge/Discord-@toverux-5865f2?logo=discord&logoColor=white)](https://discord.gg/SsshDVq2Zj)
[![Paradox Mods](https://img.shields.io/badge/Paradox_Mods-Hall_of_Fame-5abe41)](https://mods.paradoxplaza.com/mods/90641/Windows)
[![Crowdin](https://badges.crowdin.net/halloffame-cs2/localized.svg)](https://crowdin.com/project/halloffame-cs2)

Server part of the [Hall of Fame](https://github.com/toverux/HallOfFame) mod for Cities: Skylines II.

This is a [Nest.js](https://nestjs.com/) project with an [Angular](https://angular.dev) w/SSR
frontend (skeleton, not developed yet) and [Prisma](https://www.prisma.io) as a MongoDB ORM.

Featuring a simple RESTish HTTP API for uploading photos from the mod and retrieving them.

## Features & Roadmap

Find our user feedback, feature request and roadmap board here:
[feedback.halloffame.cs2.mtq.io](https://feedback.halloffame.cs2.mtq.io).

## Development

### Installation

1. (Recommended) Install [mise-en-place](https://mise.jdx.dev) for per-project Bun & Node.js
   version management. Without mise, just match the required versions specified in `mise.toml`.
   For now, Node is still and only needed alongside Bun to run Angular CLI, which hangs on
   "Building..." on Bun.
2. Run `mise i` to install the required version of Bun and Node.js,
3. Run `bun i` to install dependencies.
4. You may `bun run build` to test that the project builds and everything is in order.
5. Install [MongoDB](https://www.mongodb.com/docs/manual/administration/install-community)
   ([more direct download links here](https://www.mongodb.com/try/download/community-edition)),
   mongosh, and set up a replica set, here's an example, but it varies according to your setup and
   preferences:
6. Set this in your configuration file (Linux: `/etc/mongod.conf`,
   Windows: `C:\Program Files\MongoDB\Server\7.0\bin\mongod.cfg`):
   ```yml
   replication:
     replSetName: rs0
   ```
7. Restart MongoDB (`sudo systemctl restart mongod`, Windows: open "Services" then search for
   "MongoDB Server", right-click it and choose Restart).
8. Connecting to the database using `mongosh`, run `rs.initiate()` to create a default rs0 replica
   set, check there's no error.
9. Run `bun prisma db push` to create the database, collections, and indexes.
10. Done! Test that the server is working with `bun run:server:watch`.

To set up a replica set, you can also follow
[this guide](https://www.mongodb.com/docs/manual/tutorial/convert-standalone-to-replica-set).

### Development Workflow

TBD

### Generating Database Schema

Database schema is generated from the Prisma schema file in `prisma/schema.prisma`.

You might have to reconfigure the default development connection string if it differs from the
default in `.env`.
If it does differ, as `.env` is a defaults files that is versioned, do not change it, instead
override locally in `.env.local`.

- Update database schema from Prisma schema: `bun prisma db push`.<br>
  As the database is MongoDB which is schema-less, this essentially just creates the collections
  (and the database if it does not exist), and indexes.
- Update Prisma Client definitions after schema change: `bun prisma generate`.<br>
  Note that this is also done by `bun prisma db push`.

### Dump & Restore Database

Example for production to a local database:

```shell
mongodump --uri "mongodb://user:pass@server:port/halloffame?replicaSet=rs0&directConnection=true" --gzip --archive=halloffame.mongoarchive

mongorestore --uri "mongodb://localhost/halloffame?replicaSet=rs0" --gzip --archive=halloffame.mongoarchive --nsInclude='default.*' --nsFrom='default.*' --nsTo='halloffame.*' --drop

# Migrate database if needed
bun prisma db push && bun run:cli migrate
```

### Updating Dependencies & Toolchain

`mise deps:upgrade` will update mise, will propose to update Bun, and then show an interactive
update for npm dependencies.

## Code Style

### TypeScript

TypeScript code is formatted and linted by [Biome](https://biomejs.dev).

Run `bun check` to typecheck the database, linting errors, format files, and autofix simple issues.
You can also use Biome directly with `bun biome`.

The formatter and linter should run as a pre-commit hook if you have it installed, which should be
done automatically when running `bun i` (otherwise, run `bun lefthook install`).

I'd suggest using a Biome plugin for your editor to ease development.

If a rule seems out of place for this project, you can either disable/reconfigure it in the
`biome.json` file or disable it with an annotation comment, but these should be justified and
concerted.

### Commit messages

Commits must follow the [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0)
specification and more specifically, the Angular one.

For the scope of the conventional commit, take inspiration from previously used scopes.
