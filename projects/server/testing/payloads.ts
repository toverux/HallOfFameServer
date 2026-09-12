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

export function expectedModPayload(mod: Mod): Payload {
  return {
    id: mod.id,
    paradoxModId: mod.paradoxModId,
    name: mod.name,
    authorName: mod.authorName,
    shortDescription: mod.shortDescription,
    thumbnailUrl: mod.thumbnailUrl,
    tags: mod.tags,
    subscribersCount: mod.subscribersCount,
    knownLastUpdatedAt: mod.knownLastUpdatedAt.toISOString()
  };
}

function cdnUrl(blobName: string): string {
  return `${config.azure.cdn}/${config.azure.screenshotsContainer}/${blobName}`;
}
