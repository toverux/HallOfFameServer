import type { Migration } from './types';

export const migration: Migration = {
  async run(db, session) {
    await db.collection('creators').updateMany({}, { $set: { locale: null } }, { session });
  }
};
