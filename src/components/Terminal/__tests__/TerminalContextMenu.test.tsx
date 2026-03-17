import { describe, it, expect } from "vitest";
import { AGENT_IDS, getAgentConfig } from "@/config/agents";
import type { MenuItemOption } from "@shared/types";
import { extractUrlAtPoint } from "../TerminalContextMenu";

describe("TerminalContextMenu - Convert To Submenu", () => {
  describe("Agent configuration", () => {
    it("should have registered agents", () => {
      expect(AGENT_IDS).toBeDefined();
      expect(AGENT_IDS.length).toBeGreaterThan(0);
    });

    it("should return valid configs for all registered agents", () => {
      for (const agentId of AGENT_IDS) {
        const config = getAgentConfig(agentId);
        expect(config).toBeDefined();
        expect(config?.name).toBeDefined();
        expect(config?.id).toBe(agentId);
      }
    });
  });

  describe("Submenu generation logic", () => {
    function buildConvertToSubmenu(
      terminal: { type: string; kind?: string; agentId?: string | null } | null
    ): MenuItemOption[] {
      if (!terminal) return [];

      const currentAgentId =
        terminal.agentId ?? (terminal.type !== "terminal" ? terminal.type : null);
      const isPlainTerminal = terminal.type === "terminal" || terminal.kind === "terminal";

      const items: MenuItemOption[] = [];

      if (!isPlainTerminal || currentAgentId) {
        items.push({
          id: "convert-to:terminal",
          label: "Terminal",
          enabled: !isPlainTerminal || !!currentAgentId,
        });
      }

      for (const agentId of AGENT_IDS) {
        const config = getAgentConfig(agentId);
        if (!config) continue;
        const isCurrent = currentAgentId === agentId;
        items.push({
          id: `convert-to:${agentId}`,
          label: config.name,
          enabled: !isCurrent,
        });
      }

      return items;
    }

    it("should include all agents for plain terminal", () => {
      const terminal = { type: "terminal", kind: "terminal" };
      const submenu = buildConvertToSubmenu(terminal);

      expect(submenu.length).toBeGreaterThan(0);

      const agentItems = submenu.filter(
        (item) => item.type !== "separator" && item.id.startsWith("convert-to:")
      );
      expect(agentItems.length).toBe(AGENT_IDS.length);

      for (const agentId of AGENT_IDS) {
        const item = submenu.find((i) => i.id === `convert-to:${agentId}`);
        expect(item).toBeDefined();
        if (item && item.type !== "separator") {
          expect(item.enabled).toBe(true);
        }
      }
    });

    it("should include Terminal option and agents for agent terminal", () => {
      const terminal = { type: "claude", kind: "agent", agentId: "claude" };
      const submenu = buildConvertToSubmenu(terminal);

      expect(submenu.length).toBeGreaterThan(0);

      const terminalItem = submenu.find((i) => i.id === "convert-to:terminal");
      expect(terminalItem).toBeDefined();
      if (terminalItem && terminalItem.type !== "separator") {
        expect(terminalItem.enabled).toBe(true);
      }

      const currentAgentItem = submenu.find((i) => i.id === "convert-to:claude");
      expect(currentAgentItem).toBeDefined();
      if (currentAgentItem && currentAgentItem.type !== "separator") {
        expect(currentAgentItem.enabled).toBe(false);
      }

      const otherAgents = AGENT_IDS.filter((id) => id !== "claude");
      for (const agentId of otherAgents) {
        const item = submenu.find((i) => i.id === `convert-to:${agentId}`);
        expect(item).toBeDefined();
        if (item && item.type !== "separator") {
          expect(item.enabled).toBe(true);
        }
      }
    });

    it("should disable current agent in submenu", () => {
      const terminal = { type: "gemini", kind: "agent", agentId: "gemini" };
      const submenu = buildConvertToSubmenu(terminal);

      const currentAgentItem = submenu.find((i) => i.id === "convert-to:gemini");
      expect(currentAgentItem).toBeDefined();
      if (currentAgentItem && currentAgentItem.type !== "separator") {
        expect(currentAgentItem.enabled).toBe(false);
      }
    });

    it("should return empty array when terminal is null", () => {
      const submenu = buildConvertToSubmenu(null);
      expect(submenu).toEqual([]);
    });

    it("should handle legacy agent terminal (type without agentId)", () => {
      const agentType = AGENT_IDS[0];
      const terminal = { type: agentType, kind: "agent" };
      const submenu = buildConvertToSubmenu(terminal);

      const terminalItem = submenu.find((i) => i.id === "convert-to:terminal");
      expect(terminalItem).toBeDefined();
      if (terminalItem && terminalItem.type !== "separator") {
        expect(terminalItem.enabled).toBe(true);
      }

      const currentAgentItem = submenu.find((i) => i.id === `convert-to:${agentType}`);
      expect(currentAgentItem).toBeDefined();
      if (currentAgentItem && currentAgentItem.type !== "separator") {
        expect(currentAgentItem.enabled).toBe(false);
      }
    });

    it("should not include Terminal option for plain terminal", () => {
      const terminal = { type: "terminal", kind: "terminal" };
      const submenu = buildConvertToSubmenu(terminal);

      const terminalItem = submenu.find((i) => i.id === "convert-to:terminal");
      expect(terminalItem).toBeUndefined();
    });

    it("should handle transitional state (type and agentId mismatch)", () => {
      const terminal = { type: "terminal", kind: "terminal", agentId: AGENT_IDS[0] };
      const submenu = buildConvertToSubmenu(terminal);

      const terminalItem = submenu.find((i) => i.id === "convert-to:terminal");
      expect(terminalItem).toBeDefined();

      const currentAgentItem = submenu.find((i) => i.id === `convert-to:${AGENT_IDS[0]}`);
      expect(currentAgentItem).toBeDefined();
      if (currentAgentItem && currentAgentItem.type !== "separator") {
        expect(currentAgentItem.enabled).toBe(false);
      }
    });

    it("should handle unknown agent type gracefully", () => {
      const terminal = { type: "some-unknown-agent", kind: "agent" };
      const submenu = buildConvertToSubmenu(terminal);

      const terminalItem = submenu.find((i) => i.id === "convert-to:terminal");
      expect(terminalItem).toBeDefined();
      if (terminalItem && terminalItem.type !== "separator") {
        expect(terminalItem.enabled).toBe(true);
      }

      for (const agentId of AGENT_IDS) {
        const item = submenu.find((i) => i.id === `convert-to:${agentId}`);
        expect(item).toBeDefined();
        if (item && item.type !== "separator") {
          expect(item.enabled).toBe(true);
        }
      }
    });

    it("should return empty array if agents unavailable (edge case)", () => {
      const terminal = { type: "terminal", kind: "terminal" };
      const submenu = buildConvertToSubmenu(terminal);

      if (AGENT_IDS.length === 0) {
        expect(submenu.length).toBe(0);
      } else {
        expect(submenu.length).toBeGreaterThan(0);
      }
    });
  });
});

describe("extractUrlAtPoint", () => {
  function makeMockTerminal(opts: {
    text: string;
    cols?: number;
    rows?: number;
    rect?: { left: number; top: number; width: number; height: number };
    elementNull?: boolean;
    viewportY?: number;
  }) {
    const cols = opts.cols ?? 80;
    const rows = opts.rows ?? 24;
    const rect = opts.rect ?? { left: 0, top: 0, width: 800, height: 480, right: 800, bottom: 480 };
    return {
      element: opts.elementNull
        ? undefined
        : {
            getBoundingClientRect: () => ({
              ...rect,
              right: rect.left + rect.width,
              bottom: rect.top + rect.height,
            }),
          },
      cols,
      rows,
      buffer: {
        active: {
          viewportY: opts.viewportY ?? 0,
          getLine: () => ({
            translateToString: () => opts.text,
          }),
        },
      },
    } as never;
  }

  it("returns URL when click lands on a URL in the line", () => {
    const text = "Visit https://example.com for more info";
    const terminal = makeMockTerminal({
      text,
      cols: 80,
      rows: 24,
      rect: { left: 0, top: 0, width: 800, height: 480 },
    });
    // "https://example.com" starts at index 6, length 19
    // col 6 = clientX = (6/80)*800 + some offset to land in the cell
    const clientX = (6.5 / 80) * 800;
    const clientY = (0.5 / 24) * 480;
    expect(extractUrlAtPoint(terminal, clientX, clientY)).toBe("https://example.com");
  });

  it("returns null when click is outside the URL", () => {
    const text = "Visit https://example.com for more info";
    const terminal = makeMockTerminal({ text });
    const clientX = (0.5 / 80) * 800;
    const clientY = (0.5 / 24) * 480;
    expect(extractUrlAtPoint(terminal, clientX, clientY)).toBeNull();
  });

  it("strips trailing punctuation from matched URL", () => {
    const text = "See https://example.com/path.";
    const terminal = makeMockTerminal({ text });
    // URL starts at index 4, "https://example.com/path." -> stripped to "https://example.com/path"
    const clientX = (10.5 / 80) * 800;
    const clientY = (0.5 / 24) * 480;
    expect(extractUrlAtPoint(terminal, clientX, clientY)).toBe("https://example.com/path");
  });

  it("returns null when no URL on line", () => {
    const text = "just some plain text here";
    const terminal = makeMockTerminal({ text });
    const clientX = (5.5 / 80) * 800;
    const clientY = (0.5 / 24) * 480;
    expect(extractUrlAtPoint(terminal, clientX, clientY)).toBeNull();
  });

  it("returns null when terminal.element is null/undefined", () => {
    const terminal = makeMockTerminal({ text: "https://example.com", elementNull: true });
    expect(extractUrlAtPoint(terminal, 100, 100)).toBeNull();
  });

  it("returns null when click is outside terminal element bounds", () => {
    const text = "https://example.com";
    const terminal = makeMockTerminal({
      text,
      rect: { left: 100, top: 100, width: 800, height: 480 },
    });
    // Click at (50, 50) which is outside the rect starting at (100, 100)
    expect(extractUrlAtPoint(terminal, 50, 50)).toBeNull();
  });
});
