import { useCallback, useRef, useState } from "react";
import { AlertTriangle, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { usePluginMcpConfirmStore } from "@/store/pluginMcpConfirmStore";
import { CapabilityRow } from "@/components/Plugin/capabilityMeta";
import type { BuiltInPluginCapability } from "@shared/types/plugin";
import type { PluginMcpConsentDecision, PluginMcpDangerTier } from "@shared/types/pluginMcpConsent";

const CONFIRM_COOLDOWN_MS = 1_200;

/**
 * Upper bound for the tool name interpolated into the dialog title. The name is
 * authored by the third party being approved, and an underscore-heavy MCP tool
 * name is one unbreakable token: past this length it pushes the title into the
 * close button and then off the card entirely. The full name is never lost —
 * it is always shown in full in the requester block below, which wraps.
 */
const MAX_TOOL_NAME_IN_TITLE = 32;

/**
 * Ceiling for the plugin-authored tool description. Unbounded, a long
 * description pushes the declared capabilities and the redacted arguments —
 * the two pieces of evidence the approval actually rests on — below the fold,
 * which hands the plugin control over how much of its own consent dialog is
 * its own marketing copy. Bound it and scroll in place; nothing is lost.
 */
const DESCRIPTION_MAX_HEIGHT = "max-h-[9rem]";

/** Shared micro-label, matching the section-heading grammar used app-wide. */
const MICRO_LABEL = "text-[11px] font-semibold uppercase tracking-wider text-daintree-text/60";

/**
 * Singleton dialog driven by the plugin-MCP consent queue. Mounted once near
 * the top of `App.tsx`, sibling to `PluginConfirmDialog` and `McpConfirmDialog`.
 *
 * Body order follows the ordering every permission surface converges on, and
 * matches the refined `McpConfirmDialog`: identity, then why this interrupted
 * you, then consequence, then evidence, then technical detail. The difference
 * from that sibling is what is being trusted. There, Daintree classifies its
 * own action and authors its own rationale. Here the tool name, the description
 * and the danger hints are all authored by the third party asking for
 * permission, so the host says what it can vouch for (the tier's practical
 * effect, and what the pin covers) and labels the plugin's own words as the
 * plugin's own words.
 *
 * Renders the tool description as a plain React text node (never as HTML or
 * Markdown). The description has already been ANSI/OSC-stripped in the main
 * process by `PluginMcpConsentService` — the renderer does no further
 * sanitisation and does not need to: React text-node interpolation escapes
 * by default, and the bytes the renderer holds are the display-safe form.
 *
 * For D2+ tiers, a redacted `argsSummary` (produced by `summarizeMcpArgs` in
 * main) appears below the description; raw call arguments are never sent
 * across IPC. That block stays expanded rather than moving behind a
 * disclosure: `docs/architecture/destructive-action-safeguards.md` records the
 * redacted summary as the content preview that satisfies this surface's D2
 * requirement, so collapsing it would weaken an audited safeguard. The
 * capability list is collapsed instead — it describes the plugin, not this
 * call, and is identical on every prompt the plugin ever raises.
 */
export function PluginMcpConfirmDialog() {
  const current = usePluginMcpConfirmStore((state) => state.current);
  const queueDepth = usePluginMcpConfirmStore((state) => state.queue.length);
  const resolveCurrent = usePluginMcpConfirmStore((state) => state.resolveCurrent);
  const resetKey = current?.requestId ?? "null";

  const handledRequestIdRef = useRef<string | null>(null);
  const resolveOnce = useCallback(
    (requestId: string, decision: PluginMcpConsentDecision) => {
      if (handledRequestIdRef.current === requestId) return;
      handledRequestIdRef.current = requestId;
      resolveCurrent(decision);
    },
    [resolveCurrent]
  );

  if (current === null) {
    return (
      <ErrorBoundary
        variant="component"
        componentName="PluginMcpConfirmDialog"
        resetKeys={[resetKey]}
      >
        <ConfirmDialog
          isOpen={false}
          title=""
          confirmLabel="Allow"
          onConfirm={() => {}}
          variant="default"
        />
      </ErrorBoundary>
    );
  }

  const isDestructive = current.dangerTier === "D2" || current.dangerTier === "D3";
  const variant = isDestructive ? "destructive" : "default";
  const showArgsPreview =
    current.dangerTier === "D2" || current.dangerTier === "D3" || current.argsSummary.length > 0;
  const isReprompt = current.reason !== "first-use" && current.reason !== "explicit-confirm";

  // The body carries a bounded, scrollable description plus structured
  // evidence, so it is a `dialog` rather than an `alertdialog` — APG reserves
  // the latter for a brief message a screen reader should read out whole.
  // Without this the destructive tiers, which are the ones that carry the most
  // content, were the ones getting the wrong role.
  const hasScrollableContent = showArgsPreview || current.declaredCapabilities.length > 0;

  return (
    <ErrorBoundary
      variant="component"
      componentName="PluginMcpConfirmDialog"
      resetKeys={[resetKey]}
    >
      <ConfirmDialog
        isOpen={true}
        onClose={() => resolveOnce(current.requestId, "rejected")}
        title={titleFor(current.reason, current.toolName)}
        description={consequenceFor(current.dangerTier)}
        confirmLabel="Allow and remember"
        cancelLabel="Reject"
        onConfirm={() => resolveOnce(current.requestId, "approved-and-pin")}
        variant={variant}
        hasPreview={hasScrollableContent}
        confirmCooldownMs={isDestructive ? CONFIRM_COOLDOWN_MS : undefined}
        cooldownKey={current.requestId}
        hint={<GateHint queueDepth={queueDepth} />}
      >
        <div className="space-y-3">
          <RequesterBlock
            pluginDisplayName={current.pluginDisplayName}
            serverId={current.serverId}
            toolName={current.toolName}
            tier={current.dangerTier}
          />

          {isReprompt && <ChangeNotice reason={current.reason} tier={current.dangerTier} />}

          <div>
            <div className={cn(MICRO_LABEL, "mb-1")}>What the plugin says this does</div>
            <p
              className={cn(
                "text-sm text-daintree-text/80 whitespace-pre-wrap break-words overflow-y-auto",
                DESCRIPTION_MAX_HEIGHT
              )}
            >
              {current.descriptionDisplay || "(no description provided)"}
            </p>
          </div>

          <CapabilitiesDisclosure capabilities={current.declaredCapabilities} />

          {showArgsPreview && (
            <div>
              <div className={cn(MICRO_LABEL, "mb-1")}>Arguments</div>
              <pre className="text-xs font-mono whitespace-pre-wrap break-words bg-overlay-subtle border border-tint/[0.08] rounded max-h-40 overflow-y-auto px-2 py-1.5 text-daintree-text/80">
                {current.argsSummary || "No arguments"}
              </pre>
            </div>
          )}
        </div>
      </ConfirmDialog>
    </ErrorBoundary>
  );
}

/**
 * Who is asking, as three labeled rows rather than one prose sentence.
 *
 * The plugin, its MCP server and the tool are three distinct third-party
 * identities, and the approval is a judgement about all three. Quoted inside a
 * sentence they had to be found by parsing grammar, and a hostile identifier
 * overflowed the card. Labeled rows give each a stable position the eye can
 * return to, and `min-w-0` + `break-all` keeps an unbreakable underscore run
 * inside the card instead of under the close button.
 *
 * `break-all` rather than `break-words` here specifically because these are
 * machine identifiers with no spaces — `break-words` only breaks a word that
 * cannot fit at all, which still leaves a 60-character token overhanging.
 */
function RequesterBlock({
  pluginDisplayName,
  serverId,
  toolName,
  tier,
}: {
  pluginDisplayName: string;
  serverId: string;
  toolName: string;
  tier: PluginMcpDangerTier;
}) {
  return (
    <div className="space-y-1.5">
      <IdentityRow label="Plugin" value={pluginDisplayName} />
      <IdentityRow label="MCP server" value={serverId} mono />
      <IdentityRow label="Tool" value={toolName} mono trailing={<DangerTierBadge tier={tier} />} />
    </div>
  );
}

function IdentityRow({
  label,
  value,
  mono = false,
  trailing,
}: {
  label: string;
  value: string;
  mono?: boolean;
  trailing?: React.ReactNode;
}) {
  return (
    <div className="flex items-baseline gap-2 text-xs">
      <span className={cn(MICRO_LABEL, "shrink-0 w-[5.5rem]")}>{label}</span>
      <span className="flex min-w-0 flex-1 items-baseline gap-2">
        <span
          className={cn("min-w-0 break-all text-daintree-text/85", mono && "font-mono text-[11px]")}
          title={value}
        >
          {value}
        </span>
        {trailing}
      </span>
    </div>
  );
}

/**
 * Why this interrupted you, when it is not the first time.
 *
 * This is the dialog's single toned block, and it is toned for the re-prompt
 * rather than for the tier because the re-prompt is the higher-stakes signal:
 * a first-use prompt that gets approved is the user's own decision, while a
 * re-prompt that reads like a first-use prompt is how a rug-pull gets waved
 * through. It carries an icon as well as a tone — under `forced-colors:
 * active` the destructive button's fill is replaced by a system colour and
 * stops distinguishing itself from Reject, and a bare amber phrase flattens to
 * the same black as everything around it, so the icon is the only part of the
 * signal that survives.
 *
 * `annotation-changed` gets danger tone rather than warning: it is the case
 * where the server raised the danger of something already pinned, which is the
 * one re-prompt a user must not read as routine.
 */
function ChangeNotice({ reason, tier }: { reason: string; tier: PluginMcpDangerTier }) {
  const isRaisedDanger = reason === "annotation-changed";
  const heading = changeHeadingFor(reason);
  if (heading === null) return null;

  return (
    <div
      className={cn(
        "flex items-start gap-2 rounded-[var(--radius-md)] p-3",
        isRaisedDanger
          ? "border border-status-danger/20 bg-status-danger/10"
          : "border border-status-warning/20 bg-status-warning/10"
      )}
    >
      <AlertTriangle
        aria-hidden="true"
        className={cn(
          "w-4 h-4 shrink-0 mt-px",
          isRaisedDanger ? "text-status-danger" : "text-status-warning"
        )}
      />
      <div className="min-w-0 space-y-1">
        <div
          className={cn(
            MICRO_LABEL,
            isRaisedDanger ? "text-status-danger/80" : "text-status-warning/80"
          )}
        >
          {heading}
        </div>
        <div className="text-xs text-daintree-text/80 break-words">
          {changeBodyFor(reason, tier)}
        </div>
      </div>
    </div>
  );
}

/**
 * The plugin's declared capabilities, collapsed.
 *
 * These describe the plugin, not this call — the same list renders on every
 * prompt that plugin ever raises, and it does not change between them. Left
 * expanded as twelve raw `fs:project-write`-style identifiers it was the
 * largest block on the surface and pushed the arguments, which are specific to
 * this call, below the fold. Collapsed it stays one keystroke away, and the
 * count in the trigger is the part that is actually worth scanning.
 *
 * Inside, `CapabilityRow` is the same component the Plugin Manager's
 * permissions tab and the archive-install confirm already use, so a capability
 * reads identically at install time, at consent time, and afterwards.
 */
function CapabilitiesDisclosure({
  capabilities,
}: {
  capabilities: readonly BuiltInPluginCapability[];
}) {
  const [expanded, setExpanded] = useState(false);

  if (capabilities.length === 0) {
    // Said, not omitted. A silently absent section is indistinguishable from a
    // section that failed to load, and "this plugin declares nothing" is a
    // meaningful thing to know before granting a standing permission.
    return <div className={MICRO_LABEL}>No capabilities declared</div>;
  }

  return (
    <div>
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
        className={cn(
          "flex w-full items-center gap-1.5 rounded-[var(--radius-sm)] py-1 text-left",
          "transition-colors duration-150 ease-out hover:bg-overlay-subtle",
          "focus-visible:outline focus-visible:outline-2 focus-visible:outline-daintree-accent focus-visible:-outline-offset-2"
        )}
      >
        <ChevronRight
          aria-hidden="true"
          className={cn(
            "w-3 h-3 shrink-0 text-daintree-text/40 transition-transform duration-150 ease-out",
            expanded && "rotate-90"
          )}
        />
        <span className={MICRO_LABEL}>What this plugin can do ({capabilities.length})</span>
      </button>
      {expanded && (
        <ul className="mt-1.5 max-h-44 space-y-1.5 overflow-y-auto pl-[1.125rem]">
          {capabilities.map((cap) => (
            <CapabilityRow key={cap} capability={cap} />
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * The subdued line beside the action row.
 *
 * The persistence scope lives here rather than in the body because this is
 * where the eye already is at the moment of commitment — a modal is read
 * title-first, then primary-button, and body copy is what a habituated reader
 * skips. "Allow and remember" is a standing grant that makes every future
 * matching call silent, and that is the single most under-communicated fact on
 * the surface, so it sits against the button that does it.
 *
 * Deliberately not a countdown. The destructive tiers disable the primary
 * button briefly, but a ticking clock on a security decision pushes the reader
 * toward impulsive rather than deliberative processing, so the condition is
 * stated and the seconds are not.
 */
function GateHint({ queueDepth }: { queueDepth: number }) {
  const parts = ["Remembered until this tool changes"];
  if (queueDepth > 0) {
    parts.push(`${queueDepth} more request${queueDepth === 1 ? "" : "s"} waiting`);
  }

  return (
    <span aria-live="polite" className="min-w-0 truncate">
      {parts.join(" · ")}
    </span>
  );
}

/**
 * Dialog title for a consent reason. Every re-prompt reason (the tool changed
 * since it was pinned, or was revoked) gets a distinct "review and re-approve"
 * framing so a user can tell a rug-pull re-prompt apart from a first-use one —
 * `annotation-changed` in particular must NOT fall through to the generic
 * first-use title, or a server raising a pinned tool's danger tier would be
 * indistinguishable from approving it for the first time. Exported for tests.
 */
export function titleFor(reason: string, toolName: string): string {
  const name = truncateToolName(toolName);
  switch (reason) {
    case "raw-changed":
      return `'${name}' has changed — review and re-approve?`;
    case "schema-changed":
      return `'${name}' inputs changed — review and re-approve?`;
    case "annotation-changed":
      return `'${name}' danger level changed — review and re-approve?`;
    case "revoked":
      return `'${name}' was previously revoked — allow again?`;
    case "first-use":
    default:
      return `Allow '${name}' to run?`;
  }
}

/**
 * Clamp a third-party tool name for the title. The full value always appears
 * in the requester block, so this truncation loses nothing — it stops an
 * unbreakable identifier from consuming the header and colliding with the
 * close button. Exported for tests.
 */
export function truncateToolName(toolName: string): string {
  return toolName.length > MAX_TOOL_NAME_IN_TITLE
    ? `${toolName.slice(0, MAX_TOOL_NAME_IN_TITLE - 1)}…`
    : toolName;
}

/**
 * What the tier practically means, in the host's own words.
 *
 * This is the only statement on the surface that Daintree vouches for: the
 * title, the description and the capability list are all the plugin's account
 * of itself, and the tier is what the host concluded independently from the
 * tool's annotations and the plugin's manifest. It goes in `description`, so
 * it is also what `aria-describedby` points at — a screen reader reaching this
 * dialog hears the consequence, not just the identity.
 *
 * D2 and D3 get different language deliberately. They share destructive
 * styling because both warrant it, but their blast radius is not the same and
 * a shared "shared state" phrasing hid that. Exported for tests.
 */
export function consequenceFor(tier: PluginMcpDangerTier): string {
  switch (tier) {
    case "D0":
      return "This reads information. It can't change anything on your machine or in your project.";
    case "D1":
      return "This changes files on this machine. Daintree can't undo it for you.";
    case "D2":
      return "This changes state beyond this machine — other people and other checkouts can see the result.";
    case "D3":
      return "This destroys shared state, and there's no recovery path once it runs.";
  }
}

/**
 * Heading for the re-prompt notice, or `null` when there is nothing to
 * announce. Each reason gets its own so the block names what actually moved
 * rather than saying "something changed". Exported for tests.
 */
export function changeHeadingFor(reason: string): string | null {
  switch (reason) {
    case "raw-changed":
      return "Description changed since you allowed this";
    case "schema-changed":
      return "Inputs changed since you allowed this";
    case "annotation-changed":
      return "Danger level changed since you allowed this";
    case "revoked":
      return "You revoked this before";
    default:
      return null;
  }
}

/**
 * The body of the re-prompt notice: what the change means for the decision in
 * front of the user, not merely that a hash moved. `raw-changed` in particular
 * has to say the quiet part — the text below can look identical and still be
 * different bytes, which is the whole reason the raw hash is tracked
 * separately from the display hash. Exported for tests.
 */
export function changeBodyFor(reason: string, tier: PluginMcpDangerTier): string {
  switch (reason) {
    case "raw-changed":
      return "The description below may look the same as before — the underlying text changed. Read it again before you allow it.";
    case "schema-changed":
      return "This tool now takes a different set of inputs than the version you approved.";
    case "annotation-changed":
      return `The server changed what this tool reports about itself, and Daintree now classifies it as ${tierLabelFor(tier)}.`;
    case "revoked":
      return "You withdrew permission for this tool before. Allowing now grants it again.";
    default:
      return "";
  }
}

/**
 * Human label for a danger tier. D2 and D3 no longer share "Shared state" —
 * they take destructive styling alike, but the label is the only place their
 * differing blast radius can be stated. Exported for tests.
 */
export function tierLabelFor(tier: PluginMcpDangerTier): string {
  switch (tier) {
    case "D0":
      return "read-only";
    case "D1":
      return "local change";
    case "D2":
      return "shared state";
    case "D3":
      return "catastrophic";
  }
}

/**
 * The tier, as a compact badge beside the tool it classifies. The `D0`–`D3`
 * notation is retained as secondary diagnostic text — it is what the audit log
 * and the safeguards doc use, so an operator reading both needs the same
 * vocabulary — but the human label is what carries the meaning, and the
 * practical consequence is stated in full above.
 */
function DangerTierBadge({ tier }: { tier: PluginMcpDangerTier }) {
  return (
    <span className="shrink-0 rounded border border-tint/[0.08] bg-overlay-subtle px-1.5 py-0.5 font-mono text-[10px] text-daintree-text/70">
      {tier} · {tierLabelFor(tier)}
    </span>
  );
}
