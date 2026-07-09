export type Maybe<T> = T | null | undefined;

export type MaybePromise<T> = T | PromiseLike<T>;

export type MaybeThunk<T> = T | (() => T);
