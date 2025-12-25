import { Controller, Get, Req, ServiceUnavailableException, UseGuards } from '@nestjs/common';
import Bun from 'bun';
import type { FastifyRequest } from 'fastify';
import type { JsonObject } from '../../../shared/utils/json';
import { SystemAuthorizationGuard } from '../../guards';

@Controller('system')
@UseGuards(SystemAuthorizationGuard)
export class SystemController {
  @Get('healthcheck')
  public async healthcheck(@Req() req: FastifyRequest): Promise<JsonObject> {
    const baseUrl = `${req.protocol}://${req.host}`;

    const formData = new FormData();

    formData.append('cityName', 'Healthcheck Self-Test');
    formData.append('cityMilestone', '20');
    formData.append('cityPopulation', '0');

    const screenshotPath = Bun.fileURLToPath(
      import.meta.resolve('../../../shared/assets/healthcheck-test-image.jpg')
    );

    formData.append('screenshot', Bun.file(screenshotPath), 'screenshot.jpg');

    const response = await fetch(`${baseUrl}/api/v1/screenshots?healthcheck=true`, {
      method: 'POST',
      headers: {
        authorization: `Creator name=Healthcheck&id=00000000-0000-4000-8000-000000000000&provider=local&hwid=localhost`
      },
      body: formData
    });

    if (response.status != 201) {
      throw new ServiceUnavailableException(
        `Upload request failed (${response.status} ${response.statusText}): ${await response.text()}`
      );
    }

    const responseData = await response.json();

    return {
      success: true,
      data: responseData
    };
  }
}
