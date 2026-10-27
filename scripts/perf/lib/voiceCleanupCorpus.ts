import { DICTATED_PROMPTS } from "../../../electron/services/__tests__/fixtures/dictatedPrompts";
import { REPLAY_CLIPS } from "../../../e2e/helpers/voiceReplayFixtures";

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
 * - Grok (`grok-voice-transcribe-2.0` with `format`, no `filler_words`): cased
 *   and punctuated, numbers as digits, "um", "uh" and stutters gone but "yeah",
 *   "you know" and hedges kept, compounds and identifiers written as ordinary
 *   words ("Web Socket", "use Terminal Store"), and spelled letters as capitals
 *   ("N P M"). It flags no unsure words: xAI's word confidences aren't
 *   calibrated (#14769), so cleanup gets none from it.
 *
 * The cleanup regression prompts (`dictatedPrompts.ts`) come in as they are,
 * in no provider's style.
 */

export type TranscriptStyle = "openai" | "deepgram" | "grok" | "generic";

export type CaseSource =
  | "replay"
  | "afternoon"
  | "context"
  | "ramble"
  | "tics"
  | "lookalike"
  | "clean"
  | "regression";

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
  /** Written forms the raw transcript got wrong that cleanup should land, matched case-sensitively. */
  fixes: string[];
  /** Words and phrases cleanup should take out (filler, stutters, a retracted phrase), matched as whole words, ignoring case. */
  drops?: string[];
  /** Spans the raw transcript already has right that must come through character for character. */
  keep?: string[];
  /** A run-on the cleanup should break up: no sentence it writes may run longer than this many words. */
  maxSentenceWords?: number;
  /** Words the recogniser was unsure of, located in `raw` in order. Deepgram only. */
  uncertain?: string[];
  recentContext?: string[];
  terminalOutput?: string;
  /** Nothing comes before the passage in the draft; true unless `recentContext` says otherwise. */
  startsPrompt?: boolean;
}

interface Transcript {
  raw: string;
  /** Where cleanup's ideal for this transcript differs from the clip's: digits it must keep, say. */
  reference?: string;
  fixes: string[];
  keep?: string[];
  uncertain?: string[];
}

interface ReplayTranscripts {
  openai: Transcript;
  deepgram: Transcript;
  grok: Transcript;
  /** Where cleanup's ideal differs from the clip's written reference. */
  reference?: string;
}

/** A raw transcript in each provider's style for every replay clip, keyed by clip id. */
export const REPLAY_TRANSCRIPTS: Readonly<Record<string, ReplayTranscripts>> = {
  "zustand-selector": {
    openai: {
      raw: "Zustand selector in the worktree store is returning a new array on every render. Wrap it in use shallow.",
      fixes: ["useShallow"],
      keep: ["Zustand"],
    },
    deepgram: {
      raw: "Zoo stand selector in the work tree store is returning a new array on every render. Wrap it in use shallow.",
      fixes: ["Zustand", "worktree", "useShallow"],
      uncertain: ["Zoo stand", "shallow"],
    },
    grok: {
      raw: "Zustand selector in the work tree store is returning a new array on every render. Wrap it in use shallow.",
      fixes: ["worktree", "useShallow"],
      keep: ["Zustand"],
    },
  },
  "npm-test-watch": {
    openai: {
      raw: "Run NPM test dash dash watch on the voice recording service test file.",
      fixes: ["--watch"],
    },
    deepgram: {
      raw: "Run N P M test dash dash watch on the voice recording service test file.",
      fixes: ["npm test", "--watch"],
    },
    grok: {
      raw: "Run N P M test dash dash watch on the Voice Recording Service test file.",
      fixes: ["npm test", "--watch"],
    },
  },
  "commit-and-push": {
    openai: { raw: "Commit and push.", fixes: [] },
    deepgram: { raw: "Commit and push.", fixes: [] },
    grok: { raw: "Commit and push.", fixes: [] },
  },
  "path-after-pause": {
    openai: {
      raw: "Open electron slash services slash voice. Then find where the web socket reconnects.",
      fixes: ["electron/services/voice", "WebSocket"],
    },
    deepgram: {
      raw: "Open Electron slash services slash voice. Then find where the websocket reconnects.",
      fixes: ["electron/services/voice", "WebSocket"],
    },
    grok: {
      raw: "Open Electron slash services slash voice. Then find where the Web Socket reconnects.",
      fixes: ["electron/services/voice", "WebSocket"],
    },
  },
  "long-continuous": {
    openai: {
      raw: "I want you to go through the OpenAI transcription provider and trace every path where audio arrives before the session is ready, then write a VTest test that sends three chunks during the handshake and proves every byte reaches the socket in order after the session dot updated event arrives.",
      fixes: ["Vitest", "session.updated"],
      keep: ["three chunks"],
    },
    deepgram: {
      raw: "I want you to go through the open AI transcription provider and trace every path where audio arrives before the session is ready. Then write a v test test that sends 3 chunks during the handshake and proves every byte reaches the socket in order after the session dot updated event arrives.",
      reference:
        "I want you to go through the OpenAITranscriptionProvider and trace every path where audio arrives before the session is ready, then write a Vitest test that sends 3 chunks during the handshake and proves every byte reaches the socket in order after the session.updated event arrives.",
      fixes: ["OpenAI", "Vitest", "session.updated"],
      keep: ["3 chunks"],
      uncertain: ["v test"],
    },
    grok: {
      raw: "I want you to go through the Open AI transcription provider and trace every path where audio arrives before the session is ready, then write a Vitest test that sends 3 chunks during the handshake and proves every byte reaches the socket in order after the session dot updated event arrives.",
      reference:
        "I want you to go through the OpenAITranscriptionProvider and trace every path where audio arrives before the session is ready, then write a Vitest test that sends 3 chunks during the handshake and proves every byte reaches the socket in order after the session.updated event arrives.",
      fixes: ["OpenAI", "session.updated"],
      keep: ["3 chunks", "Vitest"],
    },
  },
  "long-then-pause": {
    openai: {
      raw: "The project view manager evicts the least recently used view when memory is tight, but the renderer for that view keeps its xterm instances alive because nothing calls dispose on them when the web contents goes away. Find the leak and fix it.",
      fixes: [],
      keep: ["xterm"],
    },
    deepgram: {
      raw: "The project view manager evicts the least recently used view when memory is tight, but the renderer for that view keeps its x term instances alive because nothing calls dispose on them when the web contents goes away. Find the leak and fix it.",
      fixes: ["xterm"],
      uncertain: ["x term"],
    },
    grok: {
      raw: "The Project View Manager evicts the least recently used view when memory is tight, but the renderer for that view keeps its X term instances alive because nothing calls dispose on them when the web contents goes away. Find the leak and fix it.",
      fixes: ["xterm"],
    },
  },
  "rebase-develop": {
    openai: {
      raw: "Rebase this branch onto origin slash develop and resolve the conflict in package.json.",
      fixes: ["origin/develop"],
      keep: ["package.json"],
    },
    deepgram: {
      raw: "Rebase this branch onto origin slash develop and resolve the conflict in package dot JSON.",
      fixes: ["origin/develop", "package.json"],
    },
    grok: {
      raw: "Rebase this branch onto origin slash develop and resolve the conflict in package.json.",
      fixes: ["origin/develop"],
      keep: ["package.json"],
    },
  },
  "tailwind-token": {
    openai: {
      raw: "Swap the hard-coded hex colour for the text secondary token from Tailwind and check it in dark mode.",
      fixes: ["text-secondary"],
      keep: ["Tailwind"],
    },
    deepgram: {
      raw: "Swap the hard coded hex colour for the text secondary token from tailwind and check it in dark mode.",
      fixes: ["text-secondary", "Tailwind"],
    },
    grok: {
      raw: "Swap the hard coded hex colour for the Text Secondary token from Tailwind and check it in dark mode.",
      fixes: ["text-secondary"],
      keep: ["Tailwind"],
    },
  },
  "typescript-error": {
    openai: {
      raw: "Fix the TypeScript error TS2345 in shared slash types slash IPC slash API dot TS.",
      fixes: ["shared/types/ipc/api.ts"],
      keep: ["TS2345"],
    },
    deepgram: {
      raw: "Fix the TypeScript error TS 2345 in shared slash types slash IPC slash API dot TS.",
      fixes: ["TS2345", "shared/types/ipc/api.ts"],
    },
    grok: {
      raw: "Fix the TypeScript error T S 2345 in shared slash types slash I P C slash A P I dot T S.",
      fixes: ["TS2345", "shared/types/ipc/api.ts"],
    },
  },
  "three-steps": {
    // The prompt lays a counted-out passage out as a numbered list.
    reference: "1. Read the failing test.\n2. Find the race.\n3. Fix it without adding a timeout.",
    openai: {
      raw: "First, read the failing test. Second, find the race. Third, fix it without adding a timeout.",
      fixes: ["1. Read the failing test", "2. Find the race", "3. Fix it without adding a timeout"],
      keep: ["without adding a timeout"],
    },
    deepgram: {
      raw: "First, read the failing test. Second, find the race. Third, fix it without adding a time out.",
      fixes: ["1. Read the failing test", "2. Find the race", "3. Fix it without adding a timeout"],
    },
    grok: {
      raw: "First, read the failing test. Second, find the race. Third, fix it without adding a timeout.",
      fixes: ["1. Read the failing test", "2. Find the race", "3. Fix it without adding a timeout"],
      keep: ["without adding a timeout"],
    },
  },
  "react-compiler": {
    openai: {
      raw: "The React compiler bailed out on use terminal store. Check the Babel plugin output for the reason.",
      fixes: ["useTerminalStore"],
      keep: ["Babel plugin"],
    },
    deepgram: {
      raw: "The react compiler bailed out on use terminal store. Check the babble plug in output for the reason.",
      fixes: ["React", "useTerminalStore", "Babel", "plugin"],
      uncertain: ["babble"],
    },
    grok: {
      raw: "The React compiler bailed out on use Terminal Store. Check the Babel plug-in output for the reason.",
      fixes: ["useTerminalStore", "plugin"],
      keep: ["Babel"],
    },
  },
  "playwright-spec": {
    openai: {
      raw: "Write a Playwright spec under E2E slash full slash platform that presses command plus D and checks the mock gets audio.",
      fixes: ["e2e/full/platform"],
      keep: ["Playwright"],
    },
    deepgram: {
      raw: "Write a playwright spec under e two e slash full slash platform that presses command plus d and checks the mock gets audio.",
      fixes: ["Playwright", "e2e/full/platform"],
      uncertain: ["e two e"],
    },
    grok: {
      raw: "Write a Playwright spec under E 2 E slash full slash platform that presses Command plus D and checks the mock gets audio.",
      fixes: ["e2e/full/platform"],
      keep: ["Playwright"],
    },
  },
  "drizzle-migration": {
    openai: {
      raw: "Add a Drizzle migration with a project underscore ID column on the dictionary table, then run NPM run DB colon generate.",
      fixes: ["project_id", "db:generate"],
      keep: ["Drizzle"],
    },
    deepgram: {
      raw: "Add a drizzle migration with a project underscore ID column on the dictionary table. Then run N P M run d b colon generate.",
      fixes: ["Drizzle", "project_id", "npm run db:generate"],
    },
    grok: {
      raw: "Add a Drizzle migration with a project underscore ID column on the dictionary table, then run N P M run D B colon generate.",
      fixes: ["project_id", "npm run db:generate"],
      keep: ["Drizzle"],
    },
  },
  "deepgram-keyterm": {
    openai: {
      raw: "Deepgram Nova three rejects the key term parameter when the list is too long, so cap it before building the URL.",
      // Spoken numbers stay words: the prompt never turns "three" into a digit.
      reference:
        "Deepgram Nova three rejects the keyterm parameter when the list is too long, so cap it before building the URL.",
      fixes: ["keyterm"],
      keep: ["Deepgram", "three"],
    },
    deepgram: {
      raw: "Deepgram Nova 3 rejects the key term parameter when the list is too long, so cap it before building the URL.",
      fixes: ["keyterm"],
      keep: ["Deepgram"],
    },
    grok: {
      raw: "Deepgram Nova 3 rejects the key term parameter when the list is too long, so cap it before building the U R L.",
      fixes: ["keyterm", "URL"],
      keep: ["Deepgram"],
    },
  },
  "pull-request": {
    openai: { raw: "Looks good. Open a pull request against develop.", fixes: [] },
    deepgram: { raw: "Looks good. Open a pull request against develop.", fixes: [] },
    grok: { raw: "Looks good. Open a pull request against develop.", fixes: [] },
  },
  "ipc-codegen": {
    openai: {
      raw: "Move the handler into electron slash IPC slash handlers and regenerate the preload types with codegen colon IPC.",
      fixes: ["electron/ipc/handlers", "codegen:ipc"],
    },
    deepgram: {
      raw: "Move the handler into electron slash IPC slash handlers and regenerate the preload types with code gen colon IPC.",
      fixes: ["electron/ipc/handlers", "codegen:ipc"],
      uncertain: ["code gen"],
    },
    grok: {
      raw: "Move the handler into Electron slash IPC slash handlers and regenerate the preload types with code gen colon IPC.",
      fixes: ["electron/ipc/handlers", "codegen:ipc"],
    },
  },
  "xterm-webgl": {
    openai: {
      raw: "The xterm WebGL renderer drops glyphs after a resize. Check the texture atlas size.",
      fixes: [],
      keep: ["xterm WebGL"],
    },
    deepgram: {
      raw: "The x term web GL renderer drops glyphs after a resize. Check the texture atlas size.",
      fixes: ["xterm", "WebGL"],
      uncertain: ["x term"],
    },
    grok: {
      raw: "The X term Web GL renderer drops glyphs after a resize. Check the texture atlas size.",
      fixes: ["xterm", "WebGL"],
    },
  },
  "node-pty-rebuild": {
    openai: {
      raw: "Node PTY fails to load after the Electron upgrade. Run NPM run rebuild and try again.",
      fixes: ["node-pty"],
      keep: ["Electron"],
    },
    deepgram: {
      raw: "Node p t y fails to load after the electron upgrade. Run n p m run rebuild and try again.",
      fixes: ["node-pty", "Electron", "npm run rebuild"],
    },
    grok: {
      raw: "Node PTY fails to load after the Electron upgrade. Run N P M run rebuild and try again.",
      fixes: ["node-pty", "npm run rebuild"],
      keep: ["Electron"],
    },
  },
};

type AuthoredCase = Omit<CleanupCase, "fixes"> & { fixes?: string[] };

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
    fixes: ["would actually be"],
    keep: ["GPT 6.1 Terra"],
  },
  {
    id: "afternoon-would:deepgram",
    style: "deepgram",
    source: "afternoon",
    raw: "Can you look into how useful switching to GPT 6.1 terra we'd actually be for dictation cleanup?",
    reference:
      "Can you look into how useful switching to GPT 6.1 Terra would actually be for dictation cleanup?",
    fixes: ["Terra", "would actually be"],
    keep: ["GPT 6.1"],
    uncertain: ["terra", "we'd"],
  },
  {
    id: "afternoon-about:openai",
    style: "openai",
    source: "afternoon",
    raw: "Create an issue on beta using this data to pick the cleanup model.",
    reference: "Create an issue about using this data to pick the cleanup model.",
    fixes: ["about using this data"],
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
    fixes: ["about using this data"],
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
    fixes: ["Terra"],
    keep: ["Luna"],
  },
  {
    id: "afternoon-tera:deepgram",
    style: "deepgram",
    source: "afternoon",
    raw: "then switch file link detection over to tera too if it fits in the four second budget.",
    reference:
      "then switch file link detection over to Terra too if it fits in the four second budget.",
    fixes: ["Terra"],
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
    fixes: ["Wispr Flow"],
    keep: ["Daintree"],
  },
  {
    id: "afternoon-wispr:deepgram",
    style: "deepgram",
    source: "afternoon",
    raw: "I want dictation in Daintree to be good enough that I stop reaching for whisper flow.",
    reference:
      "I want dictation in Daintree to be good enough that I stop reaching for Wispr Flow.",
    fixes: ["Wispr Flow"],
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
    fixes: ["existing setting"],
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
    fixes: ["last pane"],
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
    fixes: ["the cache"],
  },
  {
    id: "context-claude-code:openai",
    style: "openai",
    source: "context",
    raw: "Open a new cloud code agent in that worktree and give it the failing test.",
    reference: "Open a new Claude Code agent in that worktree and give it the failing test.",
    fixes: ["Claude Code"],
  },
  {
    id: "context-codex:deepgram",
    style: "deepgram",
    source: "context",
    raw: "Ask codecs to review the diff before you open the PR.",
    reference: "Ask Codex to review the diff before you open the PR.",
    fixes: ["Codex"],
    uncertain: ["codecs"],
  },
  {
    id: "context-write:deepgram",
    style: "deepgram",
    source: "context",
    raw: "Add a lock so two agents can't right to the same file at once.",
    reference: "Add a lock so two agents can't write to the same file at once.",
    fixes: ["can't write"],
    keep: ["can't"],
  },
  {
    id: "context-waiting:openai",
    style: "openai",
    source: "context",
    raw: "The PR is still weighting on CI, so don't merge it yet.",
    reference: "The PR is still waiting on CI, so don't merge it yet.",
    fixes: ["waiting on CI"],
    keep: ["don't merge it yet"],
  },
  {
    id: "context-sigwinch:deepgram",
    style: "deepgram",
    source: "context",
    raw: "The resize storm sends a sig winch on every frame, debounce it.",
    reference: "The resize storm sends a SIGWINCH on every frame, debounce it.",
    fixes: ["SIGWINCH"],
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
    fixes: ["the shim"],
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
    fixes: ["their own"],
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
    fixes: ["1. The cleanup model", "2. The warm", "3. The summary"],
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
    fixes: ["watchdog"],
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
    fixes: ["shared/config/voiceCorrection.ts"],
    drops: ["um", "uh"],
    keep: ["--run", "Don't rename the existing one", "isn't", "don't run the full suite"],
  },
];

// What the dictations that reached the agent still had in them (#14786):
// filler, "yeah" and "so yeah", hedges, verbal tics, false starts, run-on
// sentences and misheard names. Each reference is the message the speaker
// would have typed: those gone, every instruction, constraint and detail
// kept, in the speaker's own words. A hedge that marks a guess ("I guess",
// "I think") is content, not a tic: it tells the agent not to take it as fact.
const TICS: readonly AuthoredCase[] = [
  {
    id: "tics-so-yeah:openai",
    style: "openai",
    source: "tics",
    raw: "Um, yeah, so the voice settings tab is, like, really slow to open now. Can you profile it and, uh, find out what's blocking the first render? So yeah.",
    reference:
      "The voice settings tab is really slow to open now. Can you profile it and find out what's blocking the first render?",
    drops: ["um", "uh", "yeah", "like", "so"],
  },
  {
    id: "tics-sidebar:grok",
    style: "grok",
    source: "tics",
    raw: "Okay, so basically the worktree sidebar kind of flickers when an agent finishes, and I guess it's re-rendering the whole list. Can you memoize the rows so only the one that changed re-renders? Yeah.",
    reference:
      "The worktree sidebar flickers when an agent finishes, and I guess it's re-rendering the whole list. Can you memoize the rows so only the one that changed re-renders?",
    drops: ["okay", "so", "basically", "kind of", "yeah"],
    keep: ["I guess", "only the one that changed"],
  },
  {
    id: "tics-scroll-runon:deepgram",
    style: "deepgram",
    source: "tics",
    raw: "So the problem is when you switch projects the terminal loses its scroll position and then when you come back it jumps to the top and that's really annoying so can you save the scroll offset when the view hides and restore it when it shows again and make sure it still works if the terminal got new output while it was hidden.",
    reference:
      "The problem is when you switch projects, the terminal loses its scroll position, and then when you come back it jumps to the top, and that's really annoying. Can you save the scroll offset when the view hides and restore it when it shows again, and make sure it still works if the terminal got new output while it was hidden?",
    alsoAccept: [
      "The problem is when you switch projects, the terminal loses its scroll position, and then when you come back it jumps to the top, and that's really annoying. Can you save the scroll offset when the view hides and restore it when it shows again? Make sure it still works if the terminal got new output while it was hidden.",
    ],
    drops: ["so"],
    keep: ["new output while it was hidden"],
    maxSentenceWords: 35,
  },
  {
    id: "tics-agents:grok",
    style: "grok",
    source: "tics",
    raw: "Ask Cloud Code to review it, and if it's happy, hand it to codecs for the tests. Basically, I want them working in parallel, you know, not waiting on each other. Yeah.",
    reference:
      "Ask Claude Code to review it, and if it's happy, hand it to Codex for the tests. I want them working in parallel, not waiting on each other.",
    fixes: ["Claude Code", "Codex"],
    drops: ["basically", "you know", "yeah"],
    keep: ["not waiting on each other"],
  },
  {
    id: "tics-false-start:openai",
    style: "openai",
    source: "tics",
    raw: "So I want, I need you to, um, check whether the, the preload script exposes the voice API before the window loads. And, uh, if it doesn't, don't add a delay, just, just move the expose call earlier. Okay?",
    reference:
      "I need you to check whether the preload script exposes the voice API before the window loads. If it doesn't, don't add a delay, just move the expose call earlier.",
    alsoAccept: [
      "I need you to check whether the preload script exposes the voice API before the window loads. And if it doesn't, don't add a delay, just move the expose call earlier.",
    ],
    drops: ["so", "um", "uh", "I want, I need", "the, the", "just, just", "okay"],
    keep: ["don't add a delay", "if it doesn't"],
  },
  {
    id: "tics-hedges:deepgram",
    style: "deepgram",
    source: "tics",
    raw: "The diff view is sort of slow on big files, it basically re-tokenizes everything on every scroll. Can you kind of cache the tokens per hunk and only redo the hunks that changed? Pretty much like we do for the file tree.",
    reference:
      "The diff view is slow on big files, it re-tokenizes everything on every scroll. Can you cache the tokens per hunk and only redo the hunks that changed, like we do for the file tree?",
    drops: ["sort of", "basically", "kind of", "pretty much"],
    keep: ["only redo the hunks that changed", "like we do"],
  },
  {
    id: "tics-notify-runon:openai",
    style: "openai",
    source: "tics",
    raw: "Um, so when the agent finishes, uh, we play the done sound and we also flash the dock icon and we show a toast and it's too much, you know, so can you make it so it only plays the sound if the window is focused and only does the toast and the dock flash if it isn't, um, and keep the setting that turns it all off.",
    reference:
      "When the agent finishes, we play the done sound and we also flash the dock icon and we show a toast, and it's too much. Can you make it so it only plays the sound if the window is focused, and only does the toast and the dock flash if it isn't? And keep the setting that turns it all off.",
    alsoAccept: [
      "When the agent finishes, we play the done sound and we also flash the dock icon and we show a toast, and it's too much. Can you make it so it only plays the sound if the window is focused, and only does the toast and the dock flash if it isn't? Keep the setting that turns it all off.",
    ],
    drops: ["um", "uh", "you know", "so"],
    keep: ["only plays the sound", "isn't", "turns it all off"],
    maxSentenceWords: 32,
  },
  {
    id: "tics-commit-runon:grok",
    style: "grok",
    source: "tics",
    raw: "Yeah, so the commit message generator is writing whole paragraphs for a one-line change and I want it to match the size of the diff so a small diff gets a one-line subject and nothing else and it only adds a body when more than one file changed. Yeah.",
    reference:
      "The commit message generator is writing whole paragraphs for a one-line change. I want it to match the size of the diff, so a small diff gets a one-line subject and nothing else, and it only adds a body when more than one file changed.",
    alsoAccept: [
      "The commit message generator is writing whole paragraphs for a one-line change, and I want it to match the size of the diff, so a small diff gets a one-line subject and nothing else, and it only adds a body when more than one file changed.",
    ],
    drops: ["yeah", "so"],
    keep: ["nothing else", "only adds a body", "more than one file"],
    maxSentenceWords: 40,
  },
  {
    id: "tics-answer:deepgram",
    style: "deepgram",
    source: "tics",
    raw: "Yeah, go with the first one, but cap it at 3 attempts and log each retry. And honestly also show the error if the last one fails, so it's kind of both, really.",
    reference:
      "Yeah, go with the first one, but cap it at 3 attempts and log each retry. And also show the error if the last one fails, so it's both.",
    alsoAccept: [
      "Yeah, go with the first one, but cap it at 3 attempts and log each retry. Also show the error if the last one fails, so it's both.",
    ],
    drops: ["honestly", "kind of", "really"],
    // "Yeah" answers the agent's question here: it stays.
    keep: ["Yeah, go with the first one"],
    terminalOutput:
      "I can either:\n  1. Add a retry with backoff around the fetch\n  2. Surface the error and let the user retry\nWhich approach do you want?",
  },
  {
    id: "tics-path:openai",
    style: "openai",
    source: "tics",
    raw: "Um, okay, so in, uh, src slash store slash dictation range store dot TS, the, the selector for the ranges is, like, returning a new array every time. Can you wrap it in use shallow? And, yeah, run the tests for that file with dash dash run.",
    reference:
      "In src/store/dictationRangeStore.ts, the selector for the ranges is returning a new array every time. Can you wrap it in useShallow? And run the tests for that file with --run.",
    alsoAccept: [
      "In src/store/dictationRangeStore.ts, the selector for the ranges is returning a new array every time. Can you wrap it in useShallow? Run the tests for that file with --run.",
    ],
    fixes: ["src/store/dictationRangeStore.ts", "useShallow", "--run"],
    drops: ["um", "uh", "okay", "so", "like", "the, the", "yeah"],
  },
  {
    id: "tics-list:grok",
    style: "grok",
    source: "tics",
    raw: "Okay, so a couple of things on the settings page. First, the search box kind of loses focus when you type fast. Second, the reset button basically resets every section, it should only reset the current one. And third, the scroll position jumps after you save. Yeah, that's it.",
    reference:
      "A couple of things on the settings page:\n1. The search box loses focus when you type fast.\n2. The reset button resets every section, it should only reset the current one.\n3. The scroll position jumps after you save.",
    fixes: ["1. The search box", "2. The reset button", "3. The scroll position"],
    drops: ["okay", "so", "kind of", "basically", "yeah", "that's it"],
    keep: ["only reset the current one"],
  },
  {
    id: "tics-self-correct:deepgram",
    style: "deepgram",
    source: "tics",
    raw: "Rename the hook to use voice session, no wait, use dictation session, and update the imports. Basically everywhere it's used, so yeah.",
    reference: "Rename the hook to useDictationSession, and update the imports everywhere it's used.",
    fixes: ["useDictationSession"],
    drops: ["voice session", "no wait", "basically", "so yeah"],
  },
  {
    id: "tics-names:openai",
    style: "openai",
    source: "tics",
    raw: "Um, so get Cloud Code to, uh, add a test for the Whisper Flow import, like, the one that reads its dictionary. Yeah, and make it run on Windows too.",
    reference:
      "Get Claude Code to add a test for the Wispr Flow import, the one that reads its dictionary, and make it run on Windows too.",
    alsoAccept: [
      "Get Claude Code to add a test for the Wispr Flow import, the one that reads its dictionary. Make it run on Windows too.",
    ],
    fixes: ["Claude Code", "Wispr Flow"],
    drops: ["um", "so", "uh", "like", "yeah"],
    keep: ["Windows"],
  },
];

// Words that look like filler or a hedge but carry the meaning here: an
// answer to the agent, "just" for "only", a guess, a kind, a direction.
const LOOKALIKE: readonly AuthoredCase[] = [
  {
    id: "lookalike-yeah-answer:openai",
    style: "openai",
    source: "lookalike",
    raw: "Yeah, and update the stories too.",
    reference: "Yeah, and update the stories too.",
    keep: ["Yeah"],
    terminalOutput: "Done. Should I also update the snapshot tests?",
  },
  {
    id: "lookalike-just:grok",
    style: "grok",
    source: "lookalike",
    raw: "Just run the unit tests for the guard, not the whole suite.",
    reference: "Just run the unit tests for the guard, not the whole suite.",
    keep: ["Just run", "not the whole suite"],
  },
  {
    id: "lookalike-i-think:deepgram",
    style: "deepgram",
    source: "lookalike",
    raw: "I think it's the cache, but I'm not sure, so check that before you change anything.",
    reference: "I think it's the cache, but I'm not sure, so check that before you change anything.",
    keep: ["I think", "not sure"],
  },
  {
    id: "lookalike-kind-of:openai",
    style: "openai",
    source: "lookalike",
    raw: "Find out what kind of error the watcher throws on Windows and handle that one.",
    reference: "Find out what kind of error the watcher throws on Windows and handle that one.",
    keep: ["what kind of error"],
  },
  {
    id: "lookalike-okay-answer:grok",
    style: "grok",
    source: "lookalike",
    raw: "Okay, push it, but don't open the PR until CI is green.",
    reference: "Okay, push it, but don't open the PR until CI is green.",
    keep: ["Okay, push it", "don't open the PR"],
    terminalOutput: "All checks pass locally. Ready to push the branch and open the PR?",
  },
  {
    id: "lookalike-right:openai",
    style: "openai",
    source: "lookalike",
    raw: "Move the button to the right of the search field, so it lines up with the toolbar.",
    reference: "Move the button to the right of the search field, so it lines up with the toolbar.",
    keep: ["right of", "so it lines up"],
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
    fixes: [],
  }));
}

function replayCases(): CleanupCase[] {
  return REPLAY_CLIPS.flatMap((clip) => {
    const transcripts = REPLAY_TRANSCRIPTS[clip.id];
    if (!transcripts) return [];
    return (["openai", "deepgram", "grok"] as const).map((style) => {
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
  ...[...AFTERNOON, ...CONTEXT, ...RAMBLE, ...TICS, ...LOOKALIKE, ...CLEAN].map((entry) => ({
    ...entry,
    fixes: entry.fixes ?? [],
  })),
  ...regressionCases(),
];
