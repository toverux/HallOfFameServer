declare const brand: unique symbol;

/**
 * A branded-type factory, branded types are types that have the same as other
 * common types but must not be mixed, ex. assigning a creator name to an IP
 * address field. Branded types are a trick to make strong types without
 * actually changing anything at runtime.
 * @see https://egghead.io/blog/using-branded-types-in-typescript
 */
export type Branded<Type, Brand> = Type & { [brand]: Brand };

/**
 * A "Creator ID", the UUID v4 string that identifies and authorizes a creator.
 * It is *not* the database `Creator.id`.
 */
export type CreatorID = Branded<string, 'Creator ID'>;

/**
 * An IP address, in IPv4 or IPv6 format.
 */
export type IPAddress = Branded<string, 'IP Address'>;
