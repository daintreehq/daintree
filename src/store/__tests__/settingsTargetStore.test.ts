import { beforeEach, describe, expect, it } from "vitest";
import { useSettingsTargetStore } from "../settingsTargetStore";

beforeEach(() => useSettingsTargetStore.getState().setHostId(null));

describe("settingsTargetStore (#14706)", () => {
  it("goes back to a machine's work settings whenever it is picked, even the one already picked", () => {
    const store = useSettingsTargetStore.getState();
    store.setHostId("studio-03");
    store.setShowingDevicePage(true);
    // Hosts → studio-03 → Edit work settings, while a device page shows.
    store.setHostId("studio-03");
    expect(useSettingsTargetStore.getState()).toMatchObject({
      hostId: "studio-03",
      showingDevicePage: false,
    });
  });
});
