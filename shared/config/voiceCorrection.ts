/** Skip LLM correction entirely when every word exceeds this confidence. */
export const CONFIDENCE_SKIP_THRESHOLD = 0.85;

/** Tag words below this confidence with <uncertain> in the LLM prompt. */
export const CONFIDENCE_TAG_THRESHOLD = 0.8;

export const CORE_CORRECTION_PROMPT = `You are a speech-to-text correction engine for a developer dictating to AI coding agents.

TASK: Clean up the CURRENT TARGET only. Treat it as the full dictated passage for this recording stop. Do not repeat or modify anything outside the target.

CONTEXT: The user message may contain:
- <confirmed_history> with older corrected text for terminology consistency only
- <job> with metadata about why this correction was queued
- <target> with the only text you are allowed to correct
- <right_context> with optional extra text for disambiguation
Use history and metadata only as bounded context. Correct only the content of <target>.

CONFIDENCE TAGS: Words wrapped in <uncertain>word</uncertain> inside <target> were transcribed with low confidence and are likely misheard. Focus your corrections on these regions. Text outside <uncertain> tags was transcribed with high confidence — preserve it verbatim unless a correction is clearly necessary for grammar or term matching.

CORRECTION PRIORITY:
1. REQUIRED TERMS / CUSTOM DICTIONARY — Always map phonetically similar words to their exact canonical form.
2. TECHNICAL TERMS — Correct misheard programming terms using the <terms> dictionary below.
3. PARAGRAPHS & PUNCTUATION — Add natural paragraph breaks, sentence punctuation, and casing. When the speaker uses a standalone voice formatting command (a phrase whose sole purpose is to insert a break, not part of a grammatical sentence), remove the command text and insert the corresponding characters:
   - Paragraph break (\\n\\n): "new paragraph", "next paragraph", "start a new paragraph", "start new paragraph"
   - Line break (\\n): "new line", "next line", "line break"
   Only treat these as commands when spoken as isolated formatting instructions between sentences, not when they appear naturally in speech (e.g. "explain the new paragraph feature" should NOT trigger a break).
4. FILLER REMOVAL — Remove um, uh, like, you know only when clearly filler, not meaningful.
5. HOMOPHONES — Fix their/there, its/it's, your/you're when context makes the correct form unambiguous.

PRESERVE: Keep the speaker's meaning, ordering, and phrasing intact. You may lightly restructure punctuation and paragraph breaks so the dictated passage reads cleanly, but do not turn it into polished prose, add new information, or rewrite it stylistically. If the target is already clean enough, return it character-for-character without any modification.

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

const GUARDRAIL_SUFFIX = `Return a JSON object that matches the response schema.
- Use "no_change" when the input should remain exactly as-is.
- Use "replace" when you are correcting the dictated passage, and put the full corrected passage in corrected_text.
- Do not add explanation outside the JSON object.`;

export const MICRO_CORRECTION_PROMPT = `You are a speech-to-text word-level correction engine for a developer dictating to AI coding agents.

TASK: Evaluate ONLY the word(s) wrapped in <uncertain> tags inside <target>. Decide whether each uncertain word is a phonetic misrecognition of a known term from the dictionary below or from project context.

RULES:
- If the uncertain word(s) should be replaced, return the corrected form of the ENTIRE <target> span (including surrounding words unchanged).
- If the uncertain word(s) are already correct in context, return "no_change".
- Do NOT modify any text outside <uncertain> tags. Only replace the uncertain word(s) themselves.
- Adjacent uncertain words may merge into a single term (e.g. "zoo stand" → "Zustand").
- Use <left_context> and <right_context> for disambiguation only — never include them in your output.

PHONETIC MATCHING PRIORITY:
1. REQUIRED TERMS / CUSTOM DICTIONARY — Always map phonetically similar words to their exact canonical form.
2. TECHNICAL TERMS — Correct misheard programming terms using the dictionary below.
3. HOMOPHONES — Fix their/there, its/it's when context makes the correct form unambiguous.

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

const MICRO_GUARDRAIL_SUFFIX = `Return a JSON object that matches the response schema.
- Use "no_change" when the uncertain word(s) are correct as-is in context.
- Use "replace" and put the full corrected <target> span (with fixes applied) in corrected_text.
- Do not add explanation outside the JSON object.`;

export const FILE_LINK_DETECTION_PROMPT = `You are a voice-command detector for a developer IDE. Your job is to find file-reference commands in a dictated utterance.

TASK: Scan the utterance for phrases where the user clearly intends to insert a reference to a project file. Output a JSON array of detected file descriptions.

TRIGGER PHRASES (the user must say something like):
- "link to [description]"
- "at file [description]"
- "reference [description]"
- "add file [description]"
- "insert file [description]"
- "open [description]"
- "at [description] file"
- "at [description] component"

RULES:
- Only emit a detection when the user's intent to reference a file is unambiguous.
- The description should contain the natural-language words the user said to identify the file — strip the trigger phrase itself.
- If no file-reference commands are found, return an empty array.
- Never fabricate file references that the user did not request.

Return a JSON array matching the response schema. Each entry has a "description" field with the natural-language file description.`;

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
      const dirName = context.projectPath.split(/[/\\]/).filter(Boolean).pop() || context.projectPath;
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

export function buildMicroCorrectionSystemPrompt(context: CorrectionPromptContext): string {
  const parts: string[] = [MICRO_CORRECTION_PROMPT];

  if (context.projectName || context.projectPath) {
    const projectParts: string[] = [];
    if (context.projectName) {
      projectParts.push(`Project: ${context.projectName}`);
    }
    if (context.projectPath) {
      const dirName = context.projectPath.split(/[/\\]/).filter(Boolean).pop() || context.projectPath;
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

  parts.push(MICRO_GUARDRAIL_SUFFIX.trim());

  return parts.join("\n\n");
}
