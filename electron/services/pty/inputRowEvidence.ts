import { getEffectiveAgentConfig } from "../../../shared/config/agentRegistry.js";
import { stripAnsi } from "./AgentPatternDetector.js";
import { COMPOSER_FRAME_ROW, DEFAULT_PROMPT_PATTERNS } from "./PromptDetector.js";
import { buildPromptPatterns, compilePatterns } from "./terminalActivityPatterns.js";

/** What an agent's own input row looks like, from its registry entry. */
export interface InputRowShape {
  promptPatterns: readonly RegExp[];
  /** The agent's own prompt hints, never the universal approval hints merged in beside them. */
  hintPatterns: readonly RegExp[];
  /** Text its empty input row shows in place of a draft (`inputSuggestion.placeholderPatterns`). */
  placeholderPatterns: readonly RegExp[];
}

const UNDECLARED_SHAPE: InputRowShape = {
  promptPatterns: DEFAULT_PROMPT_PATTERNS,
  hintPatterns: [],
  placeholderPatterns: [],
};

/**
 * The agent's input row as its registry entry declares it. An agent that
 * declares no prompt is read by the bare glyphs any prompt opens with.
 */
export function inputRowShapeFor(agentId: string | undefined): InputRowShape {
  if (agentId === undefined) return UNDECLARED_SHAPE;
  const config = getEffectiveAgentConfig(agentId);
  const detection = config?.detection;
  const promptPatterns = buildPromptPatterns(detection, agentId);
  if (promptPatterns === undefined) return UNDECLARED_SHAPE;
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

interface PromptRow {
  /** The row from where its prompt starts. */
  fromPrompt: string;
  /** What follows the prompt, its box edge aside. */
  typed: string;
  boxed: boolean;
}

/**
 * The prompt that opens `row`, its box edges aside, or undefined when none
 * does. A pattern that draws the edge itself is matched on the row as drawn.
 */
function promptRow(row: string, patterns: readonly RegExp[]): PromptRow | undefined {
  const inner = row.replace(LEFT_BOX_EDGE, "");
  const boxed = inner !== row;
  for (const candidate of boxed ? [row, inner] : [row]) {
    for (const pattern of patterns) {
      const match = candidate.match(pattern);
      if (match?.index === undefined || match[0].trim() === "") continue;
      if (candidate.slice(0, match.index).trim() !== "") continue;
      return {
        fromPrompt: candidate.slice(match.index).replace(RIGHT_BOX_EDGE, "").trim(),
        typed: candidate
          .slice(match.index + match[0].length)
          .replace(RIGHT_BOX_EDGE, "")
          .trim(),
        boxed,
      };
    }
  }
  return undefined;
}

/** Nothing but blank space or box edges: what ends an input row's block. */
function isOpenRow(row: string | undefined): boolean {
  return (
    row === undefined || row.replace(/[│┃]/g, "").trim() === "" || COMPOSER_FRAME_ROW.test(row)
  );
}

/**
 * How plainly a settled screen shows the agent's own input row (#18018), the
 * evidence that a run has drawn its prompt: `"empty"` when the row holds
 * nothing typed, or only its placeholder (declared, or the agent's own hint
 * opening it), with nothing under it a draft could run on to; `"drawn"` when
 * it is there with something in it (a draft, a suggestion) between the
 * agent's rules, or with the agent's own hint on its boxed row or under it;
 * null when nothing on screen is the agent's. A CLI that has drawn nothing
 * yet leaves a blank screen, or the shell line that started it as the lowest
 * prompt-like row, the command typed after the glyph, so neither is evidence.
 * Only the lowest prompt-like row is read, so an empty one higher up, such as
 * a bare shell prompt in the history above that line, isn't either, and nor
 * is a frame with that line drawn under it.
 */
export function readInputRow(
  lines: readonly string[],
  shape: InputRowShape
): "empty" | "drawn" | null {
  const clean = lines.map((line) => stripAnsi(line));
  let end = clean.length;
  while (end > 0 && clean[end - 1]!.trim() === "") end--;
  if (end === 0) return null;

  const hintAt = (text: string) =>
    shape.hintPatterns.some((pattern) => text.match(pattern)?.index === 0);
  const holdsNothing = (prompt: PromptRow) =>
    prompt.typed === "" ||
    shape.placeholderPatterns.some((pattern) => pattern.test(prompt.typed)) ||
    hintAt(prompt.typed) ||
    hintAt(prompt.fromPrompt);

  // The agent's own rules above and below a single row: no shell line is framed.
  let framed: "empty" | "drawn" | null = null;
  let bottom = end - 1;
  while (bottom >= 0 && !COMPOSER_FRAME_ROW.test(clean[bottom]!)) bottom--;
  if (bottom >= 2 && COMPOSER_FRAME_ROW.test(clean[bottom - 2]!)) {
    const prompt = promptRow(clean[bottom - 1]!, shape.promptPatterns);
    if (prompt !== undefined) framed = holdsNothing(prompt) ? "empty" : "drawn";
  }

  for (let row = end - 1; row >= 0; row--) {
    if (framed !== null && row === bottom - 1) return framed;
    const prompt = promptRow(clean[row]!, shape.promptPatterns);
    if (prompt === undefined) continue;
    if (holdsNothing(prompt)) return isOpenRow(clean[row + 1]) ? "empty" : "drawn";
    // Its own hint on its boxed row, or in the chrome under it. A typed row
    // below a frame is the line that started the run, or a selector.
    const hinted =
      (prompt.boxed && shape.hintPatterns.some((pattern) => pattern.test(clean[row]!))) ||
      clean
        .slice(row + 1, end)
        .some((text) => shape.hintPatterns.some((pattern) => pattern.test(text)));
    return hinted ? "drawn" : null;
  }
  return framed;
}
