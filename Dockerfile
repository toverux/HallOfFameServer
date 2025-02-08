# use the official Bun image
FROM oven/bun:1-alpine
WORKDIR /usr/src/app

# install Node.js LTS using apt
RUN apk add --update nodejs

COPY . .

RUN bun install --frozen-lockfile

ENV NODE_ENV=production
RUN bun run build

RUN bun install --frozen-lockfile --production

USER bun
EXPOSE 4000/tcp
ENTRYPOINT [ "bun", "run:server" ]
