/**
 * Base application-layer error class.
 * "Standard errors" are user or operation errors that are known and can be
 * handled.
 *
 * They are also caught by the HTTP layer to throw a more appropriate HTTP error
 * response than the default for unknown errors, 500.
 */
export abstract class StandardError extends Error {
    /**
     * The kind of error, notably used to determine the HTTP status code.
     * Use override in derived classes to set the value.
     *
     *  - 400 for `user-error`,
     *  - 403 for `forbidden`.
     */
    public readonly kind: 'user-error' | 'forbidden' = 'user-error';
}
