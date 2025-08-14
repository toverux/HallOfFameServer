import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Creator } from '@prisma/client';
import * as sentry from '@sentry/bun';
import { oneLine } from 'common-tags';
import { z } from 'zod';
import { allFulfilled } from '../common';
import { CreatorService } from './creator.service';
import { PrismaService } from './prisma.service';

/**
 * Service for communicating with Cities Collective.
 *
 * @see https://citiescollective.space
 */
@Injectable()
export class CitiesCollectiveService {
  private static readonly baseUrl = 'https://citiescollective.space';

  private static readonly citiesCollectiveUserSchema = z.looseObject({
    user: z.looseObject({
      id: z.number(),
      username: z.string(),
      socialLinks: z.array(
        z.looseObject({
          platform: z.string(),
          url: z.string()
        })
      ),
      cities: z.array(
        z.looseObject({
          id: z.number(),
          name: z.string()
        })
      )
    })
  });

  @Inject(PrismaService)
  private readonly prisma!: PrismaService;

  @Inject(CreatorService)
  private readonly creatorService!: CreatorService;

  private readonly logger = new Logger(CitiesCollectiveService.name);

  public getCityPageUrl(cityId: string): string {
    return `${CitiesCollectiveService.baseUrl}/city/${cityId}`;
  }

  public async syncCreator(
    creator: Pick<Creator, 'id' | 'creatorId' | 'creatorName' | 'socials'>
  ): Promise<Creator> {
    this.logger.verbose(`Syncing Creator #${creator.id} from Cities Collective.`);

    // Fetch user details on Cities Collective.
    const userResponse = await fetch(`${CitiesCollectiveService.baseUrl}/api/v1/hof-creator/me`, {
      headers: { authorization: `CreatorID ${creator.creatorId}` }
    });

    // Check the response is 2XX.
    if (!userResponse.ok) {
      throw new Error(
        oneLine`Cities Collective API returned ${userResponse.status} ${userResponse.statusText}:
        ${await userResponse.text()}`
      );
    }

    const jsonBody = await userResponse.json();

    this.logger.verbose(
      `Fetched user details for Creator #${creator.id} from Cities Collective.`,
      jsonBody
    );

    const { user } = CitiesCollectiveService.citiesCollectiveUserSchema.parse(jsonBody);

    user.socialLinks.push({
      platform: 'citiescollective',
      url: `https://citiescollective.space/user/${user.id}`
    });

    const socials: Creator['socials'] = user.socialLinks.map(link => ({
      platform: link.platform,
      link: link.url,
      clicks: creator.socials.find(social => social.platform == link.platform)?.clicks ?? 0
    }));

    const updatedCreator = await this.prisma.creator.update({
      where: { id: creator.id },
      data: {
        creatorName: user.username,
        creatorNameSlug: this.creatorService.getCreatorNameSlug(user.username),
        citiesCollectiveId: user.id.toString(),
        socials
      }
    });

    if (updatedCreator.creatorName != creator.creatorName) {
      backgroundUpdateCreatorNameTranslation.call(this);
    }

    await allFulfilled(
      user.cities.map(city =>
        this.prisma.screenshot.updateMany({
          where: { cityName: { equals: city.name, mode: 'insensitive' } },
          data: { citiesCollectiveId: city.id.toString() }
        })
      )
    );

    this.logger.verbose(
      `Synced Creator #${creator.id} with user #${user.id} from Cities Collective.`
    );

    return updatedCreator;

    function backgroundUpdateCreatorNameTranslation(this: CitiesCollectiveService): void {
      this.creatorService.updateCreatorNameTranslation(updatedCreator).catch(error => {
        this.logger.error(
          `Failed to translate creator name "${updatedCreator.creatorName}" (#${updatedCreator.id}).`,
          error
        );

        sentry.captureException(error);
      });
    }
  }
}
