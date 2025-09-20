# => Use Ubuntu because:
#    - TensorFlow doesn't run on musl, it needs a glibc distro. Other than that alpine was fine if
#      we could switch back.
#    - I used Debian Slim to fix the musl issue but that later conflicted with mise requiring a more
#      recent version of glibc.
#    - Using a custom distro instead of bun's one, we can install tools via mise and have one souce
#      of truth for tools' versions.
FROM ubuntu:24.04 AS base
WORKDIR /usr/src/app

# Fail fast!
SHELL ["/bin/bash", "-euo", "pipefail", "-c"]

# => Install mise-en-place to handle Bun and Node installation from mise.toml
#    Node is needed for Angular to build correctly, 'ng build' does not run well under Bun (hangs).

RUN apt-get update  \
    && apt-get -y --no-install-recommends install curl ca-certificates \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

ENV MISE_DATA_DIR="/mise"
ENV MISE_CONFIG_DIR="/mise"
ENV MISE_CACHE_DIR="/mise/cache"
ENV MISE_INSTALL_PATH="/usr/local/bin/mise"
ENV PATH="/mise/shims:$PATH"

COPY mise.toml $MISE_CONFIG_DIR/config.toml

RUN curl https://mise.run | sh
RUN mise trust && mise install

# => Configure Bun user
# Use GID/UID 1001 to avoid conflict with Ubuntu's default user (GID 1000)

RUN groupadd bun \
      --gid 1001 \
    && useradd bun \
      --uid 1001 \
      --gid bun \
      --shell /bin/sh \
      --create-home

# Disable the runtime transpiler cache by default inside Docker containers.
# On ephemeral containers, the cache is not useful.
ENV BUN_RUNTIME_TRANSPILER_CACHE_PATH=0

FROM base AS install

# => Install dependencies into temp directory.
#    This will cache them and speed up future builds.
RUN mkdir -p /temp/dev /temp/prod
COPY package.json bun.lock prisma /temp/dev/
RUN cd /temp/dev && bun install --frozen-lockfile

# => Install with --production (exclude devDependencies)
RUN cp -r /temp/dev/* /temp/prod/ \
    && cd /temp/prod \
    && bun install --frozen-lockfile --production

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
COPY --from=prerelease /usr/src/app/projects/shared projects/shared
# EfficientNet V2 TensoFlow model
COPY --from=prerelease /usr/src/app/efficientnetv2 efficientnetv2
# Prisma ORM files
COPY --from=prerelease /usr/src/app/node_modules/.prisma node_modules/.prisma
COPY --from=prerelease /usr/src/app/node_modules/.prisma node_modules/.prisma
COPY --from=prerelease /usr/src/app/prisma prisma

FROM release AS run

# => Sync database schema & migrate
RUN bun prisma db push --skip-generate
RUN bun run:cli migrate

# => Run the app
USER bun
EXPOSE 4000/tcp
ENTRYPOINT [ "bun", "run:server" ]
