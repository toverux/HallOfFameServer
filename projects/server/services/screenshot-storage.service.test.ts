import { describe, expect, test } from 'bun:test';
import { getScreenshotBlobNames } from './screenshot-storage.service';

const creatorId = '64f0c0ffee0000000000c0de';

const screenshotId = '64f0c0ffee0000000000beef';

// Formatted in the process timezone, UTC in tests.
const uploadedAt = new Date('2026-03-14T15:09:26Z');

describe('getScreenshotBlobNames', () => {
  test(`names the three images under the creator, then the screenshot`, () => {
    const blobNameBase = `${creatorId}/${screenshotId}/tokyo-bay-by-mayor-1-2026-03-14-15-09-26`;

    expect(
      getScreenshotBlobNames(
        { id: creatorId, creatorNameSlug: 'mayor-1' },
        { id: screenshotId, cityName: 'Tokyo Bay' },
        uploadedAt
      )
    ).toEqual({
      blobThumbnail: `${blobNameBase}-thumbnail.jpg`,
      blobFhd: `${blobNameBase}-fhd.jpg`,
      blob4k: `${blobNameBase}-4k.jpg`
    });
  });

  // The slug transliterates what it can, and drops what it cannot, ex. Chinese or Korean.
  test.each([
    { cityName: 'Nouvelle-Écluse', creatorNameSlug: 'мэр', slug: 'nouvelle-ecluse-by-mer' },
    { cityName: 'Tokyo Bay', creatorNameSlug: null, slug: 'tokyo-bay' },
    { cityName: 'Tokyo Bay', creatorNameSlug: '서울시장', slug: 'tokyo-bay' },
    { cityName: '東京', creatorNameSlug: 'mayor-1', slug: 'mayor-1' },
    { cityName: '東京', creatorNameSlug: null, slug: 'screenshot' },
    { cityName: '東京', creatorNameSlug: '서울시장', slug: 'screenshot' }
  ])(`slugs "$cityName" by $creatorNameSlug as "$slug"`, ({ cityName, creatorNameSlug, slug }) => {
    const { blobFhd } = getScreenshotBlobNames(
      { id: creatorId, creatorNameSlug },
      { id: screenshotId, cityName },
      uploadedAt
    );

    expect(blobFhd).toBe(`${creatorId}/${screenshotId}/${slug}-2026-03-14-15-09-26-fhd.jpg`);
  });
});
