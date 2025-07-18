import { Controller, Inject, Post, Req, UseGuards } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import type { JsonObject } from '../../common';
import { CreatorAuthorizationGuard } from '../../guards';
import { CitiesCollectiveService } from '../../services';

@Controller('citiescollective')
@UseGuards(CreatorAuthorizationGuard)
export class CitiesCollectiveController {
  @Inject(CitiesCollectiveService)
  private readonly citiesCollectiveService!: CitiesCollectiveService;

  /**
   * To be called when a user first sets up their HoF Creator ID on Cities Collective, and for later
   * updates.
   */
  @Post('user/updated')
  public async userUpdated(@Req() req: FastifyRequest): Promise<JsonObject> {
    const creator = CreatorAuthorizationGuard.getAuthenticatedCreator(req);

    const updatedCreator = await this.citiesCollectiveService.syncCreator(creator);

    return { id: updatedCreator.id };
  }
}
