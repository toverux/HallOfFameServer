import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Inject,
  type OnApplicationBootstrap,
  Post,
  Req,
  UseGuards
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { isPrismaError } from '../../common/prisma-errors';
import { sessionIdSchema } from '../../common/session-id';
import { CreatorAuthorizationGuard } from '../../guards';
import { ZodParsePipe } from '../../pipes';
import { CreatorAuthenticationService, PrismaService } from '../../services';

@Controller('usage')
@UseGuards(CreatorAuthorizationGuard)
export class UsageController implements OnApplicationBootstrap {
  /**
   * How long a {@link UsageEvent} is kept after its receipt, in seconds: 365 days.
   * The mod page promises this retention to players: change both together.
   */
  private static readonly retentionSeconds = 31_536_000;

  /**
   * The TTL index that expires usage events, see {@link onApplicationBootstrap}.
   */
  private static readonly ttlIndex = {
    key: { receivedAt: 1 },
    name: 'receivedAt_ttl',
    expireAfterSeconds: UsageController.retentionSeconds
  } as const;

  /**
   * The most events a batch holds; the mod flushes at half of it, so a batch never reaches it:
   * change both together.
   */
  private static readonly maxEventsPerBatch = 100;

  private static readonly maxVersionLength = 32;

  private static readonly maxEventNameLength = 64;

  private static readonly maxPropertiesPerEvent = 20;

  private static readonly maxPropertyKeyLength = 64;

  private static readonly maxPropertyStringLength = 256;

  /**
   * @see postEvents
   */
  private static readonly eventsBodySchema = z.strictObject({
    sessionId: sessionIdSchema,
    modVersion: z.string().min(1).max(UsageController.maxVersionLength),
    gameVersion: z.string().min(1).max(UsageController.maxVersionLength),
    debug: z.boolean(),
    events: z
      .array(
        z.strictObject({
          // Not an enum, so a mod version sending a name this server does not know still passes.
          name: z.string().min(1).max(UsageController.maxEventNameLength),
          properties: z
            .record(
              // A plain field name, as a key starting with `$` reads as Extended JSON on insert,
              // and a dotted or empty one is out of reach of an aggregation's field path.
              z
                .string()
                .regex(/^[A-Za-z_]\w*$/u)
                .max(UsageController.maxPropertyKeyLength),
              z.union([
                z.string().max(UsageController.maxPropertyStringLength),
                z.number(),
                z.boolean()
              ])
            )
            .refine(
              properties => Object.keys(properties).length <= UsageController.maxPropertiesPerEvent,
              { message: `Expected at most ${UsageController.maxPropertiesPerEvent} properties.` }
            ),
          at: z.iso.datetime({ offset: true }).transform(at => new Date(at))
        })
      )
      .min(1)
      .max(UsageController.maxEventsPerBatch)
  });

  @Inject(PrismaService)
  private readonly prisma!: PrismaService;

  /**
   * Creates the TTL index that expires usage events, which the Prisma schema cannot declare.
   * Runs at each boot, as each deploy's schema push drops it, and recreates an index left with
   * another expiry, which `createIndexes` refuses to change.
   * Here rather than in a shared service, as a CLI command may run with read-only access.
   */
  public async onApplicationBootstrap(): Promise<void> {
    try {
      await this.createTtlIndex();
    } catch (error) {
      // An index left with another expiry, as an image built with another retention leaves it for a
      // restart or a rollback, which push no schema.
      // The raw command's error carries MongoDB's error code in its message only.
      if (
        !isPrismaError(error) ||
        error.code != 'P2010' ||
        !error.message.includes('IndexOptionsConflict')
      ) {
        throw error;
      }

      // Not `collMod`, which needs the dbAdmin role that the app's readWrite user lacks.
      await this.prisma.$runCommandRaw({
        dropIndexes: 'usage_events',
        index: UsageController.ttlIndex.name
      });

      await this.createTtlIndex();
    }
  }

  /**
   * Stores a batch of the mod's client-side usage events, one {@link UsageEvent} per event, each
   * carrying the batch's envelope.
   * Awaits the insert before responding, so no work outlives the request.
   */
  @Post('events')
  @HttpCode(HttpStatus.NO_CONTENT)
  public async postEvents(
    @Req() req: FastifyRequest,
    @Body(new ZodParsePipe(UsageController.eventsBodySchema))
    body: z.infer<typeof UsageController.eventsBodySchema>
  ): Promise<void> {
    const creator = CreatorAuthenticationService.getAuthenticatedCreator(req);

    const receivedAt = new Date();

    await this.prisma.usageEvent.createMany({
      data: body.events.map(event => ({
        creatorId: creator.id,
        sessionId: body.sessionId,
        modVersion: body.modVersion,
        gameVersion: body.gameVersion,
        isDebug: body.debug,
        name: event.name,
        properties: event.properties,
        trackedAt: event.at,
        receivedAt
      }))
    });
  }

  private async createTtlIndex(): Promise<void> {
    await this.prisma.$runCommandRaw({
      createIndexes: 'usage_events',
      indexes: [UsageController.ttlIndex]
    });
  }
}
