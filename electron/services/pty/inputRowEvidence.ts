import { getEffectiveAgentConfig } from "../../../shared/config/agentRegistry.js";
import { stripAnsi } from "./AgentPatternDetector.js";
import { COMPOSER_FRAME_ROW } from "./PromptDetector.js";
import { buildPromptPatterns, compilePatterns } from "./terminalActivityPatterns.js";

/** What an agent's own input row looks like, from its registry entry. */
export interface InputRowShape {
  promptPatterns: readonly RegExp[];
  /** The agent's own prompt hints, never the universal approval hints merged in beside them. */
  hintPatterns: readonly RegExp[];
  /** Text its empty input row shows in place of a draft (`inputSuggestion.placeholderPatterns`). */
  placeholderPatterns: readonly RegExp[];
}

/**
 * The agent's input row as its registry entry declares it, or null for an
 * agent that declares no prompt, whose input row can't be told from anything
 * else it draws.
 */
export function inputRowShapeFor(agentId: string | undefined): InputRowShape | null {
  if (agentId === undefined) return null;
  const config = getEffectiveAgentConfig(agentId);
  const detection = config?.detection;
  const promptPatterns = buildPromptPatterns(detection, agentId);
  if (promptPatterns === undefined) return null;
  return {
    promptPatterns,
    hintPatterns: compilePatterns(detection?.promptHintPatterns ?? [], agentId, "prompt hint"),
    placeholderPatterns: compilePatterns(
      config?.inputSuggestion?.placeholderPatterns ?? [],
      agentId,
      "input placeholder"
    ),
  };
}

const LEFT_BOX_EDGE = /^\s*[│┃]/;
const RIGHT_BOX_EDGE = /[│┃]\s*$/;

/**
 * The text after a prompt that opens `row`, its box edges aside, or undefined
 * when no prompt opens it. A pattern that draws the edge itself is matched on
 * the row as drawn.
 */
function textAfterPrompt(row: string, patterns: readonly RegExp[]): string | undefined {
  const inner = row.replace(LEFT_BOX_EDGE, "");
  for (const candidate of inner === row ? [row] : [row, inner]) {
    for (const pattern of patterns) {
      const match = candidate.match(pattern);
      if (match?.index === undefined || match[0].trim() === "") continue;
      if (candidate.slice(0, match.index).trim() !== "") continue;
      return candidate
        .slice(match.index + match[0].length)
        .replace(RIGHT_BOX_EDGE, "")
        .trim();
    }
  }
  return undefined;
}

/**
 * How plainly a settled screen shows the agent's own input row (#18018), the
 * evidence that a run has drawn its prompt: `"empty"` when the row holds
 * nothing typed, or only its placeholder; `"drawn"` when it is there with
 * something in it (a draft, a suggestion) or behind the agent's own prompt
 * hint; null when nothing on screen is the agent's. A CLI that has drawn
 * nothing yet leaves a blank screen, or the shell line that started it as the
 * lowest prompt-like row, with the command typed after the glyph and nothing
 * drawn under it, so neither is evidence. Only the lowest prompt-like row is
 * read, so an empty one higher up, such as a bare shell prompt in the history
 * above that line, isn't either. An agent with no declared prompt (`shape`
 * null) has only "something is drawn" to go on.
 */
export function readInputRow(
  lines: readonly string[],
  shape: InputRowShape | null
): "empty" | "drawn" | null {
  const clean = lines.map((line) => stripAnsi(line));
  let end = clean.length;
  while (end > 0 && clean[end - 1]!.trim() === "") end--;
  if (end === 0) return null;
  if (shape === null) return "drawn";

  const isEmpty = (typed: string) =>
    typed === "" || shape.placeholderPatterns.some((pattern) => pattern.test(typed));

  // The agent's own rules above and below a single row: no shell line is framed.
  let framed: "empty" | "drawn" | null = null;
  let bottom = end - 1;
  while (bottom >= 0 && !COMPOSER_FRAME_ROW.test(clean[bottom]!)) bottom--;
  if (bottom >= 2 && COMPOSER_FRAME_ROW.test(clean[bottom - 2]!)) {
    const typed = textAfterPrompt(clean[bottom - 1]!, shape.promptPatterns);
    if (typed !== undefined) framed = isEmpty(typed) ? "empty" : "drawn";
  }
  if (framed === "empty") return framed;

  for (let row = end - 1; row >= 0; row--) {
    const typed = textAfterPrompt(clean[row]!, shape.promptPatterns);
    if (typed === undefined) continue;
    if (isEmpty(typed)) return "empty";
    // A hint the CLI draws on its input row or under it, with more of its
    // chrome below: the line that started the run has nothing under it.
    const hinted =
      row < end - 1 &&
      clean
        .slice(row, end)
        .some((text) => shape.hintPatterns.some((pattern) => pattern.test(text)));
    return hinted ? "drawn" : framed;
  }
  return framed;
}
