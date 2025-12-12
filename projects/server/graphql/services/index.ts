import type { Provider } from '@nestjs/common';
import { GraphQLContextService } from './graphql-context.service';

export * from './graphql-context.service';

export const services: Provider[] = [GraphQLContextService];
