---
date: 2026-09-12
status: accepted
---

# Track fire-and-forget work in BackgroundTasksService

## Context

Uploads, screenshot edits, and account creation start work the response does not wait for: city and creator name translations, similarity embeddings, and mod cache warmups.
Each call site caught, logged, and reported its own promise, and nothing held the promises, so closing the app (a test ending, the CLI exiting) cut the work short or let it write into the next test's database.
The live alternatives: leave the promises untracked and have tests poll the database for each task's side effect, or track them in one place.

## Decision

Fire-and-forget work runs through `BackgroundTasksService.run(failureMessage, task)`, which logs and reports a failure to Sentry and holds the task until it settles; the service waits for running tasks in `beforeApplicationShutdown`.
One tracker waits for every task, current and future, where polling makes each test know how each task marks itself done.

## Consequences

- Closing the test app waits for background work; a test awaits `backgroundTasks.settled()` before asserting on it.
- Resources that tasks use release in `onApplicationShutdown`, see `docs/solutions/background-work-fails-during-app-close.md`.
- Shutdown waits as long as the slowest task, so a task's outbound calls need timeouts; Paradox Mods lookups time out per attempt.
- The server enables shutdown hooks, so a deploy's SIGTERM drains the tasks. Its mise task is not `raw`, since a `raw` task exits on SIGTERM without passing it on.
- A request still in flight while the HTTP server closes can start a task after the drain.
