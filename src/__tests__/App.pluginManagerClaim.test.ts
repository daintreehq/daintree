import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

// Opening the plugin manager closes Settings, and PluginManagerView claims the
// viewport only once its lazy chunk mounts. App holds a claim on the store flag
// so the Portal can't show in between (#15029). It never shares the view's own
// id: claims don't count holders, so one cleanup would release both.

const APP = path.resolve(__dirname, "../App.tsx");

describe("App plugin manager overlay claim", () => {
  it("claims the viewport from the store flag, under its own id", () => {
    const source = ts.createSourceFile(
      APP,
      fs.readFileSync(APP, "utf8"),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX
    );
    const claims: ts.CallExpression[] = [];
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node) && node.expression.getText(source) === "useOverlayClaim") {
        claims.push(node);
      }
      node.forEachChild(visit);
    };
    visit(source);

    const storeFlagClaims = claims.filter(
      (c) => c.arguments[1]?.getText(source) === "isPluginManagerOpen"
    );
    expect(storeFlagClaims).toHaveLength(1);
    const id = storeFlagClaims[0]!.arguments[0]!;
    expect(ts.isStringLiteral(id)).toBe(true);
    expect((id as ts.StringLiteral).text).not.toBe("plugin-manager");

    // The flag has to be the store's own, read before any lazy view mounts.
    expect(source.text).toMatch(
      /const isPluginManagerOpen = usePluginManagerStore\(\(s\) => s\.isOpen\)/
    );
  });
});
