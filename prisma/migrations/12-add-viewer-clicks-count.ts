import type { Migration } from './types';

export const migration: Migration = {
  async run(db, session) {
    await db
      .collection('screenshots')
      .updateMany({}, { $set: { viewerClicksCount: 0 } }, { session });

    await db.collection('creators').updateMany({}, { $set: { viewerClicksCount: 0 } }, { session });
  }
};
