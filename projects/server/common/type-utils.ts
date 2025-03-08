import * as util from 'node:util';

export type Maybe<T> = T | null | undefined;

export function assertUnreachable(value: never): never {
  throw new Error(`Supposedly unreachable code was reached with value: ${util.inspect(value)}`);
}
