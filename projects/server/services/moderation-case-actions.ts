import type { ModerationCase, ModerationCaseKind, ModerationCaseOutcome } from '#prisma-lib/client';
import type { JsonObject } from '../../shared/utils/json';

/**
 * Discord's component types this module uses.
 */
const componentType = { actionRow: 1, button: 2 } as const;

/**
 * Discord's button styles this module uses.
 */
const buttonStyle = { success: 3, danger: 4 } as const;

/**
 * The moderator's actions on a case, each for one kind of case and settling it with one outcome,
 * with the button that runs it from the case's message.
 */
export const moderationCaseActions = {
  approve: { kind: 'report', outcome: 'approved', label: `Approve`, style: buttonStyle.success },
  delete: { kind: 'report', outcome: 'deleted', label: `Delete`, style: buttonStyle.danger },
  ban: {
    kind: 'report',
    outcome: 'banned',
    label: `Ban creator and delete`,
    style: buttonStyle.danger
  },
  accept: {
    kind: 'showcased_mod',
    outcome: 'accepted',
    label: `Accept`,
    style: buttonStyle.success
  },
  remove: { kind: 'showcased_mod', outcome: 'removed', label: `Remove`, style: buttonStyle.danger },
  // In this order, so A sits on the left as the older screenshot, and B on the right.
  keepA: { kind: 'near_duplicate', outcome: 'kept_a', label: `Keep A`, style: buttonStyle.danger },
  allow: {
    kind: 'near_duplicate',
    outcome: 'allowed',
    label: `Allow both`,
    style: buttonStyle.success
  },
  keepB: { kind: 'near_duplicate', outcome: 'kept_b', label: `Keep B`, style: buttonStyle.danger }
} as const satisfies Record<
  string,
  { kind: ModerationCaseKind; outcome: ModerationCaseOutcome; label: string; style: number }
>;

export type ModerationCaseAction = keyof typeof moderationCaseActions;

/**
 * A click on a case's button, as its `custom_id` carries it.
 */
export interface ModerationCaseButton {
  readonly action: ModerationCaseAction;
  readonly caseId: ModerationCase['id'];
}

/**
 * The Discord action rows of a case's message: one with a button per action of the case's kind, or
 * none for a kind without actions.
 */
export function moderationCaseButtons(
  moderationCase: Pick<ModerationCase, 'id' | 'kind'>
): JsonObject[] {
  const buttons = Object.entries(moderationCaseActions)
    .filter(([, { kind }]) => kind == moderationCase.kind)
    .map(([action, { label, style }]) => ({
      type: componentType.button,
      style,
      label,
      custom_id: `${action}:${moderationCase.id}`
    }));

  return buttons.length ? [{ type: componentType.actionRow, components: buttons }] : [];
}

/**
 * Reads a button's `custom_id`, as {@link moderationCaseButtons} writes it.
 *
 * @returns `undefined` for an ID it did not write.
 */
export function parseModerationCaseButton(customId: string): ModerationCaseButton | undefined {
  const [action, caseId, ...rest] = customId.split(':');

  if (
    !isModerationCaseAction(action) ||
    // A malformed ObjectId fails the query that reads the case.
    !caseId ||
    !/^[\da-f]{24}$/u.test(caseId) ||
    rest.length
  ) {
    return undefined;
  }

  return { action, caseId };
}

function isModerationCaseAction(value: string | undefined): value is ModerationCaseAction {
  return value != null && Object.hasOwn(moderationCaseActions, value);
}
