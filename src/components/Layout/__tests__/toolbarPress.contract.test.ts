import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";

// One press for every toolbar control: no change of size, a fill that lands on
// the first frame of the press and eases back on release, and on light themes a
// fill that deepens the hover rather than lightening it. The rules are asserted
// across every control class at once, so a control added to the list inherits
// them and a control that drifts from them fails by name.

const CSS = fs.readFileSync(
  path.resolve(__dirname, "../../../styles/components/toolbar.css"),
  "utf-8"
);
const PILL_SOURCE = fs.readFileSync(path.resolve(__dirname, "../ForgeStatPill.tsx"), "utf-8");

const CONTROLS = [
  ".toolbar-icon-button",
  ".toolbar-agent-button",
  ".toolbar-stat-pill",
  ".toolbar-project-pill",
] as const;

interface Rule {
  selectors: string[];
  body: string;
  index: number;
}

function splitTopLevel(list: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of list) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      out.push(current.trim());
      current = "";
    } else {
      current += ch;
    }
  }
  out.push(current.trim());
  return out.map((s) => s.replace(/\s+/g, " "));
}

const STRIPPED = CSS.replace(/\/\*[\s\S]*?\*\//g, (m) => " ".repeat(m.length));

/** Innermost rules, so rules nested in @media / @variant blocks are included. */
const RULES: Rule[] = Array.from(STRIPPED.matchAll(/([^{}]+)\{([^{}]*)\}/g)).map((m) => ({
  selectors: splitTopLevel(m[1]!.trim()),
  body: m[2]!,
  index: m.index!,
}));

function decl(body: string, prop: string): string | undefined {
  const m = new RegExp(`(?:^|;|\\s)${prop.replace(/-/g, "\\-")}\\s*:\\s*([^;]+);`).exec(body);
  return m?.[1]?.trim();
}

function rulesFor(selector: string): Rule[] {
  return RULES.filter((r) => r.selectors.includes(selector));
}

function ms(value: string): number {
  const m = /^(-?[\d.]+)(ms|s)$/.exec(value.trim());
  if (!m) throw new Error(`not a duration: ${value}`);
  return Number(m[1]) * (m[2] === "s" ? 1000 : 1);
}

describe("toolbar press contract", () => {
  it.each(CONTROLS)("%s keeps its size while pressed", (control) => {
    const pressRules = RULES.filter((r) =>
      r.selectors.some((s) => s.includes(control) && s.includes(":active"))
    );
    expect(pressRules.length).toBeGreaterThan(0);
    for (const rule of pressRules) {
      const transform = decl(rule.body, "transform");
      expect(transform === undefined || transform === "none", rule.selectors.join(", ")).toBe(true);
      const scale = decl(rule.body, "scale");
      expect(scale === undefined || scale === "none", rule.selectors.join(", ")).toBe(true);
    }
    // The base Button cva presses with a width-proportional `active:scale`; the
    // toolbar has to cancel it explicitly or it applies underneath.
    expect(rulesFor(`${control}:active`).some((r) => decl(r.body, "scale") === "none")).toBe(true);
  });

  it.each(CONTROLS)("%s snaps its pressed fill in and eases it back out", (control) => {
    const base = rulesFor(control)
      .map((r) => decl(r.body, "--_fill-duration"))
      .find(Boolean);
    const pressed = rulesFor(`${control}:active`)
      .map((r) => decl(r.body, "--_fill-duration"))
      .find(Boolean);
    expect(base, `${control} declares no release duration`).toBeDefined();
    expect(pressed, `${control}:active declares no press duration`).toBeDefined();
    expect(ms(pressed!)).toBe(0);
    expect(ms(base!)).toBeGreaterThan(0);

    // Whichever element paints the fill must time it with that variable.
    const painter = control === ".toolbar-project-pill" ? `${control}::before` : control;
    const transitions = rulesFor(painter)
      .map((r) => decl(r.body, "transition"))
      .filter((t): t is string => t !== undefined);
    expect(transitions.length, `${painter} has no transition`).toBeGreaterThan(0);
    for (const t of transitions) {
      expect(t).toMatch(/background-color\s+var\(--_fill-duration\)/);
      expect(t).not.toMatch(/\b(all|transform|scale|box-shadow)\b/);
    }
  });

  it("never lifts the pressed fill on light themes", () => {
    // The light armed lift (overlay-raised) is lighter than the light hover
    // tint, so a press painted with it read as the control letting go.
    const lightPress = RULES.filter((r) =>
      r.selectors.some((s) => s.includes(":where(.light") && s.includes(":active"))
    );
    expect(lightPress.length).toBeGreaterThan(0);
    for (const rule of lightPress) {
      expect(rule.body, rule.selectors.join(", ")).not.toContain("overlay-raised");
    }
  });

  it.each(CONTROLS)("%s shows the press over its armed state", (control) => {
    // Equal specificity: the press must come later in source than every armed
    // rule for the same control, light-scoped ones included.
    const owns = (s: string) =>
      s.includes(control) &&
      /\[aria-(?:expanded|pressed|checked)="true"\]|\[data-state="open"\]/.test(s);
    const armed = RULES.filter((r) => r.selectors.some(owns) && /background/.test(r.body));
    const presses = RULES.filter((r) =>
      r.selectors.some((s) => s.includes(control) && s.includes(":active"))
    ).filter((r) => /background/.test(r.body));
    expect(armed.length).toBeGreaterThan(0);
    expect(presses.length).toBeGreaterThan(0);
    const lastArmed = Math.max(...armed.map((r) => r.index));
    expect(Math.max(...presses.map((r) => r.index))).toBeGreaterThan(lastArmed);
  });

  it("draws every armed edge in the icon buttons' ring ink", () => {
    // The icon buttons draw armed as an inset ring; the pill's and the stat
    // pills' edges are a border (a ring would double the pill's own border, and
    // the stats capsule clips an outward one). Same ink either way.
    const ring = decl(rulesFor('.toolbar-icon-button[data-state="open"]')[0]!.body, "box-shadow");
    const ink = /var\((--theme-border-[\w-]+)\)/.exec(ring ?? "")?.[1];
    expect(ink, "icon armed ring names no border token").toBeDefined();
    expect(
      decl(rulesFor('.toolbar-project-pill[aria-expanded="true"]')[0]!.body, "border-color")
    ).toContain(ink!);
    expect(
      decl(rulesFor('.toolbar-stat-pill[aria-expanded="true"]::after')[0]!.body, "border")
    ).toContain(ink!);
  });

  it("leaves the stat pill's press, transition and open fill to toolbar.css", () => {
    // A transition utility on the pill would put the press timing back in the
    // Button cva's hands, and an `open &&` fill would bypass the armed token.
    const classes = PILL_SOURCE.match(/"(toolbar-stat-pill[^"]*)"/)?.[1]?.split(/\s+/);
    expect(classes).toBeDefined();
    expect(classes!.some((c) => c.startsWith("transition"))).toBe(false);
    expect(PILL_SOURCE).not.toMatch(/open\s*&&\s*"bg-/);
    // Open, it takes the same armed fill as the icon buttons.
    expect(decl(rulesFor('.toolbar-stat-pill[aria-expanded="true"]')[0]!.body, "background")).toBe(
      decl(rulesFor('.toolbar-icon-button[data-state="open"]')[0]!.body, "background")
    );
  });
});
