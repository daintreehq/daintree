/**
 * Core system prompt for voice transcription correction.
 *
 * Optimized for GPT-5 Nano with reasoning_effort "low":
 * - Uses "developer" message role (required for GPT-5 reasoning models)
 * - Short, directive instructions — no verbose examples
 * - Dictionary-mapping style for technical terms
 * - Prompt caching makes the system message cost negligible after first request
 *
 * This prompt is NOT user-editable. Users can append custom instructions
 * via the "Custom Instructions" field in settings.
 */
export const CORE_CORRECTION_PROMPT = `Fix speech-to-text transcription errors for a software developer using a coding IDE. The user is dictating instructions to AI coding agents.

RULES:
- Fix phonetically misheard technical terms to their correct form
- Add punctuation and fix sentence casing
- Remove filler words (um, uh, like, you know) only when clearly filler, not meaningful
- Fix homophones when context makes the error obvious (their/there, its/it's, your/you're)
- Use previous sentences for context — they establish the topic and help disambiguate corrections
- Start with a double line break ONLY when there is a clear topic change from previous sentences
- Use digits for technical values (port 8080, v3.2, 16 GB), spell out small numbers (three bugs)
- Preserve the speaker's wording, tone, contractions, and fragments — do NOT formalize or rephrase
- If already correct, return verbatim

COMMON TECHNICAL TERM CORRECTIONS:
racked/react -> React | type script -> TypeScript | next jess -> Next.js | get hub -> GitHub | cube netties -> Kubernetes | post gress -> Postgres | graph cue el -> GraphQL | engine ex -> Nginx | web pack -> Webpack | pie test -> pytest | see eye -> CI | node jess -> Node.js | vie test -> Vitest | tail wind -> Tailwind | zoo stand -> Zustand | prism a -> Prisma | rediss -> Redis | E S lint -> ESLint | docker compose -> Docker Compose`;

const GUARDRAIL_SUFFIX =
  "\n\nOutput ONLY the corrected text. No explanations, no markup, no quotes.";

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
 *   2. Project context (changes per project, not per sentence)
 *   3. Custom dictionary (highest priority corrections)
 *   4. Custom instructions (changes rarely)
 *   5. Guardrail suffix (fixed)
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
    parts.push(context.customInstructions.trim());
  }

  parts.push(GUARDRAIL_SUFFIX.trim());

  return parts.join("\n\n");
}
