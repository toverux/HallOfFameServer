import type { Migration } from './types';

export const migration: Migration = {
  async run(db, session) {
    const modsToCleanup = await db
      .collection<{ shortDescription: string }>('mods')
      .find({ shortDescription: /[\r|\n]/gu }, { session })
      .toArray();

    for (const mod of modsToCleanup) {
      // oxlint-disable-next-line no-await-in-loop - migration: sequential writes are intentional to avoid overloading the DB
      await db
        .collection('mods')
        .updateOne(
          { _id: mod._id },
          { $set: { shortDescription: mod.shortDescription.trim().replaceAll('\r\n', '\n') } },
          { session }
        );
    }
  }
};
