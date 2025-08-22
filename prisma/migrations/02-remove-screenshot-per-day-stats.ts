import type { Migration } from './types';

export const migration: Migration = {
  async run(db, session) {
    await db.collection('screenshots').updateMany(
      {},
      {
        $unset: {
          favoritesPerDay: '',
          viewsPerDay: ''
        },
        $set: {
          uniqueViewsCount: 0
        }
      },
      { session }
    );
  }
};
