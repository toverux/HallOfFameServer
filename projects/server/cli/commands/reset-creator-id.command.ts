import assert from 'node:assert/strict';
import { Inject, Provider } from '@nestjs/common';
import { oneLine } from 'common-tags';
import { Command, CommandRunner } from 'nest-commander';
import { CreatorService } from '../../services';

@Command({
    name: 'reset-creatorid',
    description: `Reset the Creator ID for a given Creator Name.`,
    arguments: '<creatorName> [creatorId]',
    argsDescription: {
        creatorName: `The Creator Name to reset the Creator ID for.`,
        creatorId: oneLine`
            The new Creator ID to set. If not provided, a new UUIDv4 string will
            be generated and printed to the console.`
    }
})
class ResetCreatorIdCommand extends CommandRunner {
    @Inject(CreatorService)
    private readonly creatorService!: CreatorService;

    public override async run(args: string[]): Promise<void> {
        const [creatorName, userProvidedCreatorId] = args;
        assert(creatorName);

        const { creator, creatorId } = await this.creatorService.resetCreatorId(
            creatorName,
            userProvidedCreatorId
        );

        console.info(
            `Creator ID for "${creator.creatorName}" reset to "${creatorId}".`
        );
    }
}

export const resetCreatorIdCommandProviders: Provider[] = [
    ResetCreatorIdCommand
];
