---
date: 2026-09-12
area: docker-compose.dev.yml
symptoms:
  - 'prisma db push failed, is MongoDB running (mise dev:db:start)?'
  - '`mise dev:db:start` hangs for minutes on a first start'
tags: [docker, compose, healthcheck, mongodb, replica-set, ci]
---

# Compose MongoDB not ready when tests start

## Problem

On an empty volume, as in every CI run, `docker compose up -d` returned before MongoDB accepted writes, so the test preload's `prisma db push` failed (`projects/server/testing/preload-database.ts:26`).

## What didn't work

- A healthcheck probing `localhost`: it passes against the temporary server described below, which then shuts down.
- `interval: 10m` with a 60s `start_period`: a start slower than the start period stalled `up --wait` for up to 10 minutes.

## Root cause

- On a first start, the mongo image's entrypoint runs the init scripts (`rs.initiate`) against a temporary mongod bound to 127.0.0.1 (`/usr/local/bin/docker-entrypoint.sh:306`), then starts the real one with `--bind_ip_all`.
- Docker probes at `start_interval` only during `start_period`; once it ends without a successful probe, the next one waits a full `interval`.

## Fix

The healthcheck asks the container's own address, which the temporary server does not listen on (`docker-compose.dev.yml:21`):

```sh
mongosh --quiet --host "$HOSTNAME" --eval 'db.hello().isWritablePrimary' | grep -q true
```

`dev:db:start` runs `up --wait --wait-timeout 120` (`mise.toml:45`), and `start_period: 2m` keeps the probes at one second for that whole wait.

## Prevention

Keep `start_period` at least as long as `--wait-timeout`, and the probe off `localhost`.
