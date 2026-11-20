import {
  inputSuggestionRuleFor,
  readInputBoxScreen,
} from "../../../shared/utils/terminalInputLine.js";
import { endsOnChoiceSelector } from "./WaitingReasonClassifier.js";

/**
 * Whether a screen read just before a guarded line's Enter shows a choice
 * selector (#17984), which would take the Enter as a pick. Read by structure
 * only, as the published reading is: a phrase can be the line's own text.
 *
 * When the agent's input box is found, only the rows under its bottom edge
 * are read: the line's own text in the box can be shaped like a numbered
 * list, and a selector drawn right under the box would share a block with its
 * edge, which reads as a composer. Anything above the box is behind it, as
 * the lowest highlighted row is the one that takes keys. With no box found,
 * the bottom of the screen is read, so a dialog drawn in the composer's place
 * is seen, and a layout the box rule doesn't know holds nothing by itself.
 */
export function showsSelectorAtEnter(serialized: string, agentId: string | undefined): boolean {
  const { rows, belowBox } = readInputBoxScreen(serialized, inputSuggestionRuleFor(agentId));
  // Down to the last row drawn: the reader narrows to the bottom of what it is
  // given, and a screen drawn only part way down would leave it blank rows.
  const from = belowBox ?? 0;
  let end = rows.length;
  while (end > from && rows[end - 1]!.trim() === "") end--;
  return end > from && endsOnChoiceSelector(rows.slice(from, end), undefined, agentId);
}
