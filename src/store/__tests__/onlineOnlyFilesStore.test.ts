import { beforeEach, describe, expect, it } from "vitest";
import type { ProjectOnlineOnlyFiles } from "@shared/types/onlineOnlyFiles";
import {
  selectOnlineOnlyOutstanding,
  selectOnlineOnlyUnsettled,
  useOnlineOnlyFilesStore,
} from "../onlineOnlyFilesStore";

const zero = { files: 0, directories: 0, complete: true };

const snapshot = (overrides: Partial<ProjectOnlineOnlyFiles> = {}): ProjectOnlineOnlyFiles => ({
  projectId: "p1",
  service: "Dropbox",
  revision: 1,
  git: zero,
  workingTree: zero,
  ...overrides,
});

const state = () => useOnlineOnlyFilesStore.getState();

describe("onlineOnlyFilesStore", () => {
  beforeEach(() => state().reset());

  it("drops an answer older than what a push already delivered", () => {
    state().ask();
    state().answer(snapshot({ revision: 5, git: { ...zero, files: 2 } }));
    state().answer(snapshot({ revision: 3, git: { ...zero, files: 9 } }));

    expect(state().files?.git?.files).toBe(2);
  });

  it("takes a lower revision after a new ask, since a restarted host counts again", () => {
    state().ask();
    state().answer(snapshot({ revision: 40 }));

    state().ask();
    state().answer(snapshot({ revision: 2, git: { ...zero, files: 7 } }));

    expect(state().files?.git?.files).toBe(7);
  });

  it("forgets everything when `watch` says the project doesn't qualify", () => {
    state().ask();
    state().answer(snapshot({ revision: 5 }));
    state().answer(null);

    expect(state().files).toBeNull();
    expect(state().phase).toBe("answered");
  });

  describe("selectOnlineOnlyOutstanding", () => {
    it("sees either side, and nothing in an incomplete zero", () => {
      state().answer(snapshot({ git: { ...zero, files: 1 } }));
      expect(selectOnlineOnlyOutstanding(state())).toBe(true);

      state().reset();
      state().answer(snapshot({ workingTree: { ...zero, directories: 1 } }));
      expect(selectOnlineOnlyOutstanding(state())).toBe(true);

      state().reset();
      state().answer(snapshot({ git: { ...zero, complete: false } }));
      expect(selectOnlineOnlyOutstanding(state())).toBe(false);
    });
  });

  describe("selectOnlineOnlyUnsettled", () => {
    it("is settled before anyone has asked, so a view without the hook looks like today", () => {
      expect(selectOnlineOnlyUnsettled(state())).toBe(false);
    });

    it("is unsettled from the ask until both first walks answer", () => {
      state().ask();
      expect(selectOnlineOnlyUnsettled(state())).toBe(true);

      state().answer(snapshot({ revision: 1, git: null, workingTree: null }));
      expect(selectOnlineOnlyUnsettled(state())).toBe(true);

      state().answer(snapshot({ revision: 2, workingTree: null }));
      expect(selectOnlineOnlyUnsettled(state())).toBe(true);

      state().answer(snapshot({ revision: 3 }));
      expect(selectOnlineOnlyUnsettled(state())).toBe(false);
    });

    it("settles at once for a project this doesn't apply to", () => {
      state().ask();
      state().answer(null);
      expect(selectOnlineOnlyUnsettled(state())).toBe(false);
    });

    it("stays settled across a resync's re-ask, so nothing flashes", () => {
      state().ask();
      state().answer(snapshot({ revision: 3 }));

      state().ask();
      expect(selectOnlineOnlyUnsettled(state())).toBe(false);
    });
  });
});
