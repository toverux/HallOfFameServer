import type { Migration } from './types';

export const migration: Migration = {
  async run(db, session) {
    await db
      .collection('mods')
      .updateMany({}, { $set: { isRetired: false, retiredReason: null } }, { session });
  }
};
