import { describe, expectTypeOf, test } from 'bun:test';
import type { CreatorId, HardwareId, IpAddress, ParadoxModId } from './branded-types';

// Type-level only: tsc checks these assertions, they do nothing at runtime.
describe('branded types', () => {
  test(`are usable where their base type is expected`, () => {
    expectTypeOf<CreatorId>().toExtend<string>();
    expectTypeOf<HardwareId>().toExtend<string>();
    expectTypeOf<IpAddress>().toExtend<string>();
    expectTypeOf<ParadoxModId>().toExtend<number>();
  });

  test(`do not accept a bare base value`, () => {
    expectTypeOf<string>().not.toExtend<CreatorId>();
    expectTypeOf<number>().not.toExtend<ParadoxModId>();
  });

  test(`do not mix with each other`, () => {
    expectTypeOf<HardwareId>().not.toExtend<IpAddress>();
    expectTypeOf<IpAddress>().not.toExtend<CreatorId>();
    expectTypeOf<CreatorId>().not.toExtend<HardwareId>();
  });
});
