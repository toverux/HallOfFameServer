import type { Migration } from './types';

export const migration: Migration = {
  async run(db, session) {
    await db
      .collection('screenshot_feature_embeddings')
      .updateMany({}, { $set: { allowedSimilarityWithIds: [] } }, { session });
  }
};
