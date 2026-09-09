import type { ActionCallbacks, ActionRegistry } from "../actionTypes";
import { z } from "zod";
import { usePanelStore } from "@/store/panelStore";
import {
  MAX_CLIENT_METADATA_BYTES,
  MAX_CLIENT_METADATA_DEPTH,
  type ClientMetadataRejection,
} from "@shared/utils/mcpClientMetadata";

/**
 * Why the host refused a client-metadata write, in the caller's terms.
 *
 * A rejection is thrown rather than reported in the result, matching the
 * neighbouring terminal mutations (`terminal.sendCommand` throws for a missing
 * or unusable target). The distinction that matters to a client is between "the
 * record is now what I asked for" and "it is not", and a `{ ok: false }` body a
 * model has to inspect is the shape most likely to be read as success.
 */
const REJECTION_MESSAGES: Record<ClientMetadataRejection, string> = {
  "not-found": "Terminal not found",
  "not-eligible":
    "Client metadata attaches to open terminals only — not to plugin-owned or tooling-internal panels",
  "invalid-json": "Client metadata must be a JSON object: no cycles, BigInts or custom toJSON",
  "too-deep": `Client metadata nests deeper than ${MAX_CLIENT_METADATA_DEPTH} levels`,
  "metadata-too-large": `Client metadata exceeds ${MAX_CLIENT_METADATA_BYTES} bytes of JSON`,
  "state-too-large": "The terminal's stored state is full; delete or shrink its client metadata",
};

export function registerTerminalMetaActions(
  actions: ActionRegistry,
  _callbacks: ActionCallbacks
): void {
  actions.set("terminal.setClientMetadata", () => ({
    id: "terminal.setClientMetadata",
    title: "Set Terminal Client Metadata",
    description:
      "Attach your own small JSON record to a terminal, so a reconnecting client can tell which panel is which instead of keeping a sidecar that goes stale. It outlives your connection, survives a restart, and is deleted with the panel. Read it back from the terminal listing; null clears it. Shared namespace: every external client sees the same record, and it confers no ownership.",
    category: "terminal",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    // A hidden bag no surface renders, so there is nothing for a user picking
    // this from the palette to see happen — and it needs a terminal id the
    // palette's empty-args dispatch cannot supply.
    palette: { mode: "hidden" },
    // Replaying `action.repeatLast` would rewrite whatever the last caller
    // stored onto whatever terminal is focused now.
    nonRepeatable: true,
    // Plugins already own this bag through `PanelViewProps`, on their own
    // panels and with arbitrary keys. Routing them through the external
    // caller's reserved key would only let them reach panels their own write
    // path deliberately cannot.
    denyPluginDispatch: true,
    mcpAnnotations: {
      readOnlyHint: false,
      destructiveHint: false,
      // Same value in, same state out: the record is replaced wholesale.
      idempotentHint: true,
      openWorldHint: false,
    },
    argsSchema: z
      .object({
        terminalId: z
          .string()
          .min(1)
          .describe(
            "Identifies the terminal to annotate, using a panel id from the terminal-listing capability."
          ),
        clientMetadata: z
          .record(z.string(), z.unknown())
          .nullable()
          .describe(
            `Replaces the whole record — send every key you want kept, not a patch. Max ${MAX_CLIENT_METADATA_BYTES} bytes of JSON, ${MAX_CLIENT_METADATA_DEPTH} deep. Null deletes it. Namespace your keys: this is shared.`
          ),
      })
      .strict(),
    examples: [
      {
        args: { terminalId: "term-abc123", clientMetadata: { session: "gc-42", role: "reviewer" } },
        description: "Record which of your logical sessions a terminal belongs to",
      },
      {
        args: { terminalId: "term-abc123", clientMetadata: null },
        description: "Clear the record you stored against a terminal",
      },
    ],
    // Top-level object with both fields required and non-nullable:
    // `buildToolOutputSchema` forwards a manifest schema only when its JSON
    // Schema has `type === "object"`, and zod renders a nullable or optional
    // root as an `anyOf` with no `type`, which silently disables
    // `mcpOutputSchema` (#11547).
    resultSchema: z.object({
      terminalId: z.string(),
      // False when the record already held this exact value — including a
      // delete of something already absent. The write succeeded either way.
      changed: z.boolean(),
    }),
    mcpOutputSchema: true,
    run: async (args: unknown) => {
      const { terminalId, clientMetadata } = args as {
        terminalId: string;
        clientMetadata: Record<string, unknown> | null;
      };

      const outcome = usePanelStore.getState().setPanelClientMetadata(terminalId, clientMetadata);
      if (!outcome.ok) throw new Error(REJECTION_MESSAGES[outcome.reason]);

      return { terminalId, changed: outcome.changed };
    },
  }));
}
