/**
 * Workarounds for Prisma errors not being reliably instanceof-able.
 * https://github.com/prisma/prisma/issues/12128
 */

import { Prisma } from '@prisma/client';

export function isPrismaError(error: unknown): error is Prisma.PrismaClientKnownRequestError {
  return error != null && error.constructor.name == Prisma.PrismaClientKnownRequestError.name;
}

export function isPrismaValidationError(
  error: unknown
): error is Prisma.PrismaClientValidationError {
  return error != null && error.constructor.name == Prisma.PrismaClientValidationError.name;
}
