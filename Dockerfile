# use the official Bun image
FROM oven/bun:1.2.5-alpine AS base
WORKDIR /usr/src/app

# => Install Node.js.
#    Needed for Angular to build correctly, 'ng build' does not run well under Bun (hangs).
RUN apk add --update nodejs

# => Install dependencies into temp directory.
#    This will cache them and speed up future builds.
FROM base AS install
RUN mkdir -p /temp/dev /temp/prod
COPY package.json bun.lock prisma /temp/dev/
RUN cd /temp/dev && bun install --frozen-lockfile

# => Install with --production (exclude devDependencies)
RUN cp -r /temp/dev/* /temp/prod/ \
    && cd /temp/prod && \
    bun install --frozen-lockfile --production

# => Copy node_modules from temp directory.
#    Then copy all (non-ignored) project files into the image.
FROM base AS prerelease
COPY --from=install /temp/dev/node_modules node_modules
COPY . .

# => Build
ENV NODE_ENV=production
RUN bun run build

# => Copy production dependencies and source code into final image.
FROM base AS release

COPY --from=install /temp/prod/node_modules node_modules
# needed for default environment values
COPY --from=prerelease /usr/src/app/.env .
# needed for NestJS dependency injection
COPY --from=prerelease /usr/src/app/tsconfig.json .
# always useful
COPY --from=prerelease /usr/src/app/package.json .
# frontend build
COPY --from=prerelease /usr/src/app/dist dist
# server source code, ran directly by Bun (no transpilation)
COPY --from=prerelease /usr/src/app/projects/server projects/server
# needed for Prisma ORM
COPY --from=prerelease /usr/src/app/prisma prisma

FROM release AS run

# => Sync database schema
RUN bun prisma db push --skip-generate

# => Run the app
USER bun
EXPOSE 4000/tcp
ENTRYPOINT [ "bun", "run:server" ]
