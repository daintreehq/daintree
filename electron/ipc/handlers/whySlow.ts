import { z } from "zod";
import { defineIpcNamespace, op, opValidated } from "../define.js";
import type { HandlerDependencies } from "../types.js";
import type { WhySlowSnapshot } from "../../../shared/types/whySlow.js";
import type { CompositeMemorySnapshot } from "../../../shared/types/memoryAccounting.js";
import { WHY_SLOW_METHOD_CHANNELS } from "./whySlow.preload.js";
import { collectWhySlowSnapshot } from "../../services/DiagnosticsCollector.js";
import { getCompositeMemorySnapshot } from "../../services/memoryAccounting.js";
import { recordRendererTerminalDiagnostics } from "../../services/RendererTerminalDiagnosticsCache.js";

// Renderer-pushed terminal-rendering state (#10910). Bounded so a compromised
// or buggy renderer can't grow the tier map without limit; the webContents id is
// taken from the IPC context, never from the renderer-supplied payload.
// The renderer buckets by a fixed TerminalRefreshTier enum (4 tiers today); cap
// generously so a buggy/hostile renderer can't balloon the cached map.
const MAX_TIER_KEYS = 32;

const REPORT_SCHEMA = z.object({
  webglMode: z.enum(["webgl", "dom"]),
  wantsWebgl: z.number().int().nonnegative().max(100_000),
  terminalCount: z.number().int().nonnegative().max(100_000),
  countsByTier: z
    .record(z.string().max(64), z.number().int().nonnegative().max(100_000))
    .refine((m) => Object.keys(m).length <= MAX_TIER_KEYS, {
      message: `countsByTier exceeds ${MAX_TIER_KEYS} keys`,
    }),
});

export function registerWhySlowHandlers(deps: HandlerDependencies): () => void {
  const namespace = defineIpcNamespace({
    name: "whySlow",
    ops: {
      // On-demand pull for the "why am I slow?" diagnostics dock.
      getWhySlowSnapshot: op(
        WHY_SLOW_METHOD_CHANNELS.getWhySlowSnapshot,
        async (): Promise<WhySlowSnapshot> => collectWhySlowSnapshot(deps)
      ),
      // Composite memory snapshot (Electron working-set + terminal descendant
      // RSS by project) for the resource badge popover. Reads go through
      // shared TTL caches, so popover-cadence polling stays cheap.
      getMemorySnapshot: op(
        WHY_SLOW_METHOD_CHANNELS.getMemorySnapshot,
        async (): Promise<CompositeMemorySnapshot> =>
          getCompositeMemorySnapshot(deps.ptyClient ?? null)
      ),
      // Fire-and-forget renderer push: cache the sender's terminal WebGL/tier
      // state by webContents id. Ignored once the sender is torn down, mirroring
      // the SYSTEM_REPORT_RENDERER_ELU intake.
      reportTerminalRendererDiagnostics: opValidated(
        WHY_SLOW_METHOD_CHANNELS.reportTerminalRendererDiagnostics,
        REPORT_SCHEMA,
        (ctx, payload): void => {
          if (ctx.event.sender.isDestroyed()) return;
          recordRendererTerminalDiagnostics(ctx.webContentsId, payload);
        },
        { withContext: true }
      ),
    },
  });

  return namespace.register();
}
