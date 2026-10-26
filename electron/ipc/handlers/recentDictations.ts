import { z } from "zod";
import { defineIpcNamespace, op } from "../define.js";
import { CHANNELS } from "../channels.js";
import { ValidationError } from "../validationError.js";
import { getAllAppWebContents } from "../../window/webContentsRegistry.js";
import { RECENT_DICTATIONS_METHOD_CHANNELS } from "./recentDictations.preload.js";
import { MAX_RECENT_DICTATIONS, type RecentDictation } from "../../../shared/types/voice.js";

const TEXT_MAX = 200_000;
const LABEL_MAX = 2_000;

const label = z.string().max(LABEL_MAX);
const id = z.string().min(1).max(200);

const dictationSchema = z.object({
  id,
  rawText: z.string().min(1).max(TEXT_MAX),
  correctedText: z.string().max(TEXT_MAX).nullable(),
  target: z.object({
    panelId: label.min(1),
    panelTitle: label.optional(),
    projectId: label.optional(),
    projectName: label.optional(),
    worktreeId: label.optional(),
    worktreeLabel: label.optional(),
  }),
  endedAt: z.number().finite(),
});

const correctionSchema = z.object({ id, correctedText: z.string().max(TEXT_MAX) });

/**
 * The app session's recent dictations, newest first (#14637). Held here rather
 * than in a renderer so they outlive a project view being released, and only
 * in memory: nothing writes them to disk, they leave with the process, and the
 * text is never logged.
 */
let dictations: RecentDictation[] = [];

/**
 * `opValidated` would log the Zod issues, and those can quote what was
 * dictated, so a bad payload is refused with the channel name alone.
 */
function parse<S extends z.ZodTypeAny>(channel: string, schema: S, payload: unknown): z.output<S> {
  const parsed = schema.safeParse(payload);
  if (!parsed.success) throw new ValidationError(channel);
  return parsed.data;
}

function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** Tells this machine's views to re-read the list. No text rides on it, and it never crosses a link. */
function announceChange(): void {
  for (const wc of getAllAppWebContents()) {
    if (wc.isDestroyed()) continue;
    try {
      wc.send(CHANNELS.RECENT_DICTATIONS_CHANGED);
    } catch {
      // A view mid-teardown re-reads when it next mounts.
    }
  }
}

/**
 * Adds a finished session, or updates it in place when the same session is
 * recorded again. A cleanup already settled on it survives a late re-record
 * without one.
 */
async function handleRecord(dictation: RecentDictation): Promise<void> {
  const entry = parse(RECENT_DICTATIONS_METHOD_CHANNELS.record, dictationSchema, dictation);
  const index = dictations.findIndex((d) => d.id === entry.id);
  if (index >= 0) {
    const current = dictations[index]!;
    dictations = dictations.map((d, i) =>
      i === index ? { ...entry, correctedText: entry.correctedText ?? current.correctedText } : d
    );
  } else {
    dictations = [entry, ...dictations].slice(0, MAX_RECENT_DICTATIONS);
  }
  announceChange();
}

/** Settles a session's cleanup. One that changed nothing but spacing is no second version. */
async function handleSetCorrectedText(update: {
  id: string;
  correctedText: string;
}): Promise<void> {
  const { id: entryId, correctedText } = parse(
    RECENT_DICTATIONS_METHOD_CHANNELS.setCorrectedText,
    correctionSchema,
    update
  );
  const current = dictations.find((d) => d.id === entryId);
  if (!current) return;
  const next =
    collapseWhitespace(correctedText) === collapseWhitespace(current.rawText)
      ? null
      : correctedText;
  if (current.correctedText === next) return;
  dictations = dictations.map((d) => (d.id === entryId ? { ...d, correctedText: next } : d));
  announceChange();
}

async function handleList(): Promise<RecentDictation[]> {
  return dictations;
}

export const recentDictationsNamespace = defineIpcNamespace({
  name: "recentDictations",
  ops: {
    record: op(RECENT_DICTATIONS_METHOD_CHANNELS.record, handleRecord),
    setCorrectedText: op(
      RECENT_DICTATIONS_METHOD_CHANNELS.setCorrectedText,
      handleSetCorrectedText
    ),
    list: op(RECENT_DICTATIONS_METHOD_CHANNELS.list, handleList),
  },
});

export function registerRecentDictationsHandlers(): () => void {
  const unregister = recentDictationsNamespace.register();
  return () => {
    unregister();
    dictations = [];
  };
}
