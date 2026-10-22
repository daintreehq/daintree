/**
 * `contributes.contextProviders` (#13795): a plugin claims a short `@` prefix
 * in the agent composer. Typing `@{prefix}:` lists the provider's matches;
 * picking one leaves an `@{prefix}:{id}` chip that the host resolves when the
 * user sends, so the agent gets the item's content as it reads then.
 */

/** One `contributes.contextProviders` manifest entry. */
export interface ContextProviderContribution {
  /** Bare id, unique within the plugin; `host.registerContextProvider` binds to it. */
  id: string;
  /**
   * The word typed after `@`, e.g. `rec` for `@rec:`. One to sixteen lowercase
   * letters, never `diff`, `terminal` or `selection`. A prefix another visible
   * plugin already holds is refused for the later one.
   */
  prefix: string;
  /** What the provider offers, e.g. "Records". Shown on its chips and in settings. */
  label: string;
}

/** The descriptor `host.registerContextProvider` binds an impl to. */
export interface ContextProviderDescriptor {
  /** Must match a `contributes.contextProviders` entry's `id`. */
  id: string;
}

/** One match a provider offers for what the user typed after its prefix. */
export interface ContextProviderItem {
  /**
   * Opaque reference the host hands back to `resolve`. One to 128 characters
   * from letters, digits and `_ - . : / # ~ + =`, not ending in `.` or `:`, so
   * it reads as one token in the draft.
   */
  id: string;
  /** The row's name in the `@` menu and on the chip. */
  label: string;
  /** Dimmed second line in the `@` menu. */
  description?: string;
}

/** What an item reads as when the user sends. */
export interface ContextProviderContent {
  /** The content itself, at most 32,768 characters. */
  text: string;
  /** Heading shown above the text; the chip's label when absent. */
  title?: string;
}

export interface ContextProviderCallOptions {
  /** Aborted when the host stops waiting for the answer, at its deadline. */
  signal: AbortSignal;
}

/**
 * The runtime half of a context provider. Both methods are asked by the host,
 * never by the draft: `search` sees only what the user typed after the
 * provider's own prefix, and `resolve` only the id of an item the user picked.
 */
export interface ContextProviderImpl {
  /** Matches for `query`, best first. The host shows at most 50. */
  search(query: string, options: ContextProviderCallOptions): Promise<ContextProviderItem[]>;
  /** The item's current content, or `null` when it no longer exists. */
  resolve(
    itemId: string,
    options: ContextProviderCallOptions
  ): Promise<ContextProviderContent | null>;
}

/** Whether a provider's prefix is on offer in a project. */
export type ContextProviderStatus = "active" | "refused" | "off";

/** One provider as a project's composer and settings see it. */
export interface ContextProviderEntry {
  pluginId: string;
  pluginName: string;
  providerId: string;
  prefix: string;
  label: string;
  /** `project` for a project plugin, whose switch applies to its own project only. */
  scope: "global" | "project";
  status: ContextProviderStatus;
  /** For a refused provider: the plugin whose provider holds the prefix. */
  heldBy?: { pluginId: string; pluginName: string };
}

/** An `@{prefix}:{id}` reference as the draft carries it. */
export interface ContextReference {
  prefix: string;
  id: string;
}

export type ContextReferenceResolution =
  | {
      status: "resolved";
      pluginId: string;
      pluginName: string;
      text: string;
      title?: string;
    }
  | { status: "failed"; pluginId: string; pluginName: string; reason: string }
  /** No provider in this project has the prefix: the token goes as typed. */
  | { status: "unknown" };
