import type {
  ContextReference,
  ContextReferenceResolution,
} from "@shared/types/pluginContextProvider";
import { formatAgentContextBlock } from "@shared/utils/agentContextDrag";
import {
  formatContextReference,
  type ContextReferenceToken,
} from "@shared/utils/pluginContextReference";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import { contextReferenceLabel } from "@/lib/contextReferenceLabels";
import type { TokenExpansion } from "./hybridInputParsing";

/**
 * Main bounds every provider at five seconds; this is the backstop for main
 * itself not answering, so a send can never wait on a plugin indefinitely.
 */
export const CONTEXT_RESOLVE_SEND_TIMEOUT_MS = 8_000;

/**
 * The expansions a draft's plugin context references (#13795) become at send,
 * read now rather than when they were picked. Each resolved item is the same
 * literal `daintree-context` block a hand-off drafts, headed by the plugin's
 * name, so nothing inside it is read as an `@` token; a failure is a visible
 * placeholder in the token's place, as `@diff`'s is. A reference no provider
 * holds goes as typed.
 *
 * `pluginNameFor` names the provider this view believes holds a prefix. It
 * matters only when main can't be asked at all: those references get a
 * placeholder, and text that merely looks like one is left alone.
 */
export async function expandContextReferences(
  tokens: readonly ContextReferenceToken[],
  resolve: (references: ContextReference[]) => Promise<ContextReferenceResolution[]>,
  pluginNameFor: (prefix: string) => string | undefined,
  timeoutMs = CONTEXT_RESOLVE_SEND_TIMEOUT_MS
): Promise<TokenExpansion[]> {
  if (tokens.length === 0) return [];
  let results: ContextReferenceResolution[] = [];
  let unreachable: string | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    results = await Promise.race([
      resolve(tokens.map(({ prefix, id }) => ({ prefix, id }))),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("timed out")), timeoutMs);
      }),
    ]);
  } catch (err) {
    unreachable = formatErrorMessage(err, "plugins couldn't be reached");
  } finally {
    clearTimeout(timer);
  }

  const expansions: TokenExpansion[] = [];
  tokens.forEach((token, index) => {
    const reference = formatContextReference(token);
    const { start, end } = token;
    if (unreachable !== null) {
      const pluginName = pluginNameFor(token.prefix);
      if (pluginName === undefined) return;
      expansions.push({
        start,
        end,
        replacement: `[Couldn't attach ${reference} from ${pluginName}: ${unreachable}]`,
      });
      return;
    }
    const result = results[index];
    if (!result || result.status === "unknown") return;
    if (result.status === "failed") {
      expansions.push({
        start,
        end,
        replacement: `[Couldn't attach ${reference} from ${result.pluginName}: ${result.reason}]`,
      });
      return;
    }
    expansions.push({
      start,
      end,
      block: true,
      replacement: formatAgentContextBlock({
        text: result.text,
        title: result.title ?? contextReferenceLabel(result.pluginId, token) ?? reference,
        sourceLabel: result.pluginName,
      }),
    });
  });
  return expansions;
}
