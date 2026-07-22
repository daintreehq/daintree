// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { TerminalIcon } from "../TerminalIcon";
import { deriveTerminalChrome, type TerminalChromeDescriptor } from "@/utils/terminalChrome";
import { PLUGIN_ICON_IDS } from "@/components/icons/pluginIconRegistry";

function renderDefaultTerminalIcon(): string {
  return render(<TerminalIcon kind="terminal" chrome={deriveTerminalChrome()} />).container
    .innerHTML;
}

/** A plugin-panel chrome descriptor carrying an explicit `iconId`. */
function pluginChrome(iconId: string): TerminalChromeDescriptor {
  return {
    iconId,
    label: "Plugin panel",
    isAgent: false,
    agentId: null,
    processId: null,
    runtimeKind: "panel",
    hasExited: false,
  };
}

function renderIcon(iconId: string): string {
  return render(<TerminalIcon chrome={pluginChrome(iconId)} />).container.innerHTML;
}

describe("TerminalIcon", () => {
  it("marks the rendered icon identity for automated chrome assertions", () => {
    const { container, rerender } = render(
      <TerminalIcon kind="terminal" chrome={deriveTerminalChrome({ detectedAgentId: "claude" })} />
    );

    expect(
      container.querySelector("[data-terminal-icon-id]")?.getAttribute("data-terminal-icon-id")
    ).toBe("claude");

    rerender(<TerminalIcon kind="terminal" chrome={deriveTerminalChrome()} />);

    expect(
      container.querySelector("[data-terminal-icon-id]")?.getAttribute("data-terminal-icon-id")
    ).toBe("terminal");
  });

  it("marks the resolved icon color for automated chrome assertions", () => {
    const { container } = render(
      <TerminalIcon
        kind="terminal"
        chrome={deriveTerminalChrome({
          launchAgentId: "claude",
          presetColor: "#3366ff",
        })}
      />
    );

    const icon = container.querySelector("[data-terminal-icon-id='claude']");
    expect(icon?.getAttribute("data-terminal-icon-color")).toBe("#3366ff");
    expect(icon?.querySelector("path")?.getAttribute("fill")).toBe("#3366ff");
  });

  it("lets an explicit brandColor override the chrome color marker", () => {
    const { container } = render(
      <TerminalIcon
        kind="terminal"
        chrome={deriveTerminalChrome({
          launchAgentId: "claude",
          presetColor: "#3366ff",
        })}
        brandColor="#ff6600"
      />
    );

    const icon = container.querySelector("[data-terminal-icon-id='claude']");
    expect(icon?.getAttribute("data-terminal-icon-color")).toBe("#ff6600");
    expect(icon?.querySelector("path")?.getAttribute("fill")).toBe("#ff6600");
  });

  it("renders AI process icons for detected CLI processes in terminal panels", () => {
    const fallback = renderDefaultTerminalIcon();
    const { container } = render(
      <TerminalIcon
        kind="terminal"
        chrome={deriveTerminalChrome({ detectedProcessId: "claude" })}
      />
    );

    expect(container.innerHTML).not.toBe(fallback);
  });

  it("renders package-manager process icons for detected CLI processes", () => {
    const fallback = renderDefaultTerminalIcon();
    const { container } = render(
      <TerminalIcon kind="terminal" chrome={deriveTerminalChrome({ detectedProcessId: "npm" })} />
    );

    expect(container.innerHTML).not.toBe(fallback);
  });

  it("falls back to terminal icon when detected process is unknown", () => {
    const fallback = renderDefaultTerminalIcon();
    const { container } = render(
      <TerminalIcon
        kind="terminal"
        chrome={deriveTerminalChrome({ detectedProcessId: "unknown-tool" })}
      />
    );

    expect(container.innerHTML).toBe(fallback);
  });

  it("prefers explicit agent icon over detected process icon", () => {
    const npmDetected = render(
      <TerminalIcon kind="terminal" chrome={deriveTerminalChrome({ detectedProcessId: "npm" })} />
    ).container.innerHTML;

    // Agent runtime identity wins over process identity in the descriptor.
    const explicitAgent = render(
      <TerminalIcon
        kind="agent"
        chrome={deriveTerminalChrome({ detectedAgentId: "claude", detectedProcessId: "npm" })}
      />
    ).container.innerHTML;

    const fallback = renderDefaultTerminalIcon();

    expect(explicitAgent).not.toBe(npmDetected);
    expect(explicitAgent).not.toBe(fallback);
  });

  it("prefers detectedAgentId over launch-time agentId", () => {
    // Live detection wins over durable launch affinity.
    const claudeLaunch = render(
      <TerminalIcon kind="agent" chrome={deriveTerminalChrome({ launchAgentId: "claude" })} />
    ).container.innerHTML;
    const geminiDetected = render(
      <TerminalIcon
        kind="agent"
        chrome={deriveTerminalChrome({ launchAgentId: "claude", detectedAgentId: "gemini" })}
      />
    ).container.innerHTML;
    const geminiOnly = render(
      <TerminalIcon kind="agent" chrome={deriveTerminalChrome({ detectedAgentId: "gemini" })} />
    ).container.innerHTML;

    expect(geminiDetected).not.toBe(claudeLaunch);
    expect(geminiDetected).toBe(geminiOnly);
  });

  it("uses launch-time agent identity as chrome fallback until explicit exit", () => {
    const launchOnly = render(
      <TerminalIcon kind="agent" chrome={deriveTerminalChrome({ launchAgentId: "claude" })} />
    ).container.innerHTML;
    const generic = renderDefaultTerminalIcon();

    expect(launchOnly).not.toBe(generic);
  });

  it("returns to the generic terminal icon after explicit launch-agent exit", () => {
    const launchExited = render(
      <TerminalIcon
        kind="agent"
        chrome={deriveTerminalChrome({ launchAgentId: "claude", agentState: "exited" })}
      />
    ).container.innerHTML;
    const generic = renderDefaultTerminalIcon();

    expect(launchExited).toBe(generic);
  });

  it("drops sticky runtime-identity agent chrome after explicit exit", () => {
    const stickyExited = render(
      <TerminalIcon
        kind="terminal"
        chrome={deriveTerminalChrome({
          runtimeIdentity: { kind: "agent", id: "claude", iconId: "claude", agentId: "claude" },
          agentState: "exited",
        })}
      />
    ).container.innerHTML;
    const generic = renderDefaultTerminalIcon();

    expect(stickyExited).toBe(generic);
  });

  it("drops sticky runtime-identity agent chrome when exitCode is set", () => {
    const stickyExited = render(
      <TerminalIcon
        kind="terminal"
        chrome={deriveTerminalChrome({
          runtimeIdentity: { kind: "agent", id: "claude", iconId: "claude", agentId: "claude" },
          exitCode: 0,
        })}
      />
    ).container.innerHTML;
    const generic = renderDefaultTerminalIcon();

    expect(stickyExited).toBe(generic);
  });

  describe("shared plugin icon registry (#11298)", () => {
    it("renders a distinct glyph for every advertised icon id", () => {
      const seen = new Map<string, string>();
      for (const id of PLUGIN_ICON_IDS) {
        const html = renderIcon(id);
        expect(html, `"${id}" rendered no svg`).toContain("<svg");
        const clash = seen.get(html);
        expect(clash, `"${id}" renders identically to "${clash}"`).toBeUndefined();
        seen.set(html, id);
      }
    });

    it("renders ids that used to fall through to the terminal glyph", () => {
      // These lived only in the palette's map, so panel headers, tabs, and the
      // dock all showed a terminal icon for them instead.
      const fallback = renderIcon("no-such-icon");
      for (const id of ["puzzle", "git-branch", "sticky-note", "daintree", "gauge"]) {
        expect(renderIcon(id), `"${id}" still falls back`).not.toBe(fallback);
      }
    });

    it("gives monitor and monitor-play different glyphs", () => {
      // The old id conditionals aliased both onto MonitorPlay.
      expect(renderIcon("monitor")).not.toBe(renderIcon("monitor-play"));
    });

    it("keeps the category color on the semantic panel-kind icons", () => {
      expect(renderIcon("file-diff")).toContain("text-category-green");
      expect(renderIcon("git-pull-request")).toContain("text-category-violet");
      expect(renderIcon("file-text")).toContain("text-category-amber");
      expect(renderIcon("globe")).toContain("text-status-info");
    });

    it("renders non-semantic registry ids without a category color", () => {
      expect(renderIcon("puzzle")).not.toContain("text-category-");
    });

    it("lets a built-in kind pin its glyph over the chrome's icon id", () => {
      const { container } = render(<TerminalIcon kind="browser" chrome={pluginChrome("puzzle")} />);

      expect(container.innerHTML).toContain("text-status-info");
      expect(container.innerHTML).not.toBe(renderIcon("puzzle"));
    });

    it("still resolves agent brand icons ahead of the generic registry", () => {
      // `claude` is not a registry id — it must reach the brand-icon path.
      const agent = render(
        <TerminalIcon chrome={deriveTerminalChrome({ detectedAgentId: "claude" })} />
      ).container.innerHTML;

      expect(agent).not.toBe(renderIcon("no-such-icon"));
      expect(agent).toContain("<svg");
    });

    it("treats inherited object keys as unknown ids", () => {
      // `iconId` is untrusted manifest input; a bare `in`/index lookup would
      // resolve these to functions off Object.prototype.
      const fallback = renderIcon("no-such-icon");
      for (const id of ["toString", "constructor", "hasOwnProperty", "__proto__"]) {
        expect(renderIcon(id), `"${id}" leaked an inherited value`).toBe(fallback);
      }
    });

    it("marks an unknown id as the terminal fallback", () => {
      const { container } = render(<TerminalIcon chrome={pluginChrome("no-such-icon")} />);

      expect(
        container.querySelector("[data-terminal-icon-id]")?.getAttribute("data-terminal-icon-id")
      ).toBe("terminal");
    });

    it("keeps the author's id on the marker when the glyph resolves", () => {
      const { container } = render(<TerminalIcon chrome={pluginChrome("puzzle")} />);

      expect(
        container.querySelector("[data-terminal-icon-id]")?.getAttribute("data-terminal-icon-id")
      ).toBe("puzzle");
    });
  });
});
