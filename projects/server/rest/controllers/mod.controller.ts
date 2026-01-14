import {
  BadRequestException,
  Controller,
  Get,
  HttpStatus,
  Inject,
  Param,
  Res
} from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import type { ParadoxModId } from '../../../shared/utils/branded-types';
import { NotFoundByIdError } from '../../common/standard-error';
import { PrismaService } from '../../services';

@Controller('mods')
export class ModController {
  @Inject(PrismaService)
  private readonly prisma!: PrismaService;

  /**
   * Redirects to the Paradox mod page for the specified mod.
   */
  @Get(':paradoxModId')
  public async redirectToModPage(
    @Res() res: FastifyReply,
    @Param('paradoxModId') paradoxModIdStr: string
  ): Promise<void> {
    const paradoxModId = Number.parseInt(paradoxModIdStr, 10) as ParadoxModId;

    if (Number.isNaN(paradoxModId)) {
      throw new BadRequestException(`Mod ID "${paradoxModIdStr}" is not valid, expected an int.`);
    }

    const mod = await this.prisma.mod.findUnique({ where: { paradoxModId } });

    if (!mod) {
      throw new NotFoundByIdError(String(paradoxModId));
    }

    res.redirect(
      // Specifying the platform (Windows) is mandatory, and Windows is the one platform where we're
      // sure to hit because everything is available to Windows.
      // The "Any" platform only concerns portable assets that can be used everywhere.
      `https://mods.paradoxplaza.com/mods/${paradoxModId}/Windows`,
      HttpStatus.TEMPORARY_REDIRECT
    );

    // Increment click count for this mod.
    await this.prisma.mod.update({
      where: { paradoxModId },
      data: { clicks: { increment: 1 } }
    });
  }
}
