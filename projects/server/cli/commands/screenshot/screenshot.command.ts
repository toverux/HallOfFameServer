import type { Provider } from '@nestjs/common';
import { Command, CommandRunner } from 'nest-commander';
import { iconsole } from '../../../iconsole';
import { ScreenshotDeleteCommand } from './screenshot-delete.command';
import { ScreenshotFindSimilarCommand } from './screenshot-find-similar.command';
import { ScreenshotInferFeatureEmbeddingsCommand } from './screenshot-infer-feature-embeddings.command';
import { ScreenshotMergeCommand } from './screenshot-merge.command';
import { ScreenshotModerateCommand } from './screenshot-moderate.command';
import { ScreenshotTranslateCommand } from './screenshot-translate.command';
import { ScreenshotUpdateAveragesCommand } from './screenshot-update-averages.command';

@Command({
  name: 'screenshot',
  description: `Commands related to screenshots.`,
  subCommands: [
    ScreenshotDeleteCommand,
    ScreenshotFindSimilarCommand,
    ScreenshotInferFeatureEmbeddingsCommand,
    ScreenshotMergeCommand,
    ScreenshotModerateCommand,
    ScreenshotTranslateCommand,
    ScreenshotUpdateAveragesCommand
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
    ...ScreenshotTranslateCommand.providers(),
    ...ScreenshotUpdateAveragesCommand.providers()
  ];

  public override run(): Promise<void> {
    iconsole.error(`Please specify a subcommand.`);

    return Promise.resolve();
  }
}
