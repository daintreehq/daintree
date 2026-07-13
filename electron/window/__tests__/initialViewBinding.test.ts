import { describe, it, expect } from "vitest";
import { resolveInitialViewProject } from "../initialViewBinding.js";
import type { Project } from "../../types/index.js";

const project = (id: string): Project =>
  ({ id, name: id, path: `/projects/${id}`, emoji: "🌲", lastOpened: 0 }) as Project;

const P1 = project("p1");
const P2 = project("p2");

const lookup =
  (...known: Project[]) =>
  (id: string) =>
    known.find((p) => p.id === id) ?? null;

describe("resolveInitialViewProject (#11101)", () => {
  it("binds the restored project on an ordinary boot", () => {
    expect(resolveInitialViewProject(P1, "p1", lookup(P1, P2))).toBe(P1);
  });

  it("binds what the renderer switched to when a switch beat the PVM registration", () => {
    // IPC handlers go live before the ProjectViewManager reaches them, so a
    // switch in that gap moves this same renderer p1 → p2 via the legacy path.
    // Binding the stale p1 would make the NEXT switch persist p2's terminals,
    // drafts and tab groups under p1 — the exact corruption #11101 is about.
    expect(resolveInitialViewProject(P1, "p2", lookup(P1, P2))).toBe(P2);
  });

  it("falls back to the restored project when the pointer names an unknown project", () => {
    // Deleted mid-boot: binding nothing would leave the view unbound, which
    // silently disables outgoing-layout persistence for the whole session.
    expect(resolveInitialViewProject(P1, "ghost", lookup(P1, P2))).toBe(P1);
  });

  it("falls back to the restored project when there is no pointer at all", () => {
    expect(resolveInitialViewProject(P1, null, lookup(P1, P2))).toBe(P1);
  });
});
