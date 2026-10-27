import { z } from "zod";
import { BUILT_IN_AGENT_IDS } from "../../../shared/config/agentIds.js";
import type {
  PaneCorrectionContext,
  PaneProjectInfo,
  PaneStartContext,
} from "../../services/voice/paneContext.js";
import type { VoiceCommandTarget } from "../../services/voiceCommandTarget.js";
import type { PaneKeytermReads } from "../../services/voiceContextKeyterms.js";
import type { DictationNames } from "../../services/voiceContextNames.js";
import { MAX_CORRECTION_TERMINAL_CHARS } from "../../services/voiceTerminalContext.js";
import {
  MAX_CORRECTION_REPLY_CHARS,
  type VoiceAgentReply,
} from "../../services/voiceAgentReplyTypes.js";
import type { AgentState, WaitingReason } from "../../../shared/types/agent.js";
import { FILE_LINK_CANDIDATE_LIMIT } from "../../services/VoiceFileLinkResolver.js";

/**
 * Session-level methods a Shell reads a host's pane through when dictating
 * into it (#14782). Each names the view's project as the host knows it, and
 * the host reads only that project's terminals. A host from before them
 * answers UNSUPPORTED, and the dictation goes on without the pane's context.
 */
export const VoicePaneLinkMethod = {
  /** Keyterms, names, vocabulary and commands, at a dictation's start. */
  START: "voice.pane.start",
  /** Vocabulary, commands and recent output, for the cleanup after it. */
  CORRECTION: "voice.pane.correction",
  /** Files a host's search offers for spoken references. */
  FILES: "voice.pane.files",
  /** The project's name and folder, for a spoken rewrite. */
  PROJECT: "voice.pane.project",
} as const;

/** Past any budget a Shell sends; a host never reads for longer. */
export const MAX_PANE_READ_BUDGET_MS = 10_000;
/** The most of a list a host sends, past what any tier can use. */
export const MAX_PANE_TERMS = 128;
export const MAX_PANE_VOCABULARY = 2_000;
export const MAX_PANE_COMMANDS = 2_000;
export const MAX_PANE_FILE_DESCRIPTIONS = 32;

const MAX_ID_LENGTH = 256;
const MAX_TEXT_LENGTH = 4_096;

const id = z
  .string()
  .min(1)
  .max(MAX_ID_LENGTH)
  .refine((value) => !value.includes("\0"));
const budgetMs = z.number().int().min(1).max(MAX_PANE_READ_BUDGET_MS);
const text = z.string().max(MAX_TEXT_LENGTH);

const PaneScopeSchema = z.object({ projectId: id, terminalId: id.nullable() });

export const VoicePaneReadPayloadSchema = PaneScopeSchema.extend({ budgetMs }).strict();
export type VoicePaneReadPayload = z.infer<typeof VoicePaneReadPayloadSchema>;

export const VoicePaneFilesPayloadSchema = VoicePaneReadPayloadSchema.extend({
  descriptions: z
    .array(z.string().trim().min(1).max(MAX_TEXT_LENGTH))
    .max(MAX_PANE_FILE_DESCRIPTIONS),
}).strict();
export type VoicePaneFilesPayload = z.infer<typeof VoicePaneFilesPayloadSchema>;

export const VoicePaneProjectPayloadSchema = z.object({ projectId: id, budgetMs }).strict();

const ProjectInfoSchema = z.object({
  name: text.nullable(),
  path: text.nullable(),
}) satisfies z.ZodType<PaneProjectInfo>;

const NamesSchema = z.object({
  hosts: z.array(text).max(MAX_PANE_TERMS),
  projects: z.array(text).max(MAX_PANE_TERMS),
  worktrees: z.array(text).max(MAX_PANE_TERMS),
}) satisfies z.ZodType<DictationNames>;

const KeytermReadsSchema = z.object({
  repoNames: z.array(text).max(MAX_PANE_TERMS),
  branchName: text.nullable(),
  terminalTerms: z.array(text).max(MAX_PANE_TERMS),
}) satisfies z.ZodType<PaneKeytermReads>;

// Checked again where the Shell uses it (`sanitizeDictionary`), so only its
// size is held here.
const VocabularySchema = z.array(z.unknown()).max(MAX_PANE_VOCABULARY);

const CommandTargetSchema = z.object({
  agentId: z.enum(BUILT_IN_AGENT_IDS),
  agentName: z.string().min(1).max(MAX_ID_LENGTH),
  isAssistant: z.boolean(),
  vocabulary: z.object({
    entries: z
      .array(
        z.object({
          token: z.string().min(1).max(MAX_ID_LENGTH),
          prefix: z.string().min(1).max(MAX_ID_LENGTH),
          spokenName: z.string().max(MAX_ID_LENGTH),
          key: z.string().max(MAX_ID_LENGTH),
          scope: z.enum(["built-in", "global", "user", "project"]),
          kind: z.enum(["command", "skill", "app", "plugin"]).optional(),
          description: text,
        })
      )
      .max(MAX_PANE_COMMANDS),
    prefixes: z
      .array(
        z.object({
          prefix: z.string().min(1).max(MAX_ID_LENGTH),
          spoken: z.array(z.array(z.string().max(64)).max(16)).max(16),
        })
      )
      .max(32),
  }),
}) satisfies z.ZodType<VoiceCommandTarget>;

export const VoicePaneStartResultSchema = z.object({
  projectName: text.nullable(),
  vocabulary: VocabularySchema,
  names: NamesSchema,
  keyterms: KeytermReadsSchema,
  commandTarget: CommandTargetSchema.nullable(),
});

const AGENT_STATES = [
  "idle",
  "working",
  "waiting",
  "directing",
  "completed",
  "exited",
] as const satisfies readonly AgentState[];
const WAITING_REASONS = [
  "prompt",
  "question",
  "approval",
  "error",
] as const satisfies readonly WaitingReason[];
const StampSchema = z.number().int().positive().nullable();

const AgentReplySchema = z.object({
  text: z.string().min(1).max(MAX_CORRECTION_REPLY_CHARS),
  truncated: z.boolean(),
  recordedAt: StampSchema,
  newerRecordsFollow: z.boolean(),
  observedState: z
    .object({
      state: z.enum(AGENT_STATES),
      waitingReason: z.enum(WAITING_REASONS).optional(),
      lastStateChangeAt: StampSchema,
    })
    .optional(),
}) satisfies z.ZodType<VoiceAgentReply>;

export const VoicePaneCorrectionResultSchema = z.object({
  project: ProjectInfoSchema,
  vocabulary: VocabularySchema,
  commandTarget: CommandTargetSchema.nullable(),
  // Bounded lines joined by newlines: the character bound plus their breaks.
  terminalOutput: z
    .string()
    .max(MAX_CORRECTION_TERMINAL_CHARS * 2)
    .nullable(),
  // A host from before #14900 sends none, and one out of shape costs only
  // itself, never the rest of the answer.
  agentReply: AgentReplySchema.optional().catch(undefined),
});

export const VoicePaneFilesResultSchema = z.object({
  candidates: z.array(z.array(text).max(FILE_LINK_CANDIDATE_LIMIT)).max(MAX_PANE_FILE_DESCRIPTIONS),
});

export const VoicePaneProjectResultSchema = z.object({ project: ProjectInfoSchema });

// A term too long for the schema would fail the whole answer, and none that
// long is ever said aloud.
function fitTerms(terms: readonly string[]): string[] {
  return terms.filter((term) => term.length <= MAX_TEXT_LENGTH).slice(0, MAX_PANE_TERMS);
}

/** What a host sends, cut to what the Shell accepts. */
export function fitPaneStart(context: PaneStartContext): PaneStartContext {
  const { branchName } = context.keyterms;
  return {
    ...context,
    vocabulary: newestVocabulary(context.vocabulary),
    names: {
      hosts: fitTerms(context.names.hosts),
      projects: fitTerms(context.names.projects),
      worktrees: fitTerms(context.names.worktrees),
    },
    keyterms: {
      repoNames: fitTerms(context.keyterms.repoNames),
      branchName: branchName && branchName.length <= MAX_TEXT_LENGTH ? branchName : null,
      terminalTerms: fitTerms(context.keyterms.terminalTerms),
    },
    commandTarget: fitCommandTarget(context.commandTarget),
  };
}

export function fitPaneCorrection(context: PaneCorrectionContext): PaneCorrectionContext {
  return {
    ...context,
    vocabulary: newestVocabulary(context.vocabulary),
    commandTarget: fitCommandTarget(context.commandTarget),
  };
}

// Oldest first, and the newest terms count most.
function newestVocabulary<T>(vocabulary: readonly T[]): T[] {
  return vocabulary.slice(-MAX_PANE_VOCABULARY);
}

function fitCommandTarget(target: VoiceCommandTarget | null): VoiceCommandTarget | null {
  if (!target) return null;
  return {
    ...target,
    vocabulary: {
      ...target.vocabulary,
      // Most likely first, so the cut drops the least likely. A command whose
      // name runs past the wire's limits is left out, since cutting it would
      // write a command that doesn't exist; a long description is cut.
      entries: target.vocabulary.entries
        .filter((entry) =>
          [entry.token, entry.prefix, entry.spokenName, entry.key].every(
            (field) => field.length <= MAX_ID_LENGTH
          )
        )
        .slice(0, MAX_PANE_COMMANDS)
        .map((entry) =>
          entry.description.length > MAX_TEXT_LENGTH
            ? { ...entry, description: entry.description.slice(0, MAX_TEXT_LENGTH) }
            : entry
        ),
    },
  };
}
