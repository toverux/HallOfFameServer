declare const brand: unique symbol;

/**
 * @public
 * A branded-type factory, branded types are types that have the same as other common types but must
 * not be mixed, ex. assigning a creator name to an IP address field.
 * Branded types are a trick to make strong types without actually changing anything at runtime.
 * @see https://egghead.io/blog/using-branded-types-in-typescript
 */
export type Branded<Type, Brand> = Type & { [brand]: Brand };

/**
 * @public
 * A "Creator ID", the UUID v4 string that identifies and authorizes a creator.
 * It is *not* the database `Creator.id`.
 * It is the Paradox Account ID, although before that the mod used its own UUID.
 */
export type CreatorId = Branded<string, 'Creator ID'>;

/**
 * @public
 * A hardware ID, a unique identifier for a hardware device.
 */
export type HardwareId = Branded<string, 'Hardware ID'>;

/**
 * @public
 * An IP address, in IPv4 or IPv6 format.
 */
export type IpAddress = Branded<string, 'IP Address'>;

/**
 * @public
 * A Paradox mod ID, which is an auto-incremented integer.
 */
export type ParadoxModId = Branded<number, 'Paradox Mod ID'>;
