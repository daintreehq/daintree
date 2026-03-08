/**
 * Voice correction prompt for gpt-5-nano (reasoning model, reasoning_effort: "low").
 *
 * Design choices informed by OpenAI reasoning model prompting guidance (2025):
 *
 * - XML-style delimiters (<terms>) bound the technical dictionary so the reasoning
 *   model parses it as structured data rather than prose.
 * - Colon-separated entries ("racked/react: React") are preferred over arrow syntax
 *   ("->") which reasoning models can misinterpret as logical operators.
 * - "Text segment" replaces "sentence" so the prompt is compatible with both
 *   single-sentence and paragraph-level inputs (see #2672).
 * - Explicit idempotency ("return it character-for-character") prevents over-correction
 *   on already-correct input — a common failure mode in reasoning models.
 * - The guardrail uses positive-then-negative framing and requires the response to begin
 *   immediately with the corrected text. A single trailing "Output ONLY" instruction is
 *   vulnerable to instruction drift during internal reasoning; this structure is more robust.
 * - Custom instructions are labelled as lower-priority context so they cannot accidentally
 *   override the core correction rules or the output format contract.
 * - Uses the "developer" message role (required for GPT-5 reasoning models).
 *
 * This prompt is NOT user-editable. Users can append context via Custom Instructions
 * in Settings, which is appended in a clearly-labelled lower-priority section.
 */
export const CORE_CORRECTION_PROMPT = `You are a speech-to-text correction engine for a developer dictating to AI coding agents.

TASK: Fix transcription errors in the CURRENT TEXT SEGMENT only. Do not repeat, summarize, or modify previous segments.

CONTEXT: The user message contains two XML sections: <history> (previous corrected segments — reference only) and <input> (the current segment to correct). Use <history> only to maintain consistent terminology — if earlier segments mention "React", a later "racked" likely means "React". Correct only the content of <input>. Do NOT repeat or modify previous segments.

CORRECTION PRIORITY:
1. REQUIRED TERMS / CUSTOM DICTIONARY — Always map phonetically similar words to their exact canonical form.
2. TECHNICAL TERMS — Correct misheard programming terms using the <terms> dictionary below.
3. PUNCTUATION & CASING — Add terminal punctuation, fix sentence casing.
4. FILLER REMOVAL — Remove um, uh, like, you know only when clearly filler, not meaningful.
5. HOMOPHONES — Fix their/there, its/it's, your/you're when context makes the correct form unambiguous.

PRESERVE: Do not rephrase, formalize, or reword. Keep contractions, fragments, and the speaker's phrasing intact. If the text segment contains no errors, return it character-for-character without any modification.

<terms>
racked/react: React
type script: TypeScript
next jess: Next.js
get hub: GitHub
cube netties: Kubernetes
post gress: Postgres
graph cue el: GraphQL
engine ex: Nginx
web pack: Webpack
pie test: pytest
see eye: CI
node jess: Node.js
vie test: Vitest
tail wind: Tailwind
zoo stand: Zustand
prism a: Prisma
rediss: Redis
E S lint: ESLint
docker compose: Docker Compose
</terms>`;

const GUARDRAIL_SUFFIX =
  "\n\nOutput the corrected text as plain text only. Begin immediately with the first corrected word — no preamble, no quotes, no markdown, no explanations.";

export interface CorrectionPromptContext {
  projectName?: string;
  projectPath?: string;
  customDictionary?: string[];
  customInstructions?: string;
}

/**
 * Builds the full developer message for the correction API call.
 *
 * Structure (for optimal prompt caching):
 *   1. Core prompt (fixed — cached after first request)
 *   2. Project context (changes per project, not per segment)
 *   3. Custom dictionary (highest priority corrections)
 *   4. Custom instructions (lower-priority user context)
 *   5. Guardrail suffix (fixed — always last, cannot be overridden)
 *
 * Uses "developer" role for GPT-5 reasoning models.
 * Only the user message (history + raw text) changes per request.
 */
export function buildCorrectionSystemPrompt(context: CorrectionPromptContext): string {
  const parts: string[] = [CORE_CORRECTION_PROMPT];

  if (context.projectName || context.projectPath) {
    const projectParts: string[] = [];
    if (context.projectName) {
      projectParts.push(`Project: ${context.projectName}`);
    }
    if (context.projectPath) {
      const dirName = context.projectPath.split("/").pop() || context.projectPath;
      if (dirName !== context.projectName) {
        projectParts.push(`Repository: ${dirName}`);
      }
    }
    parts.push(
      `CURRENT PROJECT:\n${projectParts.join(", ")}\nCorrect any word that sounds like the project name or related terms to their proper form.`
    );
  }

  if (context.customDictionary && context.customDictionary.length > 0) {
    parts.push(
      `REQUIRED TERMS (correct phonetic matches to these exact forms):\n${context.customDictionary.map((term) => `"${term}"`).join(" | ")}`
    );
  }

  if (context.customInstructions?.trim()) {
    parts.push(
      `CUSTOM CONTEXT (lower priority than correction rules above):\n${context.customInstructions.trim()}`
    );
  }

  parts.push(GUARDRAIL_SUFFIX.trim());

  return parts.join("\n\n");
}
