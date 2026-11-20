import {
  inputSuggestionRuleFor,
  readInputBoxScreen,
} from "../../../shared/utils/terminalInputLine.js";
import {
  endsOnChoiceSelector,
  WAITING_REASON_CHECKLIST_ROWS,
  WAITING_REASON_SCAN_LINE_COUNT,
} from "./WaitingReasonClassifier.js";

const WINDOW_ROWS = WAITING_REASON_SCAN_LINE_COUNT + WAITING_REASON_CHECKLIST_ROWS;

/**
 * Whether a screen read just before a guarded line's Enter shows a choice
 * selector (#17984), which would take the Enter as a pick. Read by structure
 * only, as the published reading is: a phrase can be the line's own text.
 *
 * The bottom of the screen is read, and when the agent's input box is found,
 * the rows under its bottom edge on their own: a selector drawn right under
 * the box shares a block with the box's rule, which a whole-screen read takes
 * for the composer. A box that can't be found holds nothing by itself, so an
 * agent layout the box rule doesn't know still takes its lines.
 */
export function showsSelectorAtEnter(serialized: string, agentId: string | undefined): boolean {
  const { rows, belowBox } = readInputBoxScreen(serialized, inputSuggestionRuleFor(agentId));
  const selectorIn = (from: number) =>
    endsOnChoiceSelector(rows.slice(from).slice(-WINDOW_ROWS), undefined, agentId);
  return selectorIn(0) || (belowBox !== null && belowBox < rows.length && selectorIn(belowBox));
}
