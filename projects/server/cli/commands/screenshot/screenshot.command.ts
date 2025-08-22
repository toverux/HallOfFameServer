import type { Provider } from '@nestjs/common';
import { Command, CommandRunner } from 'nest-commander';
import { iconsole } from '../../../../shared/iconsole';
import { ScreenshotDeleteCommand } from './screenshot-delete.command';
import { ScreenshotFindSimilarCommand } from './screenshot-find-similar.command';
import { ScreenshotInferFeatureEmbeddingsCommand } from './screenshot-infer-feature-embeddings.command';
import { ScreenshotMergeCommand } from './screenshot-merge.command';
import { ScreenshotModerateCommand } from './screenshot-moderate.command';
import { ScreenshotResyncStatsCommand } from './screenshot-resync-stats.command';
import { ScreenshotTranslateCommand } from './screenshot-translate.command';

/** @public */
@Command({
  name: 'screenshot',
  description: `Commands related to screenshots.`,
  subCommands: [
    ScreenshotDeleteCommand,
    ScreenshotFindSimilarCommand,
    ScreenshotInferFeatureEmbeddingsCommand,
    ScreenshotMergeCommand,
    ScreenshotModerateCommand,
    ScreenshotResyncStatsCommand,
    ScreenshotTranslateCommand
  ]
})
export class ScreenshotCommand extends CommandRunner {
  public static readonly providers: () => Provider[] = () => [
    ScreenshotCommand,
    ...ScreenshotDeleteCommand.providers(),
    ...ScreenshotFindSimilarCommand.providers(),
    ...ScreenshotInferFeatureEmbeddingsCommand.providers(),
    ...ScreenshotMergeCommand.providers(),
    ...ScreenshotModerateCommand.providers(),
    ...ScreenshotResyncStatsCommand.providers(),
    ...ScreenshotTranslateCommand.providers()
  ];

  public override run(): Promise<void> {
    iconsole.error(`Please specify a subcommand.`);

    return Promise.resolve();
  }
}
