/**
 * Identifiers no factory hands out, for what a test adds beside the seeded records: another
 * address, an unregistered Creator ID, an unknown screenshot.
 */

import type { CreatorId, HardwareId, IpAddress } from '../../shared/utils/branded-types';

// Documentation range (RFC 5737), never routable.
export const ip1 = '198.51.100.1' as IpAddress;
export const ip2 = '198.51.100.2' as IpAddress;
export const ip3 = '198.51.100.3' as IpAddress;
export const ip4 = '198.51.100.4' as IpAddress;

// Shaped like Unity's `SystemInfo.deviceUniqueIdentifier`, a SHA-1 hex digest.
export const hwid1 = 'f00dfeedf00dfeedf00dfeedf00dfeedf00dfeed' as HardwareId;
export const hwid2 = 'c0ffeec0ffeec0ffeec0ffeec0ffeec0ffeec0ff' as HardwareId;
export const hwid3 = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef' as HardwareId;
export const hwid4 = 'baddcafebaddcafebaddcafebaddcafebaddcafe' as HardwareId;

// UUIDs v4, as the mod requires.
export const unusedCreatorId = '00000000-0000-4000-8000-0000000000ff' as CreatorId;
export const otherUnusedCreatorId = '00000000-0000-4000-8000-0000000000fe' as CreatorId;

// A well-formed ObjectId.
export const unknownScreenshotId = '0123456789abcdef01234567';
