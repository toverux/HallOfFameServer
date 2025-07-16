import { Body, Controller, Inject, Post, Req, UseGuards } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { JsonObject } from '../../common';
import { CreatorAuthorizationGuard } from '../../guards';
import { ZodParsePipe } from '../../pipes';
import { PrismaService } from '../../services';

@Controller('citiescollective')
@UseGuards(CreatorAuthorizationGuard)
export class CitiesCollectiveController {
  /** @see userUpdated */
  private static readonly userUpdatedBodySchema = z.strictObject({ id: z.string() });

  @Inject(PrismaService)
  private readonly prisma!: PrismaService;

  /**
   * To be called when a user first sets up their HoF Creator ID on Cities Collective, and for later
   * updates.
   */
  @Post('user/updated')
  public async userUpdated(
    @Req() req: FastifyRequest,
    @Body(new ZodParsePipe(CitiesCollectiveController.userUpdatedBodySchema))
    body: z.infer<typeof CitiesCollectiveController.userUpdatedBodySchema>
  ): Promise<JsonObject> {
    const creator = CreatorAuthorizationGuard.getAuthenticatedCreator(req);

    const updatedCreator = await this.prisma.creator.update({
      where: { id: creator.id },
      data: { citiesCollectiveId: body.id },
      select: { id: true }
    });

    return { id: updatedCreator.id };
  }
}
