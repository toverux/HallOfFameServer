import type { AnyBulkWriteOperation } from 'mongodb';
import type { Migration } from './index';

export const migration: Migration = {
  async run(db, session) {
    const platformCodesMap = {
      discord: 'discord',
      discordServer: 'discord',
      paradoxMods: 'paradoxmods',
      reddit: 'reddit',
      twitch: 'twitch',
      youtube: 'youtube'
    };

    // URL formatters matching the ones in CreatorService
    const formatSocialLink = {
      discord: (link: Record<string, unknown>) => `https://discord.gg/${link.code}`,
      paradoxmods: (link: Record<string, unknown>) =>
        `https://mods.paradoxplaza.com/authors/${link.username}`,
      reddit: (link: Record<string, unknown>) => `https://reddit.com/user/${link.username}`,
      twitch: (link: Record<string, unknown>) => `https://twitch.tv/${link.channel}`,
      youtube: (link: Record<string, unknown>) => `https://youtube.com/@${link.channel}`
    };

    const creators = await db.collection('creators').find({}, { session }).toArray();

    // biome-ignore lint/suspicious/noConsole: ok
    console.log(`Found ${creators.length} creators to migrate.`);

    // Prepare bulk operations
    const bulkOps: AnyBulkWriteOperation[] = [];

    for (const creator of creators) {
      const oldSocial = (creator.social ?? {}) as {
        [oldPlatformCode: string]: { [key: string]: unknown; clicks: number };
      };

      const newSocials: Array<{ platform: string; link: string; clicks: number }> = [];

      // Transform each platform from the old structure to new
      for (const [oldPlatformCode, linkData] of Object.entries(oldSocial)) {
        const platform = platformCodesMap[oldPlatformCode as keyof typeof platformCodesMap];

        const formatter = formatSocialLink[platform as keyof typeof formatSocialLink];

        newSocials.push({
          platform,
          link: formatter(linkData),
          clicks: linkData.clicks
        });
      }

      // Add update operation to bulk operations
      bulkOps.push({
        updateOne: {
          filter: { _id: creator._id },
          update: {
            $set: { socials: newSocials },
            $unset: { social: '' }
          }
        }
      });
    }

    // Execute all updates in bulk
    if (bulkOps.length > 0) {
      await db.collection('creators').bulkWrite(bulkOps, { session });
    }
  }
};
