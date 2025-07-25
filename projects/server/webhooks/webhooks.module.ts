import { Module } from '@nestjs/common';
import { SharedModule } from '../shared.module';
import { controllers } from './controllers';

@Module({
  controllers,
  imports: [SharedModule]
})
export class WebhooksModule {}
