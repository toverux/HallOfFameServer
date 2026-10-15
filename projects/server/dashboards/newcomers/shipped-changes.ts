/**
 * A change shipped to players, which starts a new period in the dashboard's series.
 */
export interface ShippedChange {
  /**
   * When the change reached players, an ISO 8601 date or date-time in UTC.
   */
  readonly date: string;

  readonly label: string;
}

/**
 * The changes judged on the Newcomers dashboard, in any order.
 * Add one once its deploy date is known.
 */
export const shippedChanges: readonly ShippedChange[] = [
  { date: '2026-10-15T16:48:05Z', label: 'newcomer protection' }
];
