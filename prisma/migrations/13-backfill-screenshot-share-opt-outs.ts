import type { ObjectId } from 'mongodb';
import type { Migration } from './types';

/**
 * Migration 04 set both share flags to shared on every screenshot that predated them, a consent
 * nobody gave.
 * For each flag independently, a creator whose uploads since the cutoff all opted out has that flag
 * opted out on their older screenshots too.
 * Any other creator keeps shared: no later uploads, or mixed later choices, are no evidence.
 */
export const migration: Migration = {
  async run(db, session) {
    // The day mod 2026.0.0, the first to let creators choose, reached players.
    const cutoff = new Date('2026-01-16T00:00:00Z');

    const screenshots = db.collection('screenshots');

    for (const flag of ['shareParadoxModIds', 'shareRenderSettings']) {
      // oxlint-disable-next-line no-await-in-loop - a transaction session runs one operation at a time
      const optedOutCreatorIds = await screenshots
        .aggregate<{ _id: ObjectId }>(
          [
            { $match: { createdAt: { $gte: cutoff } } },
            // Booleans sort false before true: the maximum is false only if every upload opted out.
            { $group: { _id: '$creatorId', isShared: { $max: `$${flag}` } } },
            { $match: { isShared: false } }
          ],
          { session }
        )
        .map(group => group._id)
        .toArray();

      // oxlint-disable-next-line no-await-in-loop - a transaction session runs one operation at a time
      await screenshots.updateMany(
        { creatorId: { $in: optedOutCreatorIds }, createdAt: { $lt: cutoff } },
        { $set: { [flag]: false } },
        { session }
      );
    }
  }
};
