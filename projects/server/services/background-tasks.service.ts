import { type BeforeApplicationShutdown, Injectable, Logger } from '@nestjs/common';
import * as sentry from '@sentry/bun';
import { allFulfilled } from '../../shared/utils/all-fulfilled';

/**
 * Runs the work that requests and commands do not wait for, like translations and cache warmups,
 * and waits for it before the application shuts down, so none is cut short.
 * Services holding resources that tasks use release them on application shutdown, which comes
 * after.
 */
@Injectable()
export class BackgroundTasksService implements BeforeApplicationShutdown {
  private readonly logger = new Logger(BackgroundTasksService.name);

  private readonly running = new Set<Promise<void>>();

  /**
   * Starts `task` without waiting for it.
   * A failure is logged with `failureMessage` and reported to Sentry, never thrown.
   */
  public run(failureMessage: string, task: () => Promise<unknown>): void {
    const promise = this.settle(failureMessage, task)
      // oxlint-disable-next-line promise/prefer-await-to-then
      .finally(() => {
        this.running.delete(promise);
      });

    this.running.add(promise);
  }

  /**
   * Resolves once no task is running, including the tasks that running ones started meanwhile.
   */
  public async settled(): Promise<void> {
    if (this.running.size) {
      await allFulfilled(Array.from(this.running));
      await this.settled();
    }
  }

  public beforeApplicationShutdown(): Promise<void> {
    return this.settled();
  }

  private async settle(failureMessage: string, task: () => Promise<unknown>): Promise<void> {
    try {
      await task();
    } catch (error) {
      this.logger.error(failureMessage, error);

      sentry.captureException(error);
    }
  }
}
