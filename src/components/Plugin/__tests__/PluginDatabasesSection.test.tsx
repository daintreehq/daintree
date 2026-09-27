// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { PluginDatabasesSection } from "../PluginDatabasesSection";
import type { PluginDatabaseContribution } from "@shared/types/plugin";

const local = {
  id: "ledger",
  description: "Entries",
  location: "local",
  journalMode: "delete",
} as PluginDatabaseContribution;
const inRepo = {
  id: "notes",
  location: "project",
  path: "data/notes.db",
  journalMode: "delete",
} as PluginDatabaseContribution;

afterEach(cleanup);

function items(): string[] {
  return screen.getAllByRole("listitem").map((li) => li.textContent ?? "");
}

describe("PluginDatabasesSection", () => {
  it("says an installed plugin's local database is shared by every project", () => {
    render(<PluginDatabasesSection databases={[local]} origin="global" />);
    expect(items()).toEqual(["EntriesStored on this machine and shared by every project"]);
  });

  it("keeps a project plugin's local database to that project", () => {
    render(<PluginDatabasesSection databases={[local, inRepo]} origin="project" />);
    expect(items()).toEqual([
      "EntriesStored on this machine, outside the project",
      "notesIn the project at data/notes.db",
    ]);
  });
});
