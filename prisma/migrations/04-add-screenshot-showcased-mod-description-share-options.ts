import type { Migration } from './types';

export const migration: Migration = {
  async run(db, session) {
    await db.collection('screenshots').updateMany(
      {},
      {
        $set: {
          showcasedModId: null,
          description: null,
          shareParadoxModIds: true,
          shareRenderSettings: true
        }
      },
      { session }
    );
  }
};
