/**
 * Expected wire formats of serialized records, for HTTP tests to assert with `toEqual`.
 * Each derives from the records a test seeded; overrides adjust what the route or the requester
 * changes.
 */

import { expect } from 'bun:test';
import type { Creator, Favorite, Mod, Screenshot, View } from '#prisma-lib/client';
import { config } from '../config';

type Payload = Record<string, unknown>;

/**
 * The day the mod release capturing each field reached players.
 * Listed in the order `capabilities` lists them.
 */
const capabilitiesSince: Readonly<Record<string, string>> = {
  description: '2026-01-16T00:00:00Z',
  shareParadoxModIds: '2026-01-16T00:00:00Z',
  paradoxModIds: '2025-03-30T00:00:00Z',
  shareRenderSettings: '2026-01-16T00:00:00Z',
  renderSettings: '2025-03-30T00:00:00Z',
  renderConditions: '2026-10-04T00:00:00Z'
};

/**
 * The Screenshot as `ScreenshotService.serialize` returns it, shared by every screenshot route.
 * Relations (`showcasedMod`, `favorites`, `views`) and the route's own `__` fields go in
 * `overrides`, when the route sends them.
 * Formatted dates match any string; the localization tests pin them.
 */
export function expectedScreenshotPayload(
  screenshot: Screenshot,
  creator: Creator,
  overrides: Readonly<Payload> = {}
): Payload {
  return {
    id: screenshot.id,
    isApproved: screenshot.isApproved,
    isReported: screenshot.isReported,
    favoritesCount: screenshot.favoritesCount,
    favoritingPercentage: screenshot.favoritingPercentage,
    viewsCount: screenshot.viewsCount,
    uniqueViewsCount: screenshot.uniqueViewsCount,
    viewerUrl: `${config.http.baseUrl}/api/v1/screenshots/${screenshot.id}/viewer`,
    viewerClicksCount: screenshot.viewerClicksCount,
    cityName: screenshot.cityName,
    cityNameLocale: screenshot.cityNameLocale,
    cityNameLatinized: screenshot.cityNameLatinized,
    cityNameTranslated: screenshot.cityNameTranslated,
    cityMilestone: screenshot.cityMilestone,
    cityPopulation: screenshot.cityPopulation,
    mapName: screenshot.mapName,
    description: screenshot.description,
    imageUrlThumbnail: cdnUrl(screenshot.imageUrlThumbnail),
    imageUrlFHD: cdnUrl(screenshot.imageUrlFHD),
    imageUrl4K: cdnUrl(screenshot.imageUrl4K),
    shareParadoxModIds: screenshot.shareParadoxModIds,
    paradoxModIds: screenshot.paradoxModIds,
    shareRenderSettings: screenshot.shareRenderSettings,
    renderSettings: screenshot.renderSettings,
    renderConditions: screenshot.renderConditions,
    capabilities: Object.entries(capabilitiesSince)
      .filter(([, since]) => screenshot.createdAt >= new Date(since))
      .map(([field]) => field),
    createdAt: screenshot.createdAt.toISOString(),
    createdAtFormatted: expect.any(String),
    createdAtFormattedDistance: expect.any(String),
    creatorId: creator.id,
    creator: expectedCreatorPayload(creator),
    showcasedModId: screenshot.showcasedModId,
    ...overrides
  };
}

function expectedCreatorPayload(creator: Creator): Payload {
  return {
    id: creator.id,
    creatorName: creator.creatorName,
    creatorNameSlug: creator.creatorNameSlug,
    creatorNameLocale: creator.creatorNameLocale,
    creatorNameLatinized: creator.creatorNameLatinized,
    creatorNameTranslated: creator.creatorNameTranslated,
    createdAt: creator.createdAt.toISOString(),
    viewerUrl: `${config.http.baseUrl}/api/v1/creators/${creator.id}/viewer`,
    viewerClicksCount: creator.viewerClicksCount,
    socials: creator.socials.map(social => ({
      platform: social.platform,
      link: `${config.http.baseUrl}/api/v1/creators/${creator.id}/social/${social.platform}`,
      clicks: social.clicks
    }))
  };
}

/**
 * @param creator The Creator who favorited, when the route loads it.
 */
export function expectedFavoritePayload(favorite: Favorite, creator?: Creator): Payload {
  return {
    id: favorite.id,
    favoritedAt: favorite.favoritedAt.toISOString(),
    creatorId: favorite.creatorId,
    creator: creator && expectedCreatorPayload(creator),
    screenshotId: favorite.screenshotId
  };
}

/**
 * @param creator The Creator who viewed, when the route loads it.
 */
export function expectedViewPayload(view: View, creator?: Creator): Payload {
  return {
    id: view.id,
    creatorId: view.creatorId,
    creator: creator && expectedCreatorPayload(creator),
    screenshotId: view.screenshotId,
    viewedAt: view.viewedAt.toISOString()
  };
}

/**
 * The Mod as `ModService.serialize` returns it.
 * The wire state defaults to "published", that of a mod seeded without a state;
 * a test seeding another state passes the one it expects in `overrides`.
 * Formatted fields match any string when set; the localization tests pin them.
 */
export function expectedModPayload(mod: Mod, overrides: Readonly<Payload> = {}): Payload {
  return {
    id: mod.id,
    paradoxModId: mod.paradoxModId,
    name: mod.name,
    authorName: mod.authorName,
    shortDescription: mod.shortDescription,
    thumbnailUrl: mod.thumbnailUrl,
    previewUrls: mod.previewUrls,
    tags: mod.tags,
    subscribersCount: mod.subscribersCount,
    knownLastUpdatedAt: mod.knownLastUpdatedAt.toISOString(),
    state: 'published',
    requiredGameVersion: mod.requiredGameVersion,
    sizeBytes: mod.sizeBytes == null ? null : Number(mod.sizeBytes),
    sizeFormatted: mod.sizeBytes == null ? null : expect.any(String),
    knownLastReleasedAt: mod.knownLastReleasedAt?.toISOString() ?? null,
    knownLastReleasedAtFormattedDistance:
      mod.knownLastReleasedAt == null ? null : expect.any(String),
    skyve:
      mod.skyve &&
      ({
        ...mod.skyve,
        reviewedAt: mod.skyve.reviewedAt?.toISOString() ?? null,
        reviewedAtFormattedDistance: mod.skyve.reviewedAt == null ? null : expect.any(String)
      } satisfies Payload),
    ...overrides
  };
}

function cdnUrl(blobName: string): string {
  return `${config.azure.cdn}/${config.azure.screenshotsContainer}/${blobName}`;
}
