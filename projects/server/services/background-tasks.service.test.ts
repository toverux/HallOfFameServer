import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { Logger } from '@nestjs/common';
import type { TestingModule } from '@nestjs/testing';
import * as Bun from 'bun';
import { createServiceTestingModule } from '../testing/testing-module';
import { BackgroundTasksService } from './background-tasks.service';

describe('BackgroundTasksService', () => {
  let testingModule: TestingModule;

  let backgroundTasks: BackgroundTasksService;

  beforeEach(async () => {
    testingModule = await createServiceTestingModule([BackgroundTasksService]);
    backgroundTasks = testingModule.get(BackgroundTasksService);
  });

  afterEach(async () => {
    await testingModule.close();
  });

  test(`settles once the running tasks, and the tasks they started, are done`, async () => {
    const done: string[] = [];

    backgroundTasks.run(`Failed to translate.`, async () => {
      await Bun.sleep(1);

      backgroundTasks.run(`Failed to warm up the mod cache.`, async () => {
        await Bun.sleep(1);
        done.push('mod cache warmup');
      });

      done.push('translation');
    });

    await backgroundTasks.settled();

    expect(done).toEqual(['translation', 'mod cache warmup']);
  });

  test(`logs a failing task instead of throwing`, async () => {
    const error = new Error('The translator is unavailable.');

    const logError = spyOn(Logger.prototype, 'error').mockReturnValue(void 0);

    backgroundTasks.run(`Failed to translate "東京".`, () => Promise.reject(error));

    await backgroundTasks.settled();

    expect(logError).toHaveBeenCalledWith(`Failed to translate "東京".`, error);

    logError.mockRestore();
  });

  test(`finishes the running tasks before the application shuts down`, async () => {
    const events: string[] = [];

    backgroundTasks.run(`Failed to translate.`, async () => {
      // Longer than shutting down takes.
      await Bun.sleep(100);
      events.push('translated');
    });

    await testingModule.close();

    events.push('shut down');

    expect(events).toEqual(['translated', 'shut down']);
  });
});
