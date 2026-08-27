// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PluginMcpConfirmDialog,
  changeBodyFor,
  changeHeadingFor,
  consequenceFor,
  tierLabelFor,
  titleFor,
  truncateToolName,
} from "../PluginMcpConfirmDialog";
import { usePluginMcpConfirmStore } from "@/store/pluginMcpConfirmStore";
import type { PluginMcpConsentReason, PluginMcpDangerTier } from "@shared/types/pluginMcpConsent";
import type { PendingPluginMcpConsent } from "@/store/pluginMcpConfirmStore";
import type { BuiltInPluginCapability } from "@shared/types/plugin";

vi.mock("zustand/react/shallow", () => ({
  useShallow: (fn: unknown) => fn,
}));

vi.mock("@/store", () => ({
  usePortalStore: () => ({ isOpen: false, width: 0 }),
}));

vi.mock("@/hooks", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, useOverlayState: () => {} };
});

vi.mock("@/hooks/useAnimatedPresence", () => ({
  useAnimatedPresence: ({ isOpen }: { isOpen: boolean }) => ({
    isVisible: isOpen,
    shouldRender: isOpen,
  }),
}));

vi.stubGlobal(
  "ResizeObserver",
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
);

// Reasons that mean "you approved this before, but something changed" — each
// must re-prompt with a distinct, non-first-use framing so a user can tell a
// rug-pull re-prompt apart from a routine first-time approval.
const REPROMPT_REASONS: PluginMcpConsentReason[] = [
  "raw-changed",
  "schema-changed",
  "annotation-changed",
  "revoked",
];

const ALL_TIERS: PluginMcpDangerTier[] = ["D0", "D1", "D2", "D3"];

function pending(overrides: Partial<PendingPluginMcpConsent> = {}): PendingPluginMcpConsent {
  return {
    requestId: "req-1",
    pluginId: "flightdeck",
    serverId: "flightdeck-mcp",
    toolName: "deploy_branch",
    pluginDisplayName: "Flightdeck",
    descriptionDisplay: "Deploy the current branch.",
    argsSummary: "",
    dangerTier: "D1",
    declaredCapabilities: [],
    reason: "first-use",
    enqueuedAt: Date.now(),
    ...overrides,
  };
}

function enqueue(overrides: Partial<PendingPluginMcpConsent> = {}) {
  act(() => {
    usePluginMcpConfirmStore.getState().reset();
    usePluginMcpConfirmStore.getState().enqueue(pending(overrides));
  });
}

afterEach(() => {
  act(() => usePluginMcpConfirmStore.getState().reset());
  cleanup();
});

describe("PluginMcpConfirmDialog copy", () => {
  it("gives first-use a plain allow prompt with no change notice", () => {
    expect(titleFor("first-use", "do_thing")).toBe("Allow 'do_thing' to run?");
    expect(changeHeadingFor("first-use")).toBeNull();
  });

  it("frames every re-prompt reason distinctly from first-use", () => {
    const firstUse = titleFor("first-use", "do_thing");
    for (const reason of REPROMPT_REASONS) {
      expect(titleFor(reason, "do_thing")).not.toBe(firstUse);
    }
  });

  it("gives every re-prompt reason its own change notice, all distinct", () => {
    const headings = REPROMPT_REASONS.map((r) => changeHeadingFor(r));
    expect(headings.every((h) => typeof h === "string" && h.length > 0)).toBe(true);
    // Distinct, so the notice names what actually moved rather than saying
    // "something changed".
    expect(new Set(headings).size).toBe(REPROMPT_REASONS.length);

    const bodies = REPROMPT_REASONS.map((r) => changeBodyFor(r, "D2"));
    expect(bodies.every((b) => b.length > 0)).toBe(true);
    expect(new Set(bodies).size).toBe(REPROMPT_REASONS.length);
  });

  it("gives every reason, including annotation-changed, a mutually distinct title", () => {
    // The security-critical case: a server re-declaring a pinned tool's safety
    // hints must re-prompt with its own framing, not one indistinguishable
    // from approving the tool for the first time.
    const all: PluginMcpConsentReason[] = ["first-use", ...REPROMPT_REASONS];
    const titles = all.map((r) => titleFor(r, "do_thing"));
    expect(new Set(titles).size).toBe(all.length);
  });

  it("does not claim the danger level rose when only the declarations moved", () => {
    // The store compares the annotation HASH. The recomputed tier may be
    // unchanged or lower, and a legacy pin carrying the empty-string sentinel
    // lands here having changed nothing at all — so copy asserting an increase
    // would be false in the common case.
    const copy = [
      titleFor("annotation-changed", "do_thing"),
      changeHeadingFor("annotation-changed") ?? "",
      changeBodyFor("annotation-changed", "D2"),
    ]
      .join(" ")
      .toLowerCase();
    expect(copy).not.toMatch(/raised|increased|higher|more dangerous|escalat/);
  });

  it("warns on raw-changed that the visible text may look unchanged", () => {
    // The whole reason rawHash is tracked separately from displayHash: the
    // bytes moved while the rendering did not. If the copy does not say so, a
    // user compares the description against their memory, sees no difference,
    // and approves.
    const body = changeBodyFor("raw-changed", "D2").toLowerCase();
    expect(body).toMatch(/look the same|look unchanged|may look/);
  });

  it("interpolates the tool name into re-prompt titles", () => {
    expect(titleFor("annotation-changed", "delete_repo")).toContain("delete_repo");
    expect(titleFor("raw-changed", "delete_repo")).toContain("delete_repo");
  });
});

describe("PluginMcpConfirmDialog danger tiers", () => {
  it("gives no two tiers the same human label", () => {
    // D2 and D3 previously both read "Shared state". They share destructive
    // styling, but their blast radius differs and the label is the only place
    // that can be said.
    const labels = ALL_TIERS.map((t) => tierLabelFor(t));
    expect(new Set(labels).size).toBe(ALL_TIERS.length);
  });

  it("gives every tier a distinct, non-empty practical consequence", () => {
    const sentences = ALL_TIERS.map((t) => consequenceFor(t));
    expect(sentences.every((s) => s.trim().length > 0)).toBe(true);
    expect(new Set(sentences).size).toBe(ALL_TIERS.length);
  });

  it("hedges every consequence — the host cannot verify what a tool actually does", () => {
    // deriveDangerTier builds the tier from the plugin's manifest capabilities
    // and the server's ToolAnnotations, which PluginMcpTierAuth explicitly
    // calls untrusted advisory hints. `destructiveHint: false (or absent)` maps
    // to D1, so D1 is the no-information default. Copy that asserts "this
    // changes files" would state as fact something the host cannot know, on
    // the one surface whose job is to be the trustworthy part.
    for (const tier of ALL_TIERS) {
      expect(consequenceFor(tier).toLowerCase()).toMatch(/\bcan\b|\breports\b|\bclaim\b/);
    }
    // D0 rests entirely on the server's own readOnlyHint, so it must attribute
    // the claim rather than repeat it as the host's finding.
    expect(consequenceFor("D0").toLowerCase()).toMatch(/claim|reports|can't verify|cannot verify/);
  });

  it("states the consequence without leaning on the tier code to carry it", () => {
    // The tier code is diagnostic notation shared with the audit log. It must
    // not be the only thing that says what will happen.
    for (const tier of ALL_TIERS) {
      expect(consequenceFor(tier)).not.toContain(tier);
    }
  });
});

describe("PluginMcpConfirmDialog title bounds", () => {
  it("keeps the title bounded however long the third-party tool name is", () => {
    // The tool name is authored by the party asking for permission. Unbounded,
    // an underscore-heavy name is one unbreakable token that paints through the
    // close button and off the card.
    const hostile = "deploy_current_branch_to_configured_provider_with_health_checks";
    const bounded = titleFor("first-use", hostile);
    expect(bounded.length).toBeLessThan(titleFor("first-use", hostile.repeat(3)).length + 1);
    expect(truncateToolName(hostile).length).toBeLessThanOrEqual(32);
    // A name that already fits is left exactly as it is.
    expect(truncateToolName("deploy_branch")).toBe("deploy_branch");
  });
});

describe("PluginMcpConfirmDialog structure", () => {
  it("is a dialog rather than an alertdialog once it carries capability or argument content", () => {
    // APG reserves alertdialog for a brief, important message read out whole.
    // The destructive tiers are the ones carrying the most structured
    // evidence, so they were the ones getting the wrong role.
    enqueue({ dangerTier: "D2", argsSummary: '{\n  "app": "prod"\n}' });
    render(<PluginMcpConfirmDialog />);
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("names all three third-party identities in labeled positions", () => {
    // Plugin, server and tool are three separate trust judgements. Quoted
    // inside one prose sentence they had to be found by parsing grammar.
    enqueue({});
    render(<PluginMcpConfirmDialog />);
    expect(screen.getByText("Plugin")).toBeTruthy();
    expect(screen.getByText("MCP server")).toBeTruthy();
    expect(screen.getByText("Tool")).toBeTruthy();
    expect(screen.getByText("Flightdeck")).toBeTruthy();
    expect(screen.getByText("flightdeck-mcp")).toBeTruthy();
  });

  it("discloses the persistence scope against the action row", () => {
    // "Allow and remember" is a standing grant that makes every future
    // matching call silent. That fact belongs where the eye is at the moment
    // of commitment, not buried in body copy a habituated reader skips.
    enqueue({});
    render(<PluginMcpConfirmDialog />);
    expect(screen.getByText(/remembered until this tool changes/i)).toBeTruthy();
  });

  it("says when queued requests are waiting behind this one", () => {
    enqueue({});
    act(() => {
      usePluginMcpConfirmStore
        .getState()
        .enqueue(pending({ requestId: "req-2", toolName: "scale_machines" }));
    });
    render(<PluginMcpConfirmDialog />);
    // Read the whole live region, not the one line that matched: the queued
    // hint stacks its two clauses in separate spans.
    const region = screen.getByText(/1 more request waiting/i).closest("[aria-live]");
    const text = (region?.textContent ?? "").toLowerCase();
    // Count first. Placed after the longer persistence phrase it fell outside
    // the hint's two-line clamp and never rendered — reinstating the very
    // "queue is invisible" defect the hint exists to fix.
    expect(text).toContain("remembered until this tool changes");
    expect(text.indexOf("1 more request")).toBeLessThan(text.indexOf("remembered"));
  });

  it("does not carry an expanded disclosure over to the next queued request", () => {
    // The queue advances by swapping `current` on a mounted dialog, so body
    // state survives unless it is keyed. Otherwise a freshly promoted tool
    // renders its capability list already open, in a state the user chose for
    // a different tool.
    const caps: BuiltInPluginCapability[] = ["git:read", "shell:exec"];
    enqueue({ requestId: "req-a", declaredCapabilities: caps });
    act(() => {
      usePluginMcpConfirmStore
        .getState()
        .enqueue(
          pending({ requestId: "req-b", toolName: "other_tool", declaredCapabilities: caps })
        );
    });
    render(<PluginMcpConfirmDialog />);

    const trigger = screen.getByRole("button", { name: /what this plugin can do \(2\)/i });
    act(() => trigger.click());
    expect(screen.getByText("Run shell commands")).toBeTruthy();

    // Advance the queue: req-b is promoted into the same mounted dialog.
    act(() => usePluginMcpConfirmStore.getState().resolveCurrent("rejected"));

    expect(screen.getByText("other_tool")).toBeTruthy();
    expect(screen.queryByText("Run shell commands")).toBeNull();
  });

  it("states an empty capability set rather than omitting the section", () => {
    // A silently absent section is indistinguishable from one that failed to
    // load, and "declares nothing" is worth knowing before a standing grant.
    enqueue({ declaredCapabilities: [] });
    render(<PluginMcpConfirmDialog />);
    expect(screen.getByText(/no capabilities declared/i)).toBeTruthy();
  });

  it("keeps the plugin's capability list collapsed behind a counted trigger", () => {
    // The list describes the plugin, not this call, and is identical on every
    // prompt that plugin raises. Expanded it displaced the arguments, which
    // are specific to this call.
    const caps: BuiltInPluginCapability[] = ["git:read", "shell:exec", "network:fetch"];
    enqueue({ declaredCapabilities: caps });
    render(<PluginMcpConfirmDialog />);
    const trigger = screen.getByRole("button", { name: /what this plugin can do \(3\)/i });
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("Run shell commands")).toBeNull();
    act(() => trigger.click());
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    // Expanded, capabilities read as host-authored consequence rather than raw
    // manifest identifiers.
    expect(screen.getByText("Run shell commands")).toBeTruthy();
  });

  it("keeps the redacted arguments expanded on a destructive tier", () => {
    // docs/architecture/destructive-action-safeguards.md records the redacted
    // argsSummary as the content preview that satisfies this surface's D2
    // requirement. Collapsing it behind a disclosure would weaken an audited
    // safeguard, so only the capability list collapses.
    enqueue({ dangerTier: "D2", argsSummary: '{\n  "app": "helios-prod"\n}' });
    render(<PluginMcpConfirmDialog />);
    expect(screen.getByText(/helios-prod/)).toBeTruthy();
  });
});
