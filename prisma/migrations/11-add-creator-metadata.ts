import type { Migration } from './types';

export const migration: Migration = {
  async run(db, session) {
    await db.collection('creators').updateMany(
      {},
      [
        {
          $set: {
            metadata: {
              enableMainMenuSlideshow: '$modSettings.EnableMainMenuSlideshow',
              enableLoadingScreenBackground: '$modSettings.EnableLoadingScreenBackground',
              showFeaturedAsset: '$modSettings.ShowFeaturedAsset',
              showCreatorSocials: '$modSettings.ShowCreatorSocials',
              showViewCount: '$modSettings.ShowViewCount',
              namesTranslationMode: '$modSettings.NamesTranslationMode',
              popularScreenshotWeight: '$modSettings.PopularScreenshotWeight',
              trendingScreenshotWeight: '$modSettings.TrendingScreenshotWeight',
              recentScreenshotWeight: '$modSettings.RecentScreenshotWeight',
              archeologistScreenshotWeight: '$modSettings.ArcheologistScreenshotWeight',
              randomScreenshotWeight: '$modSettings.RandomScreenshotWeight',
              supporterScreenshotWeight: '$modSettings.SupporterScreenshotWeight',
              viewMaxAge: '$modSettings.ViewMaxAge',
              screenshotResolution: '$modSettings.ScreenshotResolution',
              createLocalScreenshot: '$modSettings.CreateLocalScreenshot',
              disableGlobalIllumination: '$modSettings.DisableGlobalIllumination',
              paradoxModsBrowsingPreference: '$modSettings.ParadoxModsBrowsingPreference'
            }
          }
        },
        {
          $unset: 'modSettings'
        }
      ],
      { session }
    );
  }
};
