import { DICTATED_PROMPTS } from "../../../electron/services/__tests__/fixtures/dictatedPrompts";
import { REPLAY_CLIPS } from "../../../e2e/helpers/voiceReplayFixtures";
import type { CorrectionWorktreeContext } from "../../../shared/config/voiceCorrection";

/**
 * The dictated agent prompts the cleanup benchmark (`npm run perf voice-cleanup`)
 * runs every model over. No provider transcripts of the replay clips have been
 * saved yet, so each raw transcript is written in the error style of the
 * provider it imitates:
 *
 * - OpenAI (`gpt-live-transcribe`): cased and punctuated, keeps "um", "uh" and
 *   "you know", spells dictated symbols out ("slash", "dash dash"), and gets
 *   rare names and context-bound words wrong in fluent-looking ways ("Tara",
 *   "we'd" for "would"). It flags no unsure words.
 * - Deepgram (Nova-3, `punctuate` + `smart_format`, no `filler_words`): fillers
 *   gone, numbers as digits, project words split phonetically ("x term",
 *   "zoo stand", "p t y"), and the words it was unsure of flagged, which
 *   cleanup sees as `<uncertain>` spans.
 *
 * Grok joins once #14769 lands. The cleanup regression prompts
 * (`dictatedPrompts.ts`) come in as they are, in no provider's style.
 */

export type TranscriptStyle = "openai" | "deepgram" | "generic";

export type CaseSource =
  "replay" | "afternoon" | "context" | "workspace" | "ramble" | "clean" | "regression";

/**
 * What a dictation's session tells cleanup about where it is typed (#14854):
 * the same for every passage of the session, so it rides in the cached prompt.
 */
export interface CleanupSession {
  /** As `screenCorrectionRepositoryNames` sends them. */
  repositoryNames?: string[];
  worktree?: CorrectionWorktreeContext;
}

/**
 * What a fix does for the agent reading the passage. A `misread` replaces a
 * different word the raw transcript has in its place, one an agent would take
 * for something else ("codecs" for Codex, "cash" for cache, "on beta" for
 * about): the letters differ even with case, spacing, punctuation and spoken
 * symbols, letters and numbers set aside. A `form` only writes the speaker's
 * own words another way ("work tree", "use shallow", "dash dash watch",
 * "N P M", a spoken list), which an agent reads right either way.
 */
export type FixKind = "misread" | "form";

export const FIX_KINDS: readonly FixKind[] = ["misread", "form"];

export interface CleanupCase {
  id: string;
  style: TranscriptStyle;
  source: CaseSource;
  /** What the recogniser produced: the text cleanup receives. */
  raw: string;
  /** The message the speaker meant, as they would have typed it to an agent. */
  reference: string;
  /** Other cleanups that are just as right. */
  alsoAccept?: readonly string[];
  /** Written forms the raw transcript got wrong that cleanup should land, matched case-sensitively, each classed by what it does for an agent. */
  fixes: Readonly<Record<string, FixKind>>;
  /** Words and phrases cleanup should take out (filler, stutters, a retracted phrase), matched as whole words, ignoring case. */
  drops?: string[];
  /** Spans the raw transcript already has right that must come through character for character. */
  keep?: string[];
  /** Words the recogniser was unsure of, located in `raw` in order. Deepgram only. */
  uncertain?: string[];
  recentContext?: string[];
  terminalOutput?: string;
  /** Nothing comes before the passage in the draft; true unless `recentContext` says otherwise. */
  startsPrompt?: boolean;
  /** Absent for a passage dictated with no worktree or repository names, as before #14854. */
  session?: CleanupSession;
}

interface Transcript {
  raw: string;
  /** Where cleanup's ideal for this transcript differs from the clip's: digits it must keep, say. */
  reference?: string;
  fixes: CleanupCase["fixes"];
  keep?: string[];
  uncertain?: string[];
}

interface ReplayTranscripts {
  openai: Transcript;
  deepgram: Transcript;
  /** Where cleanup's ideal differs from the clip's written reference. */
  reference?: string;
}

/** A raw transcript in each provider's style for every replay clip, keyed by clip id. */
export const REPLAY_TRANSCRIPTS: Readonly<Record<string, ReplayTranscripts>> = {
  "zustand-selector": {
    openai: {
      raw: "Zustand selector in the worktree store is returning a new array on every render. Wrap it in use shallow.",
      fixes: { useShallow: "form" },
      keep: ["Zustand"],
    },
    deepgram: {
      raw: "Zoo stand selector in the work tree store is returning a new array on every render. Wrap it in use shallow.",
      fixes: { Zustand: "misread", worktree: "form", useShallow: "form" },
      uncertain: ["Zoo stand", "shallow"],
    },
  },
  "npm-test-watch": {
    openai: {
      raw: "Run NPM test dash dash watch on the voice recording service test file.",
      fixes: { "--watch": "form" },
    },
    deepgram: {
      raw: "Run N P M test dash dash watch on the voice recording service test file.",
      fixes: { "npm test": "form", "--watch": "form" },
    },
  },
  "commit-and-push": {
    openai: { raw: "Commit and push.", fixes: {} },
    deepgram: { raw: "Commit and push.", fixes: {} },
  },
  "path-after-pause": {
    openai: {
      raw: "Open electron slash services slash voice. Then find where the web socket reconnects.",
      fixes: { "electron/services/voice": "form", WebSocket: "form" },
    },
    deepgram: {
      raw: "Open Electron slash services slash voice. Then find where the websocket reconnects.",
      fixes: { "electron/services/voice": "form", WebSocket: "form" },
    },
  },
  "long-continuous": {
    openai: {
      raw: "I want you to go through the OpenAI transcription provider and trace every path where audio arrives before the session is ready, then write a VTest test that sends three chunks during the handshake and proves every byte reaches the socket in order after the session dot updated event arrives.",
      fixes: { Vitest: "misread", "session.updated": "form" },
      keep: ["three chunks"],
    },
    deepgram: {
      raw: "I want you to go through the open AI transcription provider and trace every path where audio arrives before the session is ready. Then write a v test test that sends 3 chunks during the handshake and proves every byte reaches the socket in order after the session dot updated event arrives.",
      reference:
        "I want you to go through the OpenAITranscriptionProvider and trace every path where audio arrives before the session is ready, then write a Vitest test that sends 3 chunks during the handshake and proves every byte reaches the socket in order after the session.updated event arrives.",
      fixes: { OpenAI: "form", Vitest: "misread", "session.updated": "form" },
      keep: ["3 chunks"],
      uncertain: ["v test"],
    },
  },
  "long-then-pause": {
    openai: {
      raw: "The project view manager evicts the least recently used view when memory is tight, but the renderer for that view keeps its xterm instances alive because nothing calls dispose on them when the web contents goes away. Find the leak and fix it.",
      fixes: {},
      keep: ["xterm"],
    },
    deepgram: {
      raw: "The project view manager evicts the least recently used view when memory is tight, but the renderer for that view keeps its x term instances alive because nothing calls dispose on them when the web contents goes away. Find the leak and fix it.",
      fixes: { xterm: "form" },
      uncertain: ["x term"],
    },
  },
  "rebase-develop": {
    openai: {
      raw: "Rebase this branch onto origin slash develop and resolve the conflict in package.json.",
      fixes: { "origin/develop": "form" },
      keep: ["package.json"],
    },
    deepgram: {
      raw: "Rebase this branch onto origin slash develop and resolve the conflict in package dot JSON.",
      fixes: { "origin/develop": "form", "package.json": "form" },
    },
  },
  "tailwind-token": {
    openai: {
      raw: "Swap the hard-coded hex colour for the text secondary token from Tailwind and check it in dark mode.",
      fixes: { "text-secondary": "form" },
      keep: ["Tailwind"],
    },
    deepgram: {
      raw: "Swap the hard coded hex colour for the text secondary token from tailwind and check it in dark mode.",
      fixes: { "text-secondary": "form", Tailwind: "form" },
    },
  },
  "typescript-error": {
    openai: {
      raw: "Fix the TypeScript error TS2345 in shared slash types slash IPC slash API dot TS.",
      fixes: { "shared/types/ipc/api.ts": "form" },
      keep: ["TS2345"],
    },
    deepgram: {
      raw: "Fix the TypeScript error TS 2345 in shared slash types slash IPC slash API dot TS.",
      fixes: { TS2345: "form", "shared/types/ipc/api.ts": "form" },
    },
  },
  "three-steps": {
    // The prompt lays a counted-out passage out as a numbered list.
    reference: "1. Read the failing test.\n2. Find the race.\n3. Fix it without adding a timeout.",
    openai: {
      raw: "First, read the failing test. Second, find the race. Third, fix it without adding a timeout.",
      fixes: {
        "1. Read the failing test": "form",
        "2. Find the race": "form",
        "3. Fix it without adding a timeout": "form",
      },
      keep: ["without adding a timeout"],
    },
    deepgram: {
      raw: "First, read the failing test. Second, find the race. Third, fix it without adding a time out.",
      fixes: {
        "1. Read the failing test": "form",
        "2. Find the race": "form",
        "3. Fix it without adding a timeout": "form",
      },
    },
  },
  "react-compiler": {
    openai: {
      raw: "The React compiler bailed out on use terminal store. Check the Babel plugin output for the reason.",
      fixes: { useTerminalStore: "form" },
      keep: ["Babel plugin"],
    },
    deepgram: {
      raw: "The react compiler bailed out on use terminal store. Check the babble plug in output for the reason.",
      fixes: { React: "form", useTerminalStore: "form", Babel: "misread", plugin: "form" },
      uncertain: ["babble"],
    },
  },
  "playwright-spec": {
    openai: {
      raw: "Write a Playwright spec under E2E slash full slash platform that presses command plus D and checks the mock gets audio.",
      fixes: { "e2e/full/platform": "form" },
      keep: ["Playwright"],
    },
    deepgram: {
      raw: "Write a playwright spec under e two e slash full slash platform that presses command plus d and checks the mock gets audio.",
      fixes: { Playwright: "form", "e2e/full/platform": "form" },
      uncertain: ["e two e"],
    },
  },
  "drizzle-migration": {
    openai: {
      raw: "Add a Drizzle migration with a project underscore ID column on the dictionary table, then run NPM run DB colon generate.",
      fixes: { project_id: "form", "db:generate": "form" },
      keep: ["Drizzle"],
    },
    deepgram: {
      raw: "Add a drizzle migration with a project underscore ID column on the dictionary table. Then run N P M run d b colon generate.",
      fixes: { Drizzle: "form", project_id: "form", "npm run db:generate": "form" },
    },
  },
  "deepgram-keyterm": {
    openai: {
      raw: "Deepgram Nova three rejects the key term parameter when the list is too long, so cap it before building the URL.",
      // Spoken numbers stay words: the prompt never turns "three" into a digit.
      reference:
        "Deepgram Nova three rejects the keyterm parameter when the list is too long, so cap it before building the URL.",
      fixes: { keyterm: "form" },
      keep: ["Deepgram", "three"],
    },
    deepgram: {
      raw: "Deepgram Nova 3 rejects the key term parameter when the list is too long, so cap it before building the URL.",
      fixes: { keyterm: "form" },
      keep: ["Deepgram"],
    },
  },
  "pull-request": {
    openai: { raw: "Looks good. Open a pull request against develop.", fixes: {} },
    deepgram: { raw: "Looks good. Open a pull request against develop.", fixes: {} },
  },
  "ipc-codegen": {
    openai: {
      raw: "Move the handler into electron slash IPC slash handlers and regenerate the preload types with codegen colon IPC.",
      fixes: { "electron/ipc/handlers": "form", "codegen:ipc": "form" },
    },
    deepgram: {
      raw: "Move the handler into electron slash IPC slash handlers and regenerate the preload types with code gen colon IPC.",
      fixes: { "electron/ipc/handlers": "form", "codegen:ipc": "form" },
      uncertain: ["code gen"],
    },
  },
  "xterm-webgl": {
    openai: {
      raw: "The xterm WebGL renderer drops glyphs after a resize. Check the texture atlas size.",
      fixes: {},
      keep: ["xterm WebGL"],
    },
    deepgram: {
      raw: "The x term web GL renderer drops glyphs after a resize. Check the texture atlas size.",
      fixes: { xterm: "form", WebGL: "form" },
      uncertain: ["x term"],
    },
  },
  "node-pty-rebuild": {
    openai: {
      raw: "Node PTY fails to load after the Electron upgrade. Run NPM run rebuild and try again.",
      fixes: { "node-pty": "form" },
      keep: ["Electron"],
    },
    deepgram: {
      raw: "Node p t y fails to load after the electron upgrade. Run n p m run rebuild and try again.",
      fixes: { "node-pty": "form", Electron: "form", "npm run rebuild": "form" },
    },
  },
};

type AuthoredCase = Omit<CleanupCase, "fixes"> & { fixes?: CleanupCase["fixes"] };

// Mishearings from one afternoon of real dictation (#14793), each one only
// fixable from the rest of the sentence.
const AFTERNOON: readonly AuthoredCase[] = [
  {
    id: "afternoon-would:openai",
    style: "openai",
    source: "afternoon",
    raw: "Can you look into how useful switching to GPT 6.1 Terra we'd actually be for dictation cleanup?",
    reference:
      "Can you look into how useful switching to GPT 6.1 Terra would actually be for dictation cleanup?",
    fixes: { "would actually be": "misread" },
    keep: ["GPT 6.1 Terra"],
  },
  {
    id: "afternoon-would:deepgram",
    style: "deepgram",
    source: "afternoon",
    raw: "Can you look into how useful switching to GPT 6.1 terra we'd actually be for dictation cleanup?",
    reference:
      "Can you look into how useful switching to GPT 6.1 Terra would actually be for dictation cleanup?",
    fixes: { Terra: "form", "would actually be": "misread" },
    keep: ["GPT 6.1"],
    uncertain: ["terra", "we'd"],
  },
  {
    id: "afternoon-about:openai",
    style: "openai",
    source: "afternoon",
    raw: "Create an issue on beta using this data to pick the cleanup model.",
    reference: "Create an issue about using this data to pick the cleanup model.",
    fixes: { "about using this data": "misread" },
    // Nothing in the project is called beta: the draft is about measurements.
    recentContext: ["The benchmark has the guard rejections and latency for each model now."],
    startsPrompt: false,
  },
  {
    id: "afternoon-about:deepgram",
    style: "deepgram",
    source: "afternoon",
    raw: "Create an issue on beta using this data to pick the cleanup model.",
    reference: "Create an issue about using this data to pick the cleanup model.",
    fixes: { "about using this data": "misread" },
    uncertain: ["on beta"],
    recentContext: ["The benchmark has the guard rejections and latency for each model now."],
    startsPrompt: false,
  },
  {
    id: "afternoon-tara:openai",
    style: "openai",
    source: "afternoon",
    raw: "Run the cleanup benchmark against Luna and Tara at low effort and compare the latency.",
    reference:
      "Run the cleanup benchmark against Luna and Terra at low effort and compare the latency.",
    fixes: { Terra: "misread" },
    keep: ["Luna"],
  },
  {
    id: "afternoon-tera:deepgram",
    style: "deepgram",
    source: "afternoon",
    raw: "then switch file link detection over to tera too if it fits in the four second budget.",
    reference:
      "then switch file link detection over to Terra too if it fits in the four second budget.",
    fixes: { Terra: "misread" },
    keep: ["four second budget"],
    uncertain: ["tera"],
    recentContext: ["Move cleanup to gpt-6.1-terra if it wins on quality,"],
    startsPrompt: false,
  },
  {
    id: "afternoon-wispr:openai",
    style: "openai",
    source: "afternoon",
    raw: "I want dictation in Daintree to be good enough that I stop reaching for WhisperFlow.",
    reference:
      "I want dictation in Daintree to be good enough that I stop reaching for Wispr Flow.",
    fixes: { "Wispr Flow": "misread" },
    keep: ["Daintree"],
  },
  {
    id: "afternoon-wispr:deepgram",
    style: "deepgram",
    source: "afternoon",
    raw: "I want dictation in Daintree to be good enough that I stop reaching for whisper flow.",
    reference:
      "I want dictation in Daintree to be good enough that I stop reaching for Wispr Flow.",
    fixes: { "Wispr Flow": "misread" },
    keep: ["Daintree"],
    uncertain: ["whisper flow"],
  },
];

// Words that sound right on their own and only read wrong in the sentence, the
// draft before it, or what the terminal just printed.
const CONTEXT: readonly AuthoredCase[] = [
  {
    id: "context-setting:openai",
    style: "openai",
    source: "context",
    raw: "Gate it behind the existing sitting, we don't need another flag.",
    reference: "Gate it behind the existing setting, we don't need another flag.",
    fixes: { "existing setting": "misread" },
    keep: ["don't need another flag"],
    terminalOutput:
      "Two options:\n  1. Add a new feature flag for the cleanup model\n  2. Gate it behind the existing voice setting\nWhich do you prefer?",
  },
  {
    id: "context-pane:deepgram",
    style: "deepgram",
    source: "context",
    raw: "Make sure the ref count drops to zero when the last pain in the project closes.",
    reference: "Make sure the ref count drops to zero when the last pane in the project closes.",
    fixes: { "last pane": "misread" },
    keep: ["zero"],
    uncertain: ["pain"],
  },
  {
    id: "context-cache:openai",
    style: "openai",
    source: "context",
    raw: "Invalidate the cash when the branch changes, otherwise the diff view shows stale files.",
    reference:
      "Invalidate the cache when the branch changes, otherwise the diff view shows stale files.",
    fixes: { "the cache": "misread" },
  },
  {
    id: "context-claude-code:openai",
    style: "openai",
    source: "context",
    raw: "Open a new cloud code agent in that worktree and give it the failing test.",
    reference: "Open a new Claude Code agent in that worktree and give it the failing test.",
    fixes: { "Claude Code": "misread" },
  },
  {
    id: "context-codex:deepgram",
    style: "deepgram",
    source: "context",
    raw: "Ask codecs to review the diff before you open the PR.",
    reference: "Ask Codex to review the diff before you open the PR.",
    fixes: { Codex: "misread" },
    uncertain: ["codecs"],
  },
  {
    id: "context-write:deepgram",
    style: "deepgram",
    source: "context",
    raw: "Add a lock so two agents can't right to the same file at once.",
    reference: "Add a lock so two agents can't write to the same file at once.",
    fixes: { "can't write": "misread" },
    keep: ["can't"],
  },
  {
    id: "context-waiting:openai",
    style: "openai",
    source: "context",
    raw: "The PR is still weighting on CI, so don't merge it yet.",
    reference: "The PR is still waiting on CI, so don't merge it yet.",
    fixes: { "waiting on CI": "misread" },
    keep: ["don't merge it yet"],
  },
  {
    id: "context-sigwinch:deepgram",
    style: "deepgram",
    source: "context",
    raw: "The resize storm sends a sig winch on every frame, debounce it.",
    reference: "The resize storm sends a SIGWINCH on every frame, debounce it.",
    fixes: { SIGWINCH: "form" },
    uncertain: ["sig winch"],
    terminalOutput: "pty-host: SIGWINCH x48 in 1.2s (pane 3)\npty-host: resize 120x40 -> 121x40",
  },
  {
    id: "context-continues:openai",
    style: "openai",
    source: "context",
    raw: "only for 2 seconds, after that it sends the raw text.",
    reference: "only for 2 seconds, after that it sends the raw text.",
    keep: ["2 seconds"],
    recentContext: ["The send waits for cleanup, but"],
    startsPrompt: false,
  },
  {
    id: "context-shim:deepgram",
    style: "deepgram",
    source: "context",
    raw: "Add the shin for now, we'll do the migration in a follow up.",
    reference: "Add the shim for now, we'll do the migration in a follow-up.",
    fixes: { "the shim": "misread" },
    uncertain: ["shin"],
    terminalOutput:
      "Should I write a migration for the old settings now, or add a shim that reads both keys?",
  },
  {
    id: "context-their:openai",
    style: "openai",
    source: "context",
    raw: "Make sure the agents keep there own scrollback when the view is evicted.",
    reference: "Make sure the agents keep their own scrollback when the view is evicted.",
    fixes: { "their own": "misread" },
  },
  // Words a cleanup primed on the cases above must leave alone.
  {
    id: "context-person-tara:openai",
    style: "openai",
    source: "context",
    raw: "Tara reviewed the PR yesterday, so ask her before you merge it.",
    reference: "Tara reviewed the PR yesterday, so ask her before you merge it.",
    keep: ["Tara"],
  },
  {
    id: "context-beta-channel:deepgram",
    style: "deepgram",
    source: "context",
    raw: "Ship it to the beta channel first and leave stable alone.",
    reference: "Ship it to the beta channel first and leave stable alone.",
    keep: ["beta channel"],
  },
  {
    id: "context-answer-no:openai",
    style: "openai",
    source: "context",
    raw: "No, just ship it behind the setting we already have.",
    reference: "No, just ship it behind the setting we already have.",
    keep: ["No, just ship it"],
    terminalOutput: "Should I add a feature flag for this, or reuse an existing setting?",
  },
];

// This repository's names as a dictation in it sends them (`deriveRepoNames`
// then `screenCorrectionRepositoryNames`, on the commit that added them), and
// the worktree the cleanup model was measured in (#14793).
const TERRA_WORKTREE_SESSION: CleanupSession = {
  worktree: {
    name: "feature/issue-14793-measure-whether-gpt-6-1-terra-is-worth",
    titles: ["Measure whether gpt-6.1-terra is worth it for dictation cleanup"],
  },
  repositoryNames: [
    "daintree",
    "create-daintree-plugin",
    "daintree-plugin",
    "plugin-sdk",
    "plugin-vite",
    "svelte-source-model",
    "tour",
    "assistant",
    "e2e",
    "electron",
    "packages",
    "plugins",
    "schemas",
    "shared",
    "tokenizers",
    "watcher",
    "react-select",
    "addon-webgl",
    "ajv",
    "ajv-formats",
    "archiver",
    "avr-vad",
    "better-sqlite3",
    "copytree",
    "dompurify",
    "httpxy",
    "ipaddr.js",
    "js-yaml",
    "mac-phys-footprint",
    "mermaid",
    "node-addon-api",
    "node-pty",
    "onnxruntime-node",
    "posix-pty-reaper",
    "proper-lockfile",
    "react-colorful",
    "remark-parse",
    "safe-stable-stringify",
    "smol-toml",
    "unified",
    "win-job-object",
    "yauzl",
    "playwright",
    "parser",
    "commands",
    "lang-cpp",
    "lang-css",
    "lang-go",
    "lang-html",
    "lang-java",
    "lang-javascript",
    "lang-jinja",
    "lang-json",
    "lang-less",
    "lang-liquid",
    "lang-markdown",
    "lang-php",
    "lang-python",
    "lang-rust",
    "lang-sass",
  ],
};

// Names only the worktree's title or the repository spells, and passages that
// sound like them and must be left alone, all dictated in one session so they
// share one cached prompt.
const IN_SESSION: readonly AuthoredCase[] = [
  {
    id: "workspace-terra:openai",
    style: "openai",
    source: "workspace",
    raw: "Run the benchmark again with GPT 6.1 there at low effort and compare the latency.",
    reference: "Run the benchmark again with GPT 6.1 Terra at low effort and compare the latency.",
    fixes: { "GPT 6.1 Terra": "misread" },
    keep: ["low effort"],
    session: TERRA_WORKTREE_SESSION,
  },
  {
    id: "workspace-terra:deepgram",
    style: "deepgram",
    source: "workspace",
    raw: "Run the benchmark again with GPT 6.1 there at low effort and compare the latency.",
    reference: "Run the benchmark again with GPT 6.1 Terra at low effort and compare the latency.",
    fixes: { "GPT 6.1 Terra": "misread" },
    keep: ["low effort"],
    uncertain: ["there"],
    session: TERRA_WORKTREE_SESSION,
  },
  {
    id: "workspace-onnx:openai",
    style: "openai",
    source: "workspace",
    raw: "Load the VAD model with Onyx Runtime Node, not the web build.",
    reference: "Load the VAD model with onnxruntime-node, not the web build.",
    fixes: { "onnxruntime-node": "misread" },
    keep: ["not the web build"],
    session: TERRA_WORKTREE_SESSION,
  },
  {
    id: "workspace-onnx:deepgram",
    style: "deepgram",
    source: "workspace",
    raw: "Load the VAD model with onyx runtime node, not the web build.",
    reference: "Load the VAD model with onnxruntime-node, not the web build.",
    fixes: { "onnxruntime-node": "misread" },
    keep: ["not the web build"],
    uncertain: ["onyx runtime node"],
    session: TERRA_WORKTREE_SESSION,
  },
  // Words a cleanup told about Terra must leave alone.
  {
    id: "workspace-there:openai",
    style: "openai",
    source: "workspace",
    raw: "Is there anything else left on the list before we merge?",
    reference: "Is there anything else left on the list before we merge?",
    keep: ["Is there anything else"],
    session: TERRA_WORKTREE_SESSION,
  },
  {
    id: "workspace-person-tara:openai",
    style: "openai",
    source: "workspace",
    raw: "Tara reviewed the PR yesterday, so ask her before you merge it.",
    reference: "Tara reviewed the PR yesterday, so ask her before you merge it.",
    keep: ["Tara"],
    session: TERRA_WORKTREE_SESSION,
  },
  {
    id: "workspace-unrelated:deepgram",
    style: "deepgram",
    source: "workspace",
    raw: "Make the empty state name the next action instead of saying there's nothing here.",
    reference: "Make the empty state name the next action instead of saying there's nothing here.",
    keep: ["there's nothing here"],
    session: TERRA_WORKTREE_SESSION,
  },
];

// Each passage the session should settle, dictated with none: what the session
// adds is the difference between the two.
const WORKSPACE: readonly AuthoredCase[] = [
  ...IN_SESSION,
  ...IN_SESSION.filter((entry) => Object.keys(entry.fixes ?? {}).length > 0).map(
    ({ session: _session, ...entry }) => ({
      ...entry,
      id: entry.id.replace(":", "-bare:"),
    })
  ),
];

// Prompt-length passages, dictated the way people talk: filler, false starts,
// a self-correction, a counted-out list.
const RAMBLE: readonly AuthoredCase[] = [
  {
    id: "ramble-send-wait:openai",
    style: "openai",
    source: "ramble",
    raw: "Um, so I want you to look at the voice recording service, and, uh, the bit where the send waits for cleanup. Right now it waits two seconds, which is, like, fine for short stuff, but for a long prompt the cleanup often takes longer than that, so the raw text goes out. Can you, can you add some logging so we can see how often that happens, um, and how long the cleanup actually took when it did come back? Don't change the wait itself yet. So yeah.",
    reference:
      "I want you to look at the voice recording service, and the bit where the send waits for cleanup. Right now it waits two seconds, which is fine for short stuff, but for a long prompt the cleanup often takes longer than that, so the raw text goes out. Can you add some logging so we can see how often that happens, and how long the cleanup actually took when it did come back? Don't change the wait itself yet.",
    drops: ["um", "uh", "like", "can you, can you"],
    keep: ["Don't change the wait itself yet", "two seconds"],
  },
  {
    id: "ramble-guard:deepgram",
    style: "deepgram",
    source: "ramble",
    raw: "So the problem is the guard rejects any cleanup that changes more than 15% of the words, and when it rejects one, nothing lands at all, so the whole passage stays raw. What I want is for you to measure how often that happens on the replay fixtures, no wait, on the new cleanup corpus and tell me which rule fires most often.",
    reference:
      "So the problem is the guard rejects any cleanup that changes more than 15% of the words, and when it rejects one, nothing lands at all, so the whole passage stays raw. What I want is for you to measure how often that happens on the new cleanup corpus and tell me which rule fires most often.",
    drops: ["no wait", "replay fixtures"],
    keep: ["15%", "nothing lands at all"],
  },
  {
    id: "ramble-list:openai",
    style: "openai",
    source: "ramble",
    raw: "Okay, so three things. One, um, the cleanup model should be configurable per project. Two, the warm up should skip when the key is missing. And three, uh, the summary should log the request time.",
    reference:
      "Three things:\n1. The cleanup model should be configurable per project.\n2. The warm-up should skip when the key is missing.\n3. The summary should log the request time.",
    fixes: { "1. The cleanup model": "form", "2. The warm": "form", "3. The summary": "form" },
    drops: ["um", "uh"],
  },
  {
    id: "ramble-range-store:openai",
    style: "openai",
    source: "ramble",
    raw: "Yeah, so I looked at the output and, you know, the test that's failing is the one in the dictation range store, the one that, um, checks the edited flag. I think, I think what's happening is the correction lands after the user has already typed into the composer, and we flag the whole range as edited even though only the tail changed. Can you write a failing test for that first, and then fix it so only the ranges the edit actually touched get flagged? Don't touch the orchestrator subscription, it's fine.",
    reference:
      "I looked at the output and the test that's failing is the one in the dictation range store, the one that checks the edited flag. I think what's happening is the correction lands after the user has already typed into the composer, and we flag the whole range as edited even though only the tail changed. Can you write a failing test for that first, and then fix it so only the ranges the edit actually touched get flagged? Don't touch the orchestrator subscription, it's fine.",
    drops: ["um", "you know", "I think, I think"],
    keep: ["Don't touch the orchestrator subscription"],
    terminalOutput:
      " FAIL  src/store/__tests__/dictationRangeStore.test.ts > flags only the touched range\n   AssertionError: expected [ 'edited', 'edited' ] to deeply equal [ 'clean', 'edited' ]",
  },
  {
    id: "ramble-watchdog:deepgram",
    style: "deepgram",
    source: "ramble",
    raw: "The p t y host shard for the second project keeps restarting after the laptop wakes from sleep. I think the watch dog misses the heartbeat during the suspend and then kills the host. Look at the main process watch dog client and the suspend handling in power monitor and make sure a missed beat during sleep doesn't count. Add a test with fake timers that suspends for 30 seconds and resumes.",
    reference:
      "The pty-host shard for the second project keeps restarting after the laptop wakes from sleep. I think the watchdog misses the heartbeat during the suspend and then kills the host. Look at the MainProcessWatchdogClient and the suspend handling in powerMonitor, and make sure a missed beat during sleep doesn't count. Add a test with fake timers that suspends for 30 seconds and resumes.",
    fixes: { watchdog: "form" },
    keep: ["30 seconds", "doesn't count"],
    uncertain: ["watch dog"],
  },
  {
    id: "ramble-split-constant:openai",
    style: "openai",
    source: "ramble",
    raw: "Um, okay. In shared slash config slash voice correction dot TS there's a constant called voice dictation AI model. I want cleanup and rewrite on one model and file link detection on another, so split it into two constants. Don't rename the existing one, uh, other files import it. Then update the settings sanitiser in the voice input handler so a stored model that isn't the cleanup model gets reset, and add a migration. Run npm test on the voice correction service tests with --run and don't run the full suite.",
    reference:
      "In shared/config/voiceCorrection.ts there's a constant called VOICE_DICTATION_AI_MODEL. I want cleanup and rewrite on one model and file link detection on another, so split it into two constants. Don't rename the existing one, other files import it. Then update the settings sanitiser in the voice input handler so a stored model that isn't the cleanup model gets reset, and add a migration. Run npm test on the voice correction service tests with --run and don't run the full suite.",
    fixes: { "shared/config/voiceCorrection.ts": "form" },
    drops: ["um", "uh"],
    keep: ["--run", "Don't rename the existing one", "isn't", "don't run the full suite"],
  },
];

// Passages already right: cleanup should hand them back untouched.
const CLEAN: readonly AuthoredCase[] = [
  {
    id: "clean-merge:openai",
    style: "openai",
    source: "clean",
    raw: "Looks good to me. Merge it into develop, not main.",
    reference: "Looks good to me. Merge it into develop, not main.",
    keep: ["not main"],
  },
  {
    id: "clean-revert:deepgram",
    style: "deepgram",
    source: "clean",
    raw: "Revert the last commit and push to the same branch.",
    reference: "Revert the last commit and push to the same branch.",
  },
  {
    id: "clean-backticks:openai",
    style: "openai",
    source: "clean",
    raw: "Check whether `npm run check` passes on Windows before you open the PR.",
    reference: "Check whether `npm run check` passes on Windows before you open the PR.",
    keep: ["`npm run check`"],
  },
  {
    id: "clean-long:openai",
    style: "openai",
    source: "clean",
    raw: "The send waits up to two seconds for cleanup. If it hasn't come back by then, the raw text goes to the agent and the cleaned version is kept for the recent dictations list.",
    reference:
      "The send waits up to two seconds for cleanup. If it hasn't come back by then, the raw text goes to the agent and the cleaned version is kept for the recent dictations list.",
    keep: ["hasn't come back"],
  },
];

function regressionCases(): CleanupCase[] {
  return DICTATED_PROMPTS.map(({ name, raw, expected }) => ({
    id: `regression-${name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")}`,
    style: "generic" as const,
    source: "regression" as const,
    raw,
    reference: expected[0]!,
    alsoAccept: expected.slice(1),
    fixes: {},
  }));
}

function replayCases(): CleanupCase[] {
  return REPLAY_CLIPS.flatMap((clip) => {
    const transcripts = REPLAY_TRANSCRIPTS[clip.id];
    if (!transcripts) return [];
    return (["openai", "deepgram"] as const).map((style) => {
      const { reference, ...transcript } = transcripts[style];
      return {
        id: `${clip.id}:${style}`,
        style,
        source: "replay" as const,
        reference: reference ?? transcripts.reference ?? clip.reference,
        ...transcript,
      };
    });
  });
}

export const CLEANUP_CORPUS: readonly CleanupCase[] = [
  ...replayCases(),
  ...[...AFTERNOON, ...CONTEXT, ...WORKSPACE, ...RAMBLE, ...CLEAN].map((entry) => ({
    ...entry,
    fixes: entry.fixes ?? {},
  })),
  ...regressionCases(),
];

/**
 * Each distinct session the corpus dictates in, `undefined` for none, in the
 * order first met: what a run warms, once per variant.
 */
export function cleanupSessions(corpus: readonly CleanupCase[]): Array<CleanupSession | undefined> {
  const seen = new Map<string, CleanupSession | undefined>();
  for (const entry of corpus) {
    const key = entry.session ? JSON.stringify(entry.session) : "";
    if (!seen.has(key)) seen.set(key, entry.session);
  }
  return [...seen.values()];
}
