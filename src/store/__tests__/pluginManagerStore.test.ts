import { describe, expect, it, beforeEach } from "vitest";
import { usePluginManagerStore } from "../pluginManagerStore";

describe("pluginManagerStore", () => {
  beforeEach(() => {
    usePluginManagerStore.setState({ isOpen: false });
  });

  it("starts closed", () => {
    expect(usePluginManagerStore.getState().isOpen).toBe(false);
  });

  it("open() sets isOpen true", () => {
    usePluginManagerStore.getState().open();
    expect(usePluginManagerStore.getState().isOpen).toBe(true);
  });

  it("close() sets isOpen false", () => {
    usePluginManagerStore.getState().open();
    usePluginManagerStore.getState().close();
    expect(usePluginManagerStore.getState().isOpen).toBe(false);
  });

  it("repeated open()/close() is idempotent", () => {
    const { open, close } = usePluginManagerStore.getState();
    open();
    open();
    expect(usePluginManagerStore.getState().isOpen).toBe(true);
    close();
    close();
    expect(usePluginManagerStore.getState().isOpen).toBe(false);
  });
});
