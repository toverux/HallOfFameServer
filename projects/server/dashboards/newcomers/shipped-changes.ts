import type { ShippedChange } from '../dashboard';

/**
 * The changes judged on the Newcomers dashboard, in any order.
 * Add one once its deploy date is known.
 */
export const shippedChanges: readonly ShippedChange[] = [
  { date: '2026-10-15T16:48:05Z', label: 'newcomer protection' }
];
