// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import type { CommandManifestEntry, CommandOverride } from "@shared/types/commands";

const COMMANDS: CommandManifestEntry[] = [
  {
    id: "git.summary",
    label: "Summarize changes",
    description: "Summarize the working tree",
    category: "git",
    args: [],
  } as unknown as CommandManifestEntry,
];

vi.mock("@/clients/commandsClient", () => ({
  commandsClient: { list: vi.fn(async () => COMMANDS) },
}));

import { TooltipProvider } from "@/components/ui/tooltip";
import { CommandOverridesTab } from "../CommandOverridesTab";

describe("CommandOverridesTab", () => {
  it("keeps the prompt editor for an argument-free command a stale save left defaults on", async () => {
    // An older save can leave `defaults` on a command that takes no arguments. Defaults
    // mode has no editor for such a command, so it must stay a prompt override.
    const overrides: CommandOverride[] = [{ commandId: "git.summary", defaults: { x: "1" } }];
    render(<CommandOverridesTab projectId="p" overrides={overrides} onChange={() => {}} />, {
      wrapper: TooltipProvider,
    });

    fireEvent.click(await screen.findByRole("button", { name: "Expand" }));

    expect(document.querySelector("textarea")).not.toBeNull();
  });
});
