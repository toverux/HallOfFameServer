import type { Provider } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { PrismaService } from '../services/prisma.service';

/**
 * Compiles and initializes a testing module providing the given services and PrismaService, which
 * connects to the run's database.
 * List the service under test with the services it depends on, as nothing else is provided.
 * Close the module after each test to disconnect from the database.
 */
export async function createServiceTestingModule(
  providers: readonly Provider[]
): Promise<TestingModule> {
  const testingModule = await Test.createTestingModule({
    providers: [PrismaService, ...providers]
  }).compile();

  return testingModule.init();
}
