import { Module } from '@nestjs/common';
import { controllers } from './controllers';

@Module({ controllers })
export class RestModule {}
