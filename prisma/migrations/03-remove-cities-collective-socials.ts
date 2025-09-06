import type { AnyBulkWriteOperation, Document } from 'mongodb';
import { iconsole } from '../../projects/shared/iconsole';
import type { Migration } from './types';

interface CreatorDocument extends Document {
  socials: Array<{ platform: string }>;
}

export const migration: Migration = {
  async run(db, session) {
    const creators = await db
      .collection<CreatorDocument>('creators')
      .find({}, { session })
      .toArray();

    // Remove social link to Cities Collective, prepare bulk operations.
    const bulkOps: AnyBulkWriteOperation[] = [];

    for (const creator of creators) {
      const index = creator.socials.findIndex(social => social.platform == 'citiescollective');

      if (index != -1) {
        creator.socials.splice(index, 1);

        // Add update operation to bulk operations
        bulkOps.push({
          updateOne: {
            filter: { _id: creator._id },
            update: { $set: { socials: creator.socials } }
          }
        });
      }
    }

    // Remove social link to Cities Collective, execute all updates in bulk.
    if (bulkOps.length > 0) {
      const { modifiedCount: removedSocialLinksCount } = await db
        .collection('creators')
        .bulkWrite(bulkOps, { session });

      iconsole.log(`Removed ${removedSocialLinksCount} social links to Cities Collective.`);
    }

    // Remove citiesCollectiveId from creators.
    const { modifiedCount: removedCreatorLinksCount } = await db
      .collection('creators')
      .updateMany({}, { $unset: { citiesCollectiveId: '' } }, { session });

    iconsole.log(`Removed ${removedCreatorLinksCount} creator links to Cities Collective.`);

    // Remove citiesCollectiveId from screenshots.
    const { modifiedCount: removedScreenshotsLinksCount } = await db
      .collection('screenshots')
      .updateMany({}, { $unset: { citiesCollectiveId: '' } }, { session });

    iconsole.log(`Removed ${removedScreenshotsLinksCount} screenshots links to Cities Collective.`);
  }
};
