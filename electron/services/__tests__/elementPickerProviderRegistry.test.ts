import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getElementPickerProvider,
  isElementPickerProviderAuthorized,
  listElementPickerProviders,
  matchElementPickerProviders,
  onElementPickerProvidersChanged,
  registerElementPickerProviders,
  unregisterElementPickerProviders,
} from "../elementPickerProviderRegistry.js";
import { makeProjectPluginInstanceKey } from "../../../shared/types/plugin.js";
import type { ElementPickerProviderContribution } from "../../../shared/elementPicker/providers.js";

const qwik: ElementPickerProviderContribution = {
  id: "qwik",
  name: "Qwik",
  detection: [
    { kind: "global", name: "qwikevents", match: "exact" },
    { kind: "attribute", name: "q:", match: "prefix" },
  ],
  guestEntry: "guest/qwik.js",
  resolverEntry: "resolver/qwik.js",
};
const marko: ElementPickerProviderContribution = {
  id: "marko",
  name: "Marko",
  detection: [{ kind: "global", name: "$marko", match: "exact" }],
  guestEntry: "guest/marko.js",
};

const PROJECT_KEY = makeProjectPluginInstanceKey("p1", "acme.qwik");

afterEach(() => {
  for (const id of ["acme.qwik", "acme.marko", PROJECT_KEY]) unregisterElementPickerProviders(id);
});

describe("elementPickerProviderRegistry", () => {
  it("namespaces ids with the plugin name and reads without activation", () => {
    registerElementPickerProviders("acme.qwik", "acme.qwik", [qwik]);
    const found = getElementPickerProvider("acme.qwik.qwik", null);
    expect(found?.guestEntry).toBe("guest/qwik.js");
    expect(found?.resolverEntry).toBe("resolver/qwik.js");
    expect(found?.projectId).toBeNull();
  });

  it("authorizes core frameworks and registered providers only", () => {
    expect(isElementPickerProviderAuthorized("react", null)).toBe(true);
    expect(isElementPickerProviderAuthorized("acme.qwik.qwik", null)).toBe(false);
    registerElementPickerProviders("acme.qwik", "acme.qwik", [qwik]);
    expect(isElementPickerProviderAuthorized("acme.qwik.qwik", null)).toBe(true);
    expect(isElementPickerProviderAuthorized("acme.qwik.other", null)).toBe(false);
  });

  it("revokes on unregister and notifies listeners", () => {
    const listener = vi.fn();
    const off = onElementPickerProvidersChanged(listener);
    registerElementPickerProviders("acme.qwik", "acme.qwik", [qwik]);
    unregisterElementPickerProviders("acme.qwik");
    expect(isElementPickerProviderAuthorized("acme.qwik.qwik", null)).toBe(false);
    expect(listener).toHaveBeenCalledTimes(2);
    unregisterElementPickerProviders("acme.qwik");
    expect(listener).toHaveBeenCalledTimes(2);
    off();
  });

  it("scopes a project plugin's providers to its own project", () => {
    registerElementPickerProviders(PROJECT_KEY, "acme.qwik", [qwik]);
    expect(isElementPickerProviderAuthorized("acme.qwik.qwik", "p1")).toBe(true);
    expect(isElementPickerProviderAuthorized("acme.qwik.qwik", "p2")).toBe(false);
    expect(isElementPickerProviderAuthorized("acme.qwik.qwik", null)).toBe(false);
  });

  it("keeps one plugin's removal from touching another's providers", () => {
    registerElementPickerProviders("acme.qwik", "acme.qwik", [qwik]);
    registerElementPickerProviders("acme.marko", "acme.marko", [marko]);
    unregisterElementPickerProviders("acme.qwik");
    expect(listElementPickerProviders(null).map((p) => p.id)).toEqual(["acme.marko.marko"]);
  });

  it("matches several providers on a mixed page, by exact and prefix rules", () => {
    registerElementPickerProviders("acme.qwik", "acme.qwik", [qwik]);
    registerElementPickerProviders("acme.marko", "acme.marko", [marko]);
    const matched = matchElementPickerProviders(
      [
        { kind: "attribute", name: "q:container" },
        { kind: "global", name: "$marko" },
      ],
      null
    );
    expect(matched.map((p) => p.id)).toEqual(["acme.qwik.qwik", "acme.marko.marko"]);
    expect(matchElementPickerProviders([{ kind: "global", name: "q:x" }], null)).toEqual([]);
    expect(matchElementPickerProviders([{ kind: "global", name: "qwikeventsX" }], null)).toEqual(
      []
    );
  });

  it("freezes registered descriptors", () => {
    registerElementPickerProviders("acme.qwik", "acme.qwik", [qwik]);
    const found = getElementPickerProvider("acme.qwik.qwik", null)!;
    expect(Object.isFrozen(found)).toBe(true);
    expect(Object.isFrozen(found.detection)).toBe(true);
  });
});
