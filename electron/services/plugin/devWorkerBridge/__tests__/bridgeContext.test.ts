import { describe, expect, it } from "vitest";
import { routesFrom } from "../bridgeContext.js";

describe("routesFrom", () => {
  it("routes every name from every domain table", () => {
    const a = () => "a";
    const b = () => "b";
    const routes = routesFrom([{ "fs.readFile": a }, { "settings.get": b }]);
    expect(routes.get("fs.readFile")).toBe(a);
    expect(routes.get("settings.get")).toBe(b);
    expect(routes.size).toBe(2);
  });

  it("throws when two domains claim the same name", () => {
    expect(() => routesFrom([{ "fs.stat": () => 1 }, { "fs.stat": () => 2 }])).toThrow(
      'plugin dev worker route "fs.stat" is claimed by two domains'
    );
  });

  it("never resolves a worker-chosen name through Object.prototype", () => {
    const routes = routesFrom([{ getAgentState: () => 1 }]);
    for (const name of ["toString", "constructor", "__proto__", "hasOwnProperty"]) {
      expect(routes.get(name)).toBeUndefined();
    }
  });
});
