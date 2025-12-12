import type { Provider } from '@nestjs/common';
import { CreatorGraphQLService } from './creator.graphql.service';
import { ErrorGraphQLService } from './error.graphql.service';

export const schemaServices: Provider[] = [CreatorGraphQLService, ErrorGraphQLService];
