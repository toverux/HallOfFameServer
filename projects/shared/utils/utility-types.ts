/** @public */
export type Maybe<T> = T | null | undefined;

/** @public */
export type MaybePromise<T> = T | PromiseLike<T>;

/** @public */
export type MaybeThunk<T> = T | (() => T);
