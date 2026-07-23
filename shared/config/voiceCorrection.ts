/** Skip LLM correction entirely when every word exceeds this confidence. */
export const CONFIDENCE_SKIP_THRESHOLD = 0.85;

/** Tag words below this confidence with <uncertain> in the LLM prompt. */
export const CONFIDENCE_TAG_THRESHOLD = 0.8;

/**
 * The single OpenAI model backing every voice-dictation AI call: whole-passage
 * correction, file-command detection, and ambiguous-file reranking. It replaces
 * the retired gpt-5-mini/gpt-5-nano tiers, so all three roles share one ID.
 * Migrations hard-code their own target literal and must not import this — the
 * active model can move again, but a past migration's target is immutable.
 */
export const VOICE_DICTATION_AI_MODEL = "gpt-5.6-luna" as const;

/**
 * Reasoning effort sent explicitly on every voice-dictation Responses request.
 * gpt-5.6-luna defaults to "medium" when the field is omitted — a latency/cost
 * regression for these fast, strict-JSON tasks — so we pin the lowest tier at
 * each call site rather than inheriting the model default. There is no minimum
 * reasoning effort for strict json_schema output.
 */
export const VOICE_DICTATION_REASONING_EFFORT = "none" as const;

const SHARED_TERMS_BLOCK = `<terms>
racked/react: React
type script: TypeScript
next jess/next yes: Next.js
nuxed/nucks/nuts: Nuxt
remixed/re mix: Remix
svelt/s felt: Svelte
solid jess: SolidJS
veet/veat: Vite
view jess/voo jay ess: Vue.js
story book: Storybook
tan stack: TanStack
get hub: GitHub
get lab: GitLab
cube netties/cube nettis: Kubernetes
cube cuttle/cube control: kubectl
docker compose: Docker Compose
terra form/tariff form: Terraform
post gress/post grey ess: Postgres
my sequel: MySQL
mongo dee bee: MongoDB
sequel/sea quel: SQL
rediss: Redis
graph cue el: GraphQL
g RPC/jeep are see: gRPC
o auth/oh auth: OAuth
jot/jay double you tee: JWT
rest a pi/rest API: REST API
web socket: WebSocket
web hook: webhook
engine ex: Nginx
web pack: Webpack
es build/e s build: esbuild
roll up: Rollup
pie test: pytest
vie test: Vitest
play right: Playwright
see eye/see eye see dee: CI/CD
node jess: Node.js
deno/dino: Deno
npm/m pm: npm
p n p m/pin pin: pnpm
tail wind: Tailwind
zoo stand: Zustand
prism a: Prisma
E S lint: ESLint
pretty err: Prettier
jason: JSON
yam el/yammel: YAML
a sync: async
a weight: await
rejects/red jacks: regex
bouillon/bool ee an: boolean
too pull/toople: tuple
e num: enum
no junk shun/null junction: NaN
I dem potent/item potent: idempotent
pie torch: PyTorch
anthro pick: Anthropic
see lie/c l i: CLI
s d k: SDK
a p i: API
you are el/u r l: URL
crud: CRUD
dot env/dot e n v: .env
mono repo: monorepo
feature flag: feature flag
web assembly/wasm: WebAssembly
type orm: TypeORM
super base: Supabase
verse el/voucell: Vercel
cloud flare: Cloudflare
dot net/dotnet: .NET
see sharp/c sharp: C#
go lang: Golang
rust lang: Rust
</terms>`;

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
1. REQUIRED TERMS / CUSTOM DICTIONARY — The transcriber is already biased toward these terms, so do not force them in. Map a word to its custom-dictionary canonical form only when the existing word does not fit the context and the audio plausibly matches that term. When both the transcribed word and a dictionary term are plausible, keep the transcribed wording.
2. TECHNICAL TERMS — Correct misheard programming terms using the <terms> dictionary below. Treat the left side of each <terms> entry as a known speech-to-text error pattern; when that phrase appears in developer context, replace it with the canonical right side even if the phrase was not wrapped in <uncertain> tags.
3. PARAGRAPHS & PUNCTUATION — Add natural paragraph breaks, sentence punctuation, and casing. When the speaker uses a standalone voice formatting command (a phrase whose sole purpose is to insert a break, not part of a grammatical sentence), remove the command text and insert the corresponding characters:
   - Paragraph break (\\n\\n): "new paragraph", "next paragraph", "start a new paragraph", "start new paragraph"
   - Line break (\\n): "new line", "next line", "line break"
   Only treat these as commands when spoken as isolated formatting instructions between sentences, not when they appear naturally in speech (e.g. "explain the new paragraph feature" should NOT trigger a break).
4. FILLER REMOVAL — Remove um, uh, like, you know only when clearly filler, not meaningful.
5. HOMOPHONES — Fix their/there, its/it's, your/you're when context makes the correct form unambiguous.

PRESERVE: Keep the speaker's meaning, ordering, and phrasing intact. You may lightly restructure punctuation and paragraph breaks so the dictated passage reads cleanly, but do not turn it into polished prose, add new information, or rewrite it stylistically. If the target is already clean enough, return it character-for-character without any modification.

EXAMPLES: These show the corrected text only — always return the JSON object described at the end of the message, never plain text.
- Target: "let's wire up the racked component with type script and post gress"
  Corrected: "Let's wire up the React component with TypeScript and Postgres."
- Target: "run the pie test suite new paragraph then push to get hub and watch the see eye"
  Corrected: "Run the pytest suite.\\n\\nThen push to GitHub and watch the CI."
- Target: "the <uncertain>a sync</uncertain> handler needs an <uncertain>a weight</uncertain> before we parse the jason"
  Corrected: "The async handler needs an await before we parse the JSON."
- Target: "deploy with cube cuttle and check the o auth flow um and the jot expiry"
  Corrected: "Deploy with kubectl and check the OAuth flow and the JWT expiry."

${SHARED_TERMS_BLOCK}`;

const GUARDRAIL_SUFFIX = `Return a JSON object that matches the response schema.
- Use "no_change" when the input should remain exactly as-is.
- Use "replace" when you are correcting the dictated passage, and put the full corrected passage in corrected_text.
- Do not add explanation outside the JSON object.`;

export const FILE_LINK_DETECTION_PROMPT = `You are a voice-command detector for a developer IDE. Your job is to find file-reference commands in a dictated utterance.

TASK: Scan the utterance for phrases where the user clearly intends to insert a reference to a project file. Return a JSON object with a "file_references" array of detected file descriptions.

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
- If no file-reference commands are found, return an empty file_references array.
- Never fabricate file references that the user did not request.

Return a JSON object matching the response schema. The file_references array contains entries with a "description" field holding the natural-language file description.`;

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
      const dirName =
        context.projectPath.split(/[/\\]/).filter(Boolean).pop() || context.projectPath;
      if (dirName !== context.projectName) {
        projectParts.push(`Repository: ${dirName}`);
      }
    }
    parts.push(
      `CURRENT PROJECT:\n${projectParts.join(", ")}\nPrefer these forms when a word plausibly matches the project name or related terms, but keep the transcribed wording when it already fits the context.`
    );
  }

  if (context.customDictionary && context.customDictionary.length > 0) {
    parts.push(
      `PREFERRED TERMS (prefer these exact forms when the audio plausibly matches, but do not force them over a transcribed word that already fits the context):\n${context.customDictionary.map((term) => `"${term}"`).join(" | ")}`
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
