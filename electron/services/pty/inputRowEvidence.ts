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
  /** The agent declares its prompt; otherwise only the bare glyphs any prompt opens with are known. */
  declared: boolean;
}

const UNDECLARED_SHAPE: InputRowShape = {
  promptPatterns: DEFAULT_PROMPT_PATTERNS,
  hintPatterns: [],
  placeholderPatterns: [],
  declared: false,
};

/** The agent's input row as its registry entry declares it. */
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
    declared: true,
  };
}

const LEFT_BOX_EDGE = /^\s*[│┃]/;
const RIGHT_BOX_EDGE = /[│┃]\s*$/;
/** A shell prompt's glyph with a command typed after it, wherever on the row the prompt ends. */
const SHELL_LINE = /(?:^|\s)[$%#❯›>]\s+\S/;

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

/** Nothing but blank space or box edges. */
function isBlankRow(row: string | undefined): boolean {
  return row === undefined || row.replace(/[│┃]/g, "").trim() === "";
}

/**
 * How plainly a settled screen shows the agent's own input row (#18018), the
 * evidence that a run has drawn its prompt: `"empty"` when the row holds
 * nothing typed, or only its placeholder (declared, or the agent's own hint
 * taking up the whole row), with nothing under it a draft could run on to;
 * `"drawn"` when it is there with something in it (a draft, a suggestion)
 * between the agent's rules, or with the agent's own hint on its boxed row or
 * in the chrome under it; null when nothing on screen is the agent's. A CLI
 * that has drawn nothing yet leaves a blank screen, or the shell line that
 * started it under everything else, so neither is evidence, and nothing above
 * that line is read: a bare shell prompt in the history, or a frame the last
 * agent left. An agent that declares no prompt is taken at anything else it
 * draws, as a prompt it can't be read for.
 */
export function readInputRow(
  lines: readonly string[],
  shape: InputRowShape
): "empty" | "drawn" | null {
  const clean = lines.map((line) => stripAnsi(line));
  let end = clean.length;
  while (end > 0 && clean[end - 1]!.trim() === "") end--;
  if (end === 0) return null;

  const isWholeHint = (text: string) =>
    text !== "" &&
    shape.hintPatterns.some((pattern) => {
      const match = text.match(pattern);
      return match?.index === 0 && match[0].length === text.length;
    });
  const holdsNothing = (prompt: PromptRow) =>
    prompt.typed === "" ||
    shape.placeholderPatterns.some((pattern) => pattern.test(prompt.typed)) ||
    isWholeHint(prompt.typed) ||
    isWholeHint(prompt.fromPrompt);
  const hasHint = (text: string) => shape.hintPatterns.some((pattern) => pattern.test(text));

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
    const text = clean[row]!;
    const prompt = promptRow(text, shape.promptPatterns);
    if (prompt === undefined) {
      if (SHELL_LINE.test(text.replace(LEFT_BOX_EDGE, ""))) return null;
      continue;
    }
    if (holdsNothing(prompt)) {
      const below = clean[row + 1];
      return isBlankRow(below) || COMPOSER_FRAME_ROW.test(below!) ? "empty" : "drawn";
    }
    if (!shape.declared) return null;
    // Its own hint on its boxed row, or in its chrome past a blank row under
    // it: a launch line that wraps runs straight on.
    let chrome = row + 1;
    while (chrome < end && !isBlankRow(clean[chrome])) chrome++;
    const hinted =
      (prompt.boxed && hasHint(text)) || clean.slice(chrome, end).some((under) => hasHint(under));
    return hinted ? "drawn" : null;
  }
  return framed ?? (shape.declared ? null : "drawn");
}
