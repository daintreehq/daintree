import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { load } from "js-yaml";
import { parse as parseToml } from "smol-toml";
import { getEffectiveAgentConfig } from "../../shared/config/agentRegistry.js";
import type {
  CapabilityGetRequest,
  CapabilityGetResult,
  CapabilitySearchRequest,
  CapabilitySearchResult,
  CapabilitySummary,
} from "../../shared/types/agentCapabilities.js";
import { CompletionDiscoveryEngine } from "./completions/CompletionDiscoveryEngine.js";
import { resolveProjectRoot } from "./completions/completionPathTemplates.js";

const SOURCE_LIMIT = 256 * 1024;
const PAGE_SIZE = 6000;
const fingerprint = (value: string) => createHash("sha256").update(value).digest("hex");

export class AgentCapabilityService {
  constructor(private readonly engine = new CompletionDiscoveryEngine()) {}

  private async catalog(agentId: string, worktreePath: string, refresh: boolean) {
    if (!path.isAbsolute(worktreePath)) throw new Error("An absolute worktreePath is required");
    if (!(await fs.stat(worktreePath)).isDirectory())
      throw new Error("Worktree is not a directory");
    const root = await resolveProjectRoot(worktreePath);
    const context = { agentId, worktreePath: root };
    const config = getEffectiveAgentConfig(agentId);
    const snapshot = await this.engine.discover(agentId, root, refresh);
    const warnings = [...snapshot.warnings];
    const supported = Boolean(config?.completionSources?.length);
    warnings.push(
      supported
        ? "Local declared sources only; built-in commands, session reload state, and startup invocation support are not verified against the running CLI."
        : "This agent has no declared discovery adapter; an empty result does not mean it has no capabilities."
    );
    if (agentId === "codex")
      warnings.push("Server-resolved apps are not available from local discovery.");
    if (agentId === "claude")
      warnings.push("Plugin and remotely supplied skills may be absent from local discovery.");

    const revisions: string[] = [];
    const sourceStamps = new Map<string, string>();
    const items: CapabilitySummary[] = [];
    // Stable ordering makes pagination and revision checks independent of scan timing.
    for (const command of snapshot.commands) {
      const identity = JSON.stringify([agentId, root, command.id, command.sourcePath ?? "builtin"]);
      let revision = "builtin";
      if (command.sourcePath) {
        try {
          const stat = await fs.stat(command.sourcePath);
          revision = `${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
        } catch {
          warnings.push(`Source disappeared or is unreadable: ${command.sourcePath}`);
          continue;
        }
      }
      const item: CapabilitySummary = {
        ...command,
        id: `cap_${fingerprint(identity).slice(0, 32)}`,
        label: command.label.slice(0, 256),
        description: command.description.slice(0, 500),
        kind: command.kind ?? "command",
        insertText: command.insertText ?? command.label,
        trigger: command.trigger ?? "/",
        aliases: command.aliases ? [...command.aliases] : undefined,
      };
      items.push(item);
      sourceStamps.set(item.id, revision);
      revisions.push(JSON.stringify([item, revision]));
    }
    return {
      context,
      catalogRevision: fingerprint(JSON.stringify([context, revisions, warnings])),
      coverage: supported ? ("partial" as const) : ("unsupported" as const),
      warnings: warnings.slice(0, 50),
      items,
      sourceStamps,
    };
  }

  async search(request: CapabilitySearchRequest): Promise<CapabilitySearchResult> {
    const catalog = await this.catalog(
      request.agentId,
      request.worktreePath,
      request.refresh ?? false
    );
    const query = request.query.trim().toLowerCase();
    const terms = query.split(/\s+/).filter(Boolean);
    const matches = catalog.items
      .flatMap((item) => {
        if (request.kinds?.length && !request.kinds.includes(item.kind)) return [];
        const names = [item.insertText, item.label, ...(item.aliases ?? [])].map((s) =>
          s.toLowerCase()
        );
        const haystack = `${names.join(" ")} ${item.description.toLowerCase()}`;
        if (!terms.every((term) => haystack.includes(term))) return [];
        const score = names.includes(query)
          ? 0
          : names.some((name) => name.includes(query))
            ? 1
            : 2;
        return [{ item, score }];
      })
      .sort(
        (a, b) =>
          a.score - b.score ||
          a.item.label.localeCompare(b.item.label) ||
          a.item.id.localeCompare(b.item.id)
      );
    const queryKey = fingerprint(JSON.stringify([query, request.kinds ?? []])).slice(0, 16);
    let offset = 0;
    if (request.cursor) {
      const parts = request.cursor.split(":");
      if (
        parts.length !== 3 ||
        parts[0] !== catalog.catalogRevision ||
        parts[1] !== queryKey ||
        !/^\d+$/.test(parts[2]!)
      ) {
        throw new Error("Catalog or query changed; repeat the search without a cursor");
      }
      offset = Number(parts[2]);
      if (!Number.isSafeInteger(offset) || offset > matches.length)
        throw new Error("Invalid search cursor");
    }
    const end = Math.min(offset + (request.limit ?? 10), matches.length);
    return {
      context: catalog.context,
      catalogRevision: catalog.catalogRevision,
      coverage: catalog.coverage,
      warnings: catalog.warnings,
      items: matches.slice(offset, end).map(({ item }) => item),
      total: matches.length,
      nextCursor:
        end < matches.length ? `${catalog.catalogRevision}:${queryKey}:${end}` : undefined,
    };
  }

  async get(request: CapabilityGetRequest): Promise<CapabilityGetResult> {
    // Always resolve the source again: a saved id is not permission to read an arbitrary path.
    const catalog = await this.catalog(request.agentId, request.worktreePath, true);
    if (request.catalogRevision && request.catalogRevision !== catalog.catalogRevision) {
      throw new Error("Catalog changed; search again before invoking this capability");
    }
    const capability = catalog.items.find((item) => item.id === request.id);
    if (!capability)
      throw new Error("Capability is unavailable in this agent/worktree; search again");
    let text = capability.description;
    let oversized = false;
    let sourceStamp = "builtin";
    // Plugin manifests can contain configuration; only their catalog metadata is exposed.
    if (capability.sourcePath && capability.kind !== "plugin") {
      const handle = await fs.open(capability.sourcePath, "r");
      try {
        const before = await handle.stat();
        if (!before.isFile()) throw new Error("Capability source is not a regular file");
        if (
          `${before.size}:${before.mtimeMs}:${before.ctimeMs}` !==
          catalog.sourceStamps.get(capability.id)
        )
          throw new Error("Source changed after discovery; search again");
        const buffer = Buffer.alloc(Math.min(before.size, SOURCE_LIMIT));
        let bytesRead = 0;
        while (bytesRead < buffer.length) {
          const chunk = await handle.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
          if (chunk.bytesRead === 0) break;
          bytesRead += chunk.bytesRead;
        }
        const after = await handle.stat();
        if (
          before.mtimeMs !== after.mtimeMs ||
          before.size !== after.size ||
          before.ctimeMs !== after.ctimeMs
        )
          throw new Error("Source changed while reading; retry discovery");
        text = buffer.subarray(0, bytesRead).toString("utf8");
        oversized = before.size > bytesRead;
        sourceStamp = `${after.size}:${after.mtimeMs}:${after.ctimeMs}`;
      } finally {
        await handle.close();
      }
    }
    const sourceRevision = fingerprint(JSON.stringify([capability.id, sourceStamp, text]));
    if (request.sourceRevision && request.sourceRevision !== sourceRevision)
      throw new Error("Source changed; restart the detail read");
    const offset = request.offset ?? 0;
    if (offset > 0 && !request.sourceRevision)
      throw new Error("sourceRevision is required when paging instructions");
    if (offset > text.length) throw new Error("Invalid instruction offset");
    const end = Math.min(offset + PAGE_SIZE, text.length);
    const warnings = [...catalog.warnings];
    if (oversized) warnings.push("Source exceeds the bounded read; instructions are incomplete.");
    const argumentHint = this.argumentHint(text, capability.sourcePath, warnings);
    return {
      context: catalog.context,
      catalogRevision: catalog.catalogRevision,
      coverage: catalog.coverage,
      warnings,
      capability,
      invocation: {
        token: capability.insertText,
        channel: capability.trigger === "/" ? "interactive-command" : "prompt-reference",
        argumentHint,
        startupSupport: "unverified",
        requiresTask: capability.kind === "plugin" || capability.kind === "app",
      },
      sourceRevision,
      instructions: text.slice(offset, end),
      nextOffset: end < text.length ? end : undefined,
      truncated: oversized || end < text.length,
    };
  }

  private argumentHint(
    text: string,
    sourcePath: string | undefined,
    warnings: string[]
  ): string | undefined {
    try {
      const normalized = text.replace(/^\uFEFF/, "");
      const frontmatter = normalized.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
      const metadata = sourcePath?.endsWith(".toml")
        ? parseToml(text)
        : frontmatter
          ? load(frontmatter[1]!)
          : undefined;
      if (metadata && typeof metadata === "object" && "argument-hint" in metadata) {
        const hint = metadata["argument-hint"];
        if (typeof hint === "string") return hint.slice(0, 1000);
      }
    } catch {
      warnings.push(
        "Could not parse argument metadata; consult the source instructions instead of guessing arguments."
      );
    }
    return undefined;
  }
}

export const agentCapabilityService = new AgentCapabilityService();
