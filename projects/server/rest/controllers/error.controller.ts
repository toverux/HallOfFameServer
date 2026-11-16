import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Inject,
  Post,
  Req,
  UseGuards
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { getSessionId } from '../../common/session-id';
import { CreatorAuthorizationGuard } from '../../guards';
import { ZodParsePipe } from '../../pipes';
import { CreatorAuthenticationService, ModErrorReportService } from '../../services';

@Controller('errors')
@UseGuards(CreatorAuthorizationGuard)
export class ErrorController {
  // The mod truncates each field to its bound before sending: change both together.
  private static readonly maxTypeLength = 256;

  private static readonly maxMessageLength = 4096;

  private static readonly maxStackLength = 16_384;

  private static readonly maxVersionLength = 32;

  private static readonly maxContextStringLength = 128;

  private static readonly maxLocaleLength = 16;

  private static readonly maxScreenSize = 32_768;

  private static readonly contextString = z
    .string()
    .min(1)
    .max(ErrorController.maxContextStringLength)
    .optional();

  /**
   * @see postError
   */
  private static readonly errorBodySchema = z.strictObject({
    source: z.enum(['log', 'escaped', 'ui']),
    severity: z.enum(['silent', 'recoverable', 'fatal']).optional(),
    type: z.string().min(1).max(ErrorController.maxTypeLength).optional(),
    message: z.string().max(ErrorController.maxMessageLength).optional(),
    stack: z.string().min(1).max(ErrorController.maxStackLength),
    // Each field the mod failed to read at startup is left out, but those the usage batch holds.
    context: z.strictObject({
      modVersion: z.string().min(1).max(ErrorController.maxVersionLength),
      gameVersion: z.string().min(1).max(ErrorController.maxVersionLength),
      debug: z.boolean(),
      platform: ErrorController.contextString,
      wine: z.boolean().optional(),
      screenWidth: z.int().min(1).max(ErrorController.maxScreenSize).optional(),
      screenHeight: z.int().min(1).max(ErrorController.maxScreenSize).optional(),
      gpuName: ErrorController.contextString,
      gpuVendor: ErrorController.contextString,
      gpuDriverVersion: ErrorController.contextString,
      locale: z.string().min(1).max(ErrorController.maxLocaleLength).optional()
    })
  });

  @Inject(ModErrorReportService)
  private readonly modErrorReport!: ModErrorReportService;

  /**
   * Passes an error report of the mod to its Sentry project, as the Creator's public ID and with
   * the usage session's ID when the request carries one.
   * The server stores no report.
   */
  @Post()
  @HttpCode(HttpStatus.NO_CONTENT)
  public async postError(
    @Req() req: FastifyRequest,
    @Body(new ZodParsePipe(ErrorController.errorBodySchema))
    body: z.infer<typeof ErrorController.errorBodySchema>
  ): Promise<void> {
    const creator = CreatorAuthenticationService.getAuthenticatedCreator(req);

    await this.modErrorReport.report(body, {
      creatorId: creator.id,
      sessionId: getSessionId(req)
    });
  }
}
