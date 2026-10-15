/**
 * A change shipped to players, which splits the dashboard's series before and after it.
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
export const shippedChanges: readonly ShippedChange[] = [];
