import type { Migration } from './types';

export const migration: Migration = {
  async run(db, session) {
    const modsToCleanup = await db
      .collection('mods')
      .find({ shortDescription: /[\r|\n]/g }, { session })
      .toArray();

    for (const mod of modsToCleanup) {
      // biome-ignore lint/performance/noAwaitInLoops: doesn't matter.
      await db
        .collection('mods')
        .updateOne(
          { _id: mod._id },
          { $set: { shortDescription: mod.shortDescription.trim().replace(/\r\n/g, '\n') } },
          { session }
        );
    }
  }
};
