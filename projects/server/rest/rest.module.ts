import { Module } from '@nestjs/common';
import { controllers } from './controllers';

/** @public */
@Module({ controllers })
export class RestModule {}
