import { z } from "zod";
import type { PluginRendererMetricsReport } from "../../shared/types/pluginMetrics.js";

/**
 * Boundary schema for `plugin:report-view-metrics`. The renderer is not trusted
 * with main's accumulators, so lengths are capped at what the renderer registry
 * could legitimately hold, and every number is clamped into a sane range rather
 * than stored as sent.
 */

/** A single report's arrays; the renderer's own pending caps sit well inside these. */
export const MAX_REPORTED_VIEW_LOADS = 64;
export const MAX_REPORTED_COMMITS = 1_024;
export const MAX_REPORTED_LONG_FRAMES = 256;
/** Reports accepted from one message; the rest are dropped. */
export const MAX_REPORTS_PER_MESSAGE = 128;
/**
 * Array elements (view loads, commits, long frames) accepted across one whole
 * message, checked before any schema walk. A full renderer drain of every
 * tracked plugin is far below this; a message above it is dropped outright.
 */
export const MAX_ELEMENTS_PER_MESSAGE = 16_384;

const MAX_DURATION_MS = 10 * 60_000;
const MAX_COUNT = 1_000_000;
const MAX_EPOCH_MS = 8_640_000_000_000_000;

const clamp = (max: number) => (value: number) => Math.min(max, Math.max(0, value));

const durationMs = z.number().transform(clamp(MAX_DURATION_MS));
const epochMs = z.number().transform(clamp(MAX_EPOCH_MS));
const count = z.number().transform((value) => Math.floor(clamp(MAX_COUNT)(value)));

const ViewLoadSampleSchema = z.object({
  kindId: z.string().min(1).max(256),
  activateMs: durationMs,
  importMs: durationMs,
  stylesMs: durationMs,
  firstPaintMs: durationMs,
  retry: z.boolean(),
  at: epochMs,
});

const LongFrameSchema = z.object({
  durationMs,
  blockingMs: durationMs,
  source: z.enum(["script", "commit"]),
  at: epochMs,
});

export const PluginRendererMetricsReportSchema = z.object({
  pluginId: z.string().min(1).max(256),
  viewLoads: z.array(ViewLoadSampleSchema).max(MAX_REPORTED_VIEW_LOADS),
  commitDurationsMs: z.array(durationMs).max(MAX_REPORTED_COMMITS),
  commitCount: count,
  longFramesDropped: z.object({
    count,
    blockingMs: z.number().transform(clamp(MAX_COUNT * MAX_DURATION_MS)),
  }),
  longFrames: z.array(LongFrameSchema).max(MAX_REPORTED_LONG_FRAMES),
}) satisfies z.ZodType<PluginRendererMetricsReport, unknown>;

/**
 * Parse one renderer message into the reports worth recording. A malformed
 * report is dropped on its own; the rest of the message still counts.
 */
export function parseRendererMetricsReports(payload: unknown): PluginRendererMetricsReport[] {
  if (!Array.isArray(payload)) return [];
  const limit = Math.min(payload.length, MAX_REPORTS_PER_MESSAGE);
  let elements = 0;
  for (let i = 0; i < limit; i++) {
    const item: unknown = payload[i];
    if (!item || typeof item !== "object") continue;
    for (const key of ["viewLoads", "commitDurationsMs", "longFrames"]) {
      const list: unknown = Reflect.get(item, key);
      if (Array.isArray(list)) elements += list.length;
    }
    if (elements > MAX_ELEMENTS_PER_MESSAGE) return [];
  }
  const out: PluginRendererMetricsReport[] = [];
  for (let i = 0; i < limit; i++) {
    const parsed = PluginRendererMetricsReportSchema.safeParse(payload[i]);
    if (parsed.success) out.push(parsed.data);
  }
  return out;
}
