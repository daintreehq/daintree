// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { STATE_COLORS, STATE_PRIORITY } from "@/components/Worktree/terminalStateConfig";
import { getAgentConfig } from "@/config/agents";
import { DAINTREE_MOCK_KIT } from "../daintreeMockKit";
import { MockApp, MockWaitingPill, MockWorktreeCard } from "../mockup/MockApp";
import { MockCIGlyph } from "../mockup/MockCIGlyph";
import { MockKitContext, type MockAgent, type MockKit } from "../mockup/MockKitContext";
import { MockAgentIcon, MockPane, MockStateGlyph } from "../mockup/TourMock";

function Glyph({ className, name }: { className?: string; name: string }) {
  return <svg data-glyph={name} className={className} />;
}
const RobotIcon = ({ className }: { className?: string }) => (
  <Glyph name="robot" className={className} />
);
const BusyIcon = ({ className }: { className?: string }) => (
  <Glyph name="busy" className={className} />
);
const StuckIcon = ({ className }: { className?: string }) => (
  <Glyph name="stuck" className={className} />
);
const MarkIcon = ({ className }: { className?: string }) => (
  <Glyph name="mark" className={className} />
);

const ROBOT: MockAgent = { id: "robot", name: "Robot", Icon: RobotIcon, color: "rgb(1, 2, 3)" };

const PLUGIN_KIT: MockKit = {
  agents: { robot: ROBOT },
  states: {
    busy: { Icon: BusyIcon, colorClass: "text-busy", iconClassName: "spin" },
    waiting: { Icon: StuckIcon, colorClass: "text-stuck" },
    idle: { Icon: null, colorClass: "text-idle" },
  },
  statePriority: ["busy", "waiting", "idle"],
  ci: { green: { kind: "icon", Icon: MarkIcon, colorClass: "text-green" } },
  assistantIcon: MarkIcon,
};

function withKit(kit: MockKit, children: ReactNode) {
  return render(<MockKitContext.Provider value={kit}>{children}</MockKitContext.Provider>).container;
}

afterEach(cleanup);

describe("mockup kit", () => {
  it("draws an agent the app has never heard of from the kit it is given", () => {
    const canvas = withKit(PLUGIN_KIT, <MockPane agent="robot" state="busy" />);
    const icon = canvas.querySelector('[data-glyph="robot"]');
    expect(icon).not.toBeNull();
    expect((icon!.parentElement as HTMLElement).style.color).toBe("rgb(1, 2, 3)");
    expect(canvas.textContent).toContain("Robot");
    expect(canvas.textContent).toContain("Ask Robot");
    expect(canvas.querySelector('[data-tour-anchor="robot-glyph"]')).not.toBeNull();
    const busy = canvas.querySelector('[data-glyph="busy"]')!;
    expect(busy.getAttribute("class")).toContain("spin");
    expect(busy.parentElement!.className).toContain("text-busy");
  });

  it("takes a full descriptor with no kit at all", () => {
    const canvas = render(<MockPane agent={ROBOT} title="Custom" />).container;
    expect(canvas.querySelector('[data-glyph="robot"]')).not.toBeNull();
    expect(canvas.textContent).toContain("Custom");
    expect(canvas.textContent).toContain("Ask Robot");
    expect(canvas.querySelector('[data-tour-anchor="robot-input"]')).not.toBeNull();
  });

  it("still renders an unknown agent, named by its id", () => {
    const canvas = withKit(PLUGIN_KIT, <MockPane agent="mystery" />);
    expect(canvas.textContent).toContain("Ask mystery");
    expect(canvas.querySelector("[data-glyph]")).toBeNull();
    expect(canvas.querySelector('[data-tour-anchor="mystery-glyph"]')).not.toBeNull();
  });

  it("never resolves inherited object keys as agents or states", () => {
    const canvas = withKit(
      PLUGIN_KIT,
      <>
        <MockAgentIcon agent="toString" />
        <MockStateGlyph state="constructor" />
        <MockCIGlyph status="hasOwnProperty" />
      </>
    );
    expect(canvas.querySelector("svg")).toBeNull();
  });

  it("keeps the glyph box empty for idle, null and unknown states", () => {
    for (const state of ["idle", null, "unheard-of"] as const) {
      const canvas = withKit(PLUGIN_KIT, <MockStateGlyph state={state} />);
      const box = canvas.firstElementChild!;
      expect(box.className).toContain("size-3.5");
      expect(box.childElementCount).toBe(0);
      cleanup();
    }
  });

  it("shows a worktree's most urgent state by the kit's own priority", () => {
    const canvas = withKit(
      PLUGIN_KIT,
      <MockWorktreeCard name="w" branch="b" states={["idle", "waiting", "busy"]} />
    );
    expect(canvas.querySelectorAll("[data-glyph]")).toHaveLength(1);
    expect(canvas.querySelector('[data-glyph="busy"]')).not.toBeNull();
  });

  it("draws the waiting pill, CI mark and assistant icon from the kit", () => {
    const canvas = withKit(
      PLUGIN_KIT,
      <>
        <MockWaitingPill count={2} />
        <MockCIGlyph status="green" />
        <MockCIGlyph status={{ kind: "dot", colorClass: "bg-amber" }} />
        <MockApp worktrees={null} grid={null} toolbarAgents={["robot"]} />
      </>
    );
    const stuck = canvas.querySelector('[data-tour-anchor="dock-waiting"] [data-glyph="stuck"]');
    expect(stuck?.getAttribute("class")).toBe("size-2.5 text-stuck");
    expect(canvas.querySelector('[data-glyph="mark"].text-green')).not.toBeNull();
    expect(canvas.querySelector("span.bg-amber.rounded-full")).not.toBeNull();
    expect(
      canvas.querySelector('[data-tour-anchor="assistant"] [data-glyph="mark"]')
    ).not.toBeNull();
    expect(canvas.querySelector('[data-tour-anchor="agent-robot"] [data-glyph="robot"]')).not.toBe(
      null
    );
  });

  it("draws nothing for a CI status the kit doesn't know", () => {
    expect(withKit(PLUGIN_KIT, <MockCIGlyph status="pending" />).innerHTML).toBe("");
  });
});

describe("Daintree's mock kit", () => {
  it("gives the built-in agents the app's own colours", () => {
    for (const id of ["claude", "codex", "antigravity"]) {
      expect(DAINTREE_MOCK_KIT.agents[id]!.color).toBe(getAgentConfig(id)?.color);
      expect(DAINTREE_MOCK_KIT.agents[id]!.Icon).not.toBeNull();
    }
  });

  it("mirrors the app's state glyphs and priority", () => {
    expect(DAINTREE_MOCK_KIT.statePriority).toEqual(STATE_PRIORITY);
    for (const state of STATE_PRIORITY) {
      expect(DAINTREE_MOCK_KIT.states[state]!.colorClass).toBe(STATE_COLORS[state]);
    }
    expect(DAINTREE_MOCK_KIT.states.idle!.Icon).toBeNull();
    expect(DAINTREE_MOCK_KIT.states.working!.iconClassName).toContain("animate-spin-slow");
  });

  it("draws pending CI as a dot and passing CI as a glyph", () => {
    expect(DAINTREE_MOCK_KIT.ci.pending!.kind).toBe("dot");
    expect(DAINTREE_MOCK_KIT.ci.success!.kind).toBe("icon");
  });
});
