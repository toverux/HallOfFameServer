type UnwrapPromisesTuple<Tuple extends readonly unknown[]> = {
    -readonly [Key in keyof Tuple]: Awaited<Tuple[Key]>;
};

/**
 * It's `Promise.allSettled()`, but instead of returning an array of {@link PromiseSettledResult},
 * it checks for any rejected promises and throws the first one it finds, unless if
 * {@link aggregate} is `true`, in which case it throws an {@link AggregateError} containing all the
 * errors, with the error message being a concatenation of all the error messages.
 * If all promises are fulfilled, it returns an array of their values.
 */
export async function allFulfilled<const TPromises extends readonly Promise<unknown>[]>(
    promises: TPromises,
    aggregate = false
): Promise<UnwrapPromisesTuple<TPromises>> {
    const results = await Promise.allSettled(promises);

    const rejectedResults = results.filter(
        (result): result is PromiseRejectedResult => result.status == 'rejected'
    );

    if (rejectedResults[0] && rejectedResults.length == 1) {
        throw rejectedResults[0].reason;
    }

    if (rejectedResults[0]) {
        throw aggregate
            ? new AggregateError(
                  rejectedResults.map(result => result.reason),
                  rejectedResults.map(result => result.reason).join('\n')
              )
            : rejectedResults[0].reason;
    }

    return results.map(
        result => (result as PromiseFulfilledResult<unknown>).value
    ) as UnwrapPromisesTuple<TPromises>;
}
