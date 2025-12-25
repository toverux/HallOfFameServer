/**
 * Workarounds for the fact that Prisma errors cannot be reliably tested with `instanceof`.
 * https://github.com/prisma/prisma/issues/12128
 */

import { Prisma } from '#prisma-lib/client';

/** @public */
export function isPrismaError(error: unknown): error is Prisma.PrismaClientKnownRequestError {
  return error != null && error.constructor.name == Prisma.PrismaClientKnownRequestError.name;
}

/** @public */
export function isPrismaValidationError(
  error: unknown
): error is Prisma.PrismaClientValidationError {
  return error != null && error.constructor.name == Prisma.PrismaClientValidationError.name;
}
