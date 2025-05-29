# => Use the official Bun image
#    We had to switch from alpine to slim because TensorFlow doesn't run on musl, it needs a glibc
#    distro. Other than that alpine was fine if we could switch back.
FROM oven/bun:1.2.15-slim AS base
WORKDIR /usr/src/app

# => Install Node.js.
#    Needed for Angular to build correctly, 'ng build' does not run well under Bun (hangs).
RUN apt-get update && apt-get install -y nodejs ca-certificates --no-install-recommends && rm -rf /var/lib/apt/lists/*

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

# copy production node_modules
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
# EfficientNet V2 TensoFlow model
COPY --from=prerelease /usr/src/app/efficientnetv2 efficientnetv2
# Prisma ORM files
COPY --from=prerelease /usr/src/app/node_modules/.prisma node_modules/.prisma
COPY --from=prerelease /usr/src/app/node_modules/.prisma node_modules/.prisma
COPY --from=prerelease /usr/src/app/prisma prisma

FROM release AS run

# => Sync database schema
RUN bun prisma db push --skip-generate

# => Run the app
USER bun
EXPOSE 4000/tcp
ENTRYPOINT [ "bun", "run:server" ]
