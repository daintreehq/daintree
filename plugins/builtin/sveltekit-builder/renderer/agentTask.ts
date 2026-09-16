import type { AgentState } from "@shared/types/agent";
import type { TerminalSubmissionPhase } from "@shared/types/terminalSubmission";
import type { SiteSelection } from "../shared/model.js";

/**
 * The context an agent task carries. Everything here is observed or resolved
 * source identity — never a conclusion the Inspector drew — so an agent reading
 * it can check each claim against the files itself.
 */
export interface AgentTaskContext {
  instruction: string;
  selection: SiteSelection;
  /** Worktree-relative file that owns the element's markup, when known. */
  file: string | null;
  worktreePath: string | null;
  excerpt: { text: string; firstLine: number } | null;
  /** Which of {@link taskScopes} the request is about. Defaults to the element. */
  scope?: TaskScope;
}

/**
 * What a request is about: the clicked element, or one of the components
 * that contain it, innermost first. A component is named for the tag that
 * rendered it and located by the file it is written in — the file the next
 * level in holds its call site.
 */
export type TaskScope =
  | { kind: "element"; label: string }
  | {
      kind: "component";
      label: string;
      /** App-relative file the component is written in. */
      file: string;
      /** Where it is used, when a call site outside generated code is known. */
      usedAt: { file: string; line: number } | null;
    };

export function taskScopes(selection: SiteSelection): TaskScope[] {
  const node = selection.nodes[0];
  const definition = node?.definition;
  if (!node || !definition) return [];
  const scopes: TaskScope[] = [{ kind: "element", label: node.label || definition.tagName }];
  let file = definition.location.file;
  for (const entry of node.ancestry) {
    if (entry.kind !== "component") continue;
    if (entry.generated) break;
    scopes.push({
      kind: "component",
      label: entry.componentTag ?? componentName(file),
      file,
      usedAt: { file: entry.location.file, line: entry.location.line },
    });
    file = entry.location.file;
  }
  // The outermost user file is itself a component — a route page or layout
  // rendered by generated code, so it has no call site of its own.
  scopes.push({ kind: "component", label: componentName(file), file, usedAt: null });
  return scopes;
}

function componentName(file: string): string {
  const base = file.slice(file.lastIndexOf("/") + 1);
  return base.startsWith("+") ? base : base.replace(/\.svelte$/, "");
}

/** An agent terminal the task can be delivered to. */
export interface AgentTarget {
  terminalId: string;
  title: string;
  agentState: AgentState | null;
}

export const MAX_INSTRUCTION_CHARS = 4000;

export function buildAgentTaskPrompt(context: AgentTaskContext): string {
  const { selection, file, worktreePath, excerpt } = context;
  // App-relative paths from the page map onto the worktree the same way the
  // owning file already did, so every path in the prompt is worktree-relative.
  const appPrefix =
    file &&
    selection.nodes[0]?.definition &&
    file.endsWith(selection.nodes[0].definition.location.file)
      ? file.slice(0, file.length - selection.nodes[0].definition.location.file.length)
      : "";
  const inWorktree = (appRelative: string) => `${appPrefix}${appRelative}`;
  const node = selection.nodes[0];
  const definition = node?.definition ?? null;
  const lines: string[] = [];

  lines.push(context.instruction.trim());
  lines.push("");
  lines.push("Context from the Daintree Site Builder:");
  if (worktreePath) lines.push(`- Worktree: ${worktreePath}`);
  lines.push(
    `- Page: ${selection.displayedUrl}${selection.routeId ? ` (route ${selection.routeId})` : ""}`
  );
  lines.push(`- Viewport: ${selection.viewport.width}×${selection.viewport.height}`);
  const scope = context.scope;
  if (scope?.kind === "component") {
    const used = scope.usedAt
      ? `, used at ${inWorktree(scope.usedAt.file)}:${scope.usedAt.line}`
      : "";
    lines.push(`- Target: the ${scope.label} component (${inWorktree(scope.file)}${used})`);
    lines.push("- Picked by clicking this element inside it:");
  }
  if (node) {
    lines.push(`- Selected element: ${node.label || definition?.tagName || "unknown element"}`);
  }
  if (definition) {
    const location = `${file ?? definition.location.file}:${definition.location.line}:${definition.location.column + 1}`;
    lines.push(`- Source: <${definition.tagName}> at ${location}`);
    if (definition.renderedOccurrences > 1) {
      lines.push(
        `- This markup renders ${definition.renderedOccurrences} copies on the page; changing it changes all of them`
      );
    }
  } else {
    lines.push("- Source: not traced — find the markup from the page and element above");
  }
  const components = (node?.ancestry ?? [])
    .filter((entry) => entry.kind === "component" && !entry.generated)
    .map(
      (entry) =>
        `${entry.componentTag ?? "component"} (${inWorktree(entry.location.file)}:${entry.location.line})`
    );
  if (components.length > 0) lines.push(`- Rendered inside: ${components.join(" ← ")}`);
  if (node?.surfaces.classes) {
    lines.push(`- Current classes: ${node.surfaces.classes.tokens.join(" ") || "(none)"}`);
  }
  if (node?.surfaces.text) lines.push(`- Current text: ${JSON.stringify(node.surfaces.text.text)}`);
  // Every selected element goes out, not just the first: "make these match"
  // is meaningless with one of them missing.
  for (const other of selection.nodes.slice(1)) {
    const where = other.definition
      ? `${inWorktree(other.definition.location.file)}:${other.definition.location.line}:${other.definition.location.column + 1}`
      : "source not traced";
    lines.push(
      `- Also selected: ${other.label || other.definition?.tagName || "element"} (${where})`
    );
  }

  if (excerpt && definition) {
    const lastLine = excerpt.firstLine + excerpt.text.split("\n").length - 1;
    lines.push("");
    lines.push(
      `Source around it (${file ?? definition.location.file}, lines ${excerpt.firstLine}–${lastLine}):`
    );
    lines.push("```svelte");
    lines.push(excerpt.text);
    lines.push("```");
  }

  lines.push("");
  lines.push(
    scope?.kind === "component"
      ? `Keep the change inside the ${scope.label} component unless the request needs more. If it needs a wider change, say so and name what else you touched.`
      : "Keep the change to this element unless the request needs more. If it needs a wider change, say so and name what else you touched."
  );
  return lines.join("\n");
}

/** Agents that are mid-turn must not receive a second prompt on top of it. */
export function isAgentBusy(state: AgentState | null): boolean {
  return state === "working" || state === "directing";
}

export type DeliveryState =
  | { status: "sending" }
  | { status: "sent" }
  | { status: "unconfirmed" }
  | { status: "failed"; message: string };

/**
 * Only `pty_written` is evidence the prompt reached the agent's terminal. Every
 * other outcome is reported as what it is rather than rounded up to "sent".
 */
export function deliveryFromPhase(phase: TerminalSubmissionPhase | null): DeliveryState | null {
  switch (phase) {
    case "pty_written":
      return { status: "sent" };
    // Part of the prompt may already sit in the agent's input, so neither of
    // these says resending is safe.
    case "failed":
      return { status: "failed", message: "The terminal didn't accept the whole prompt" };
    case "cancelled":
      return { status: "failed", message: "Sending was stopped before the prompt finished" };
    case "queued":
    case "writing":
    case null:
      return null;
    case "unknown":
      return { status: "unconfirmed" };
  }
}
