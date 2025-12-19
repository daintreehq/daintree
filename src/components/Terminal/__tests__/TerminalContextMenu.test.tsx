import { describe, it, expect } from "vitest";
import { AGENT_IDS, getAgentConfig } from "@/config/agents";
import type { MenuItemOption } from "@shared/types";

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