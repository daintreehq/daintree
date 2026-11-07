import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const ELECTRON_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

// A window restored for a host's project opens on this machine's picker, so
// its project id never reaches window creation: the host's project has to be
// handed through main.ts and createWindow.ts by name, or the window opens at
// the last bounds any window saved (#15535). Neither file can be imported by
// a unit test, so the wiring is read from their source.

function parse(relativePath: string): ts.SourceFile {
  const file = path.join(ELECTRON_ROOT, relativePath);
  return ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
}

function callsTo(root: ts.Node, name: string): ts.CallExpression[] {
  const found: ts.CallExpression[] = [];
  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === name
    ) {
      found.push(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(root);
  return found;
}

function mentions(root: ts.Node, identifier: string): boolean {
  if (ts.isIdentifier(root) && root.text === identifier) return true;
  return ts.forEachChild(root, (child) => mentions(child, identifier) || undefined) ?? false;
}

describe("a restored host window's bounds", () => {
  it("are handed from main.ts to the window it sets up", () => {
    const [setup] = callsTo(parse("main.ts"), "setupBrowserWindow");
    const options = setup?.arguments[1];

    expect(options && ts.isObjectLiteralExpression(options)).toBe(true);
    const handed = (options as ts.ObjectLiteralExpression).properties.find(
      (property) =>
        ts.isPropertyAssignment(property) &&
        ts.isIdentifier(property.name) &&
        property.name.text === "remoteWorkspaceKey"
    ) as ts.PropertyAssignment | undefined;
    expect(handed && mentions(handed.initializer, "remoteWorkspaceKey")).toBe(true);
  });

  it("are looked up from the host's project when the window is created", () => {
    const [create] = callsTo(parse("window/createWindow.ts"), "createWindowWithState");
    const key = create?.arguments[1];

    expect(key && ts.isCallExpression(key) && ts.isIdentifier(key.expression)).toBe(true);
    expect(((key as ts.CallExpression).expression as ts.Identifier).text).toBe("resolveBoundsKey");
    expect(mentions(key!, "remoteWorkspaceKey")).toBe(true);
  });

  it("are dropped when their host is removed", () => {
    const source = parse("remote/client/initClient.ts");
    let cleanups: ts.Node | undefined;
    const visit = (node: ts.Node) => {
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.name.text === "HOST_STATE_CLEANUPS"
      ) {
        cleanups = node.initializer;
      }
      ts.forEachChild(node, visit);
    };
    visit(source);

    expect(cleanups && callsTo(cleanups, "pruneWindowStatesForHost")).toHaveLength(1);
  });
});

// The same two files, for the same reason: main.ts and createWindow.ts can't be
// imported here, and a Canopy window that lost its kind would boot the project
// shell and take a project's place in every window list.
describe("the Canopy window's wiring", () => {
  const createWindow = parse("window/createWindow.ts");

  /** The ternaries that branch on being a Canopy window. */
  function canopyTernaries(): ts.ConditionalExpression[] {
    const found: ts.ConditionalExpression[] = [];
    const visit = (node: ts.Node) => {
      if (
        ts.isConditionalExpression(node) &&
        ts.isIdentifier(node.condition) &&
        node.condition.text === "canopyWindow"
      ) {
        found.push(node);
      }
      ts.forEachChild(node, visit);
    };
    visit(createWindow);
    return found;
  }

  it("is built by main.ts as a canopy window", () => {
    const [factory] = callsTo(parse("main.ts"), "setCanopyBrowserWindowFactory");
    const [setup] = factory ? callsTo(factory, "setupBrowserWindow") : [];
    const options = setup?.arguments[1] as ts.ObjectLiteralExpression;
    const kind = options.properties.find(
      (property): property is ts.PropertyAssignment =>
        ts.isPropertyAssignment(property) &&
        ts.isIdentifier(property.name) &&
        property.name.text === "kind"
    );

    expect(kind && ts.isStringLiteral(kind.initializer) && kind.initializer.text).toBe("canopy");
  });

  it("takes being a Canopy window from the kind it was asked for", () => {
    const found: ts.VariableDeclaration[] = [];
    const visit = (node: ts.Node) => {
      if (ts.isVariableDeclaration(node) && node.name.getText() === "canopyWindow")
        found.push(node);
      ts.forEachChild(node, visit);
    };
    visit(createWindow);

    expect(found.map((declaration) => declaration.initializer?.getText())).toEqual([
      'kind === "canopy"',
    ]);
  });

  it("marks only a Canopy window's view as holding no project", () => {
    const [mark] = callsTo(createWindow, "markProjectlessView");
    const guard = mark?.parent.parent;

    expect(guard && ts.isIfStatement(guard) && guard.expression.getText()).toBe("canopyWindow");
    expect(guard && ts.isIfStatement(guard) && guard.thenStatement).toBe(mark?.parent);
  });

  it("passes the Canopy role to a Canopy window's renderer alone", () => {
    expect(canopyTernaries().some((node) => mentions(node.whenTrue, "CANOPY_WINDOW_ARG"))).toBe(
      true
    );
    expect(canopyTernaries().some((node) => mentions(node.whenFalse, "CANOPY_WINDOW_ARG"))).toBe(
      false
    );
  });

  // Its bounds are kept apart (#16336): the project placement would save them as
  // the fallback the next project window opens at.
  it("places a Canopy window at bounds of its own, and a project window as before", () => {
    const placed = canopyTernaries().find((node) => mentions(node, "createWindowWithState"));

    const [separate] = placed ? callsTo(placed.whenTrue, "createSeparateWindowWithState") : [];
    const key = separate?.arguments[1];
    expect(key && ts.isIdentifier(key) && key.text).toBe("CANOPY_BOUNDS_KEY");
    expect(placed && mentions(placed.whenTrue, "createWindowWithState")).toBe(false);
    expect(placed && mentions(placed.whenFalse, "createWindowWithState")).toBe(true);
    expect(placed && mentions(placed.whenFalse, "createSeparateWindowWithState")).toBe(false);
  });

  it("is built by main.ts with the reveal mode it was asked for", () => {
    const [factory] = callsTo(parse("main.ts"), "setCanopyBrowserWindowFactory");
    const callback = factory?.arguments[0];
    const [setup] = factory ? callsTo(factory, "setupBrowserWindow") : [];
    const options = setup?.arguments[1] as ts.ObjectLiteralExpression;
    const reveal = options.properties.find((property) => property.name?.getText() === "revealMode");

    expect(callback && ts.isArrowFunction(callback)).toBe(true);
    const [parameter] = (callback as ts.ArrowFunction).parameters;
    // Handed on as it came, not transformed on the way.
    const handed =
      reveal && ts.isShorthandPropertyAssignment(reveal)
        ? reveal.name.text
        : reveal && ts.isPropertyAssignment(reveal) && ts.isIdentifier(reveal.initializer)
          ? reveal.initializer.text
          : undefined;
    expect(handed).toBe(parameter!.name.getText());
  });

  describe("in main.ts's launch restore", () => {
    const main = parse("main.ts");

    function property(
      call: ts.CallExpression | undefined,
      name: string
    ): ts.PropertyAssignment | ts.ShorthandPropertyAssignment | undefined {
      const deps = call?.arguments[0];
      if (!deps || !ts.isObjectLiteralExpression(deps)) return undefined;
      return deps.properties.find(
        (p): p is ts.PropertyAssignment | ts.ShorthandPropertyAssignment =>
          (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) &&
          p.name.getText() === name
      );
    }

    function initializerOf(name: string): ts.Expression | undefined {
      let found: ts.Expression | undefined;
      const visit = (node: ts.Node) => {
        if (ts.isVariableDeclaration(node) && node.name.getText() === name) {
          found = node.initializer;
        }
        ts.forEachChild(node, visit);
      };
      visit(main);
      return found;
    }

    /** The binding the manifest's `canopyWindow` marker is read into. */
    function markerBinding(): ts.BindingElement | undefined {
      let found: ts.BindingElement | undefined;
      const visit = (node: ts.Node) => {
        if (ts.isBindingElement(node) && node.propertyName?.getText() === "canopyWindow") {
          found = node;
        }
        ts.forEachChild(node, visit);
      };
      visit(main);
      return found;
    }

    it("reopens it once the focused window is up, only when the manifest had it open", () => {
      const hook = property(callsTo(main, "restoreWindowFleet")[0], "onPrimaryWindowUp");
      const guard = hook && ts.isPropertyAssignment(hook) ? hook.initializer : undefined;
      expect(guard && ts.isConditionalExpression(guard)).toBe(true);
      const conditional = guard as ts.ConditionalExpression;

      // The guard is the marker as read: no default stands in for a missing one.
      const binding = markerBinding();
      expect(binding?.name.getText()).toBe(conditional.condition.getText());
      expect(binding?.initializer).toBeUndefined();

      expect(ts.isIdentifier(conditional.whenTrue)).toBe(true);
      const reopen = initializerOf(conditional.whenTrue.getText());
      expect(reopen && callsTo(reopen, "restoreCanopyWindow")).toHaveLength(1);
      expect(ts.isIdentifier(conditional.whenFalse) && conditional.whenFalse.text).toBe(
        "undefined"
      );
    });

    it("reopens it the same way when a crash recovery brings the fleet back", () => {
      const fleetHook = property(callsTo(main, "restoreWindowFleet")[0], "onPrimaryWindowUp");
      const crashHook = property(callsTo(main, "restoreFleetAfterCrash")[0], "restoreCanopyWindow");
      const reopen =
        fleetHook && ts.isPropertyAssignment(fleetHook)
          ? (fleetHook.initializer as ts.ConditionalExpression).whenTrue.getText()
          : undefined;

      expect(reopen).toBeDefined();
      expect(
        crashHook && ts.isPropertyAssignment(crashHook) && crashHook.initializer.getText()
      ).toBe(reopen);
    });
  });
});
