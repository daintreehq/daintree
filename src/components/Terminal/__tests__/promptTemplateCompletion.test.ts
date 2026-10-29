import { describe, expect, it } from "vitest";
import type { PluginPromptTemplate } from "@/store/pluginRuntimeStore";
import {
  promptTemplateTokenCut,
  scorePromptTemplate,
  toPromptTemplateItems,
} from "../promptTemplateCompletion";

function template(
  key: string,
  title: string,
  overrides: Partial<PluginPromptTemplate["template"]> & { pluginName?: string } = {}
): PluginPromptTemplate {
  const { pluginName = "Acme CRM", ...rest } = overrides;
  return {
    key,
    pluginId: "acme",
    pluginName,
    projectId: null,
    template: {
      id: key.split("::")[1] ?? key,
      title,
      description: "Reconcile the ledger against the bank export.",
      body: "Do it.",
      args: [],
      ...rest,
    },
  };
}

const reconcile = template("acme::reconcile", "Reconcile this month");
const invoice = template("acme::dunning", "Chase overdue invoices", {
  args: [{ name: "client", label: "Client" }],
});
const standup = template("team::standup", "Write the standup", { pluginName: "Team Notes" });

describe("scorePromptTemplate", () => {
  it("matches every template on a bare `/`", () => {
    expect(scorePromptTemplate(reconcile, "")).toBe(0);
  });

  it("matches a word typed from the title, the id or the plugin's name", () => {
    expect(scorePromptTemplate(reconcile, "month")).not.toBeNull();
    expect(scorePromptTemplate(invoice, "chase-inv")).not.toBeNull();
    // In the id alone, not the title or the plugin's name.
    expect(scorePromptTemplate(invoice, "dun")).not.toBeNull();
    expect(scorePromptTemplate(standup, "team")).not.toBeNull();
  });

  it("ignores the description, which every keystroke would otherwise trip over", () => {
    expect(scorePromptTemplate(reconcile, "bank")).toBeNull();
  });

  it("ranks the start of the title above a later word, and both above the plugin's name", () => {
    const start = scorePromptTemplate(reconcile, "rec")!;
    const word = scorePromptTemplate(template("x::y", "Monthly reconcile"), "rec")!;
    const plugin = scorePromptTemplate(template("x::y", "Monthly", { pluginName: "Rec" }), "rec")!;
    expect(start).toBeGreaterThan(word);
    expect(word).toBeGreaterThan(plugin);
  });

  it("matches nothing for a query of punctuation alone", () => {
    expect(scorePromptTemplate(reconcile, "--")).toBeNull();
  });

  it("matches words in any script", () => {
    expect(scorePromptTemplate(template("jp::k", "請求書を確認"), "請求")).not.toBeNull();
  });
});

describe("toPromptTemplateItems", () => {
  it("lists every template in declared order on a bare `/`", () => {
    const items = toPromptTemplateItems([reconcile, invoice, standup], "");
    expect(items.map((item) => item.template?.key)).toEqual([
      "acme::reconcile",
      "acme::dunning",
      "team::standup",
    ]);
  });

  it("puts the best match first and drops what doesn't match", () => {
    const later = template("acme::later", "Monthly write-up");
    const items = toPromptTemplateItems([later, reconcile, standup], "write");
    expect(items.map((item) => item.template?.key)).toEqual(["team::standup", "acme::later"]);
  });

  it("gives each row the plugin's name, a band, a key of its own and what picking it does", () => {
    const [row, formRow] = toPromptTemplateItems([reconcile, invoice], "");
    expect(row).toMatchObject({
      label: "Reconcile this month",
      badge: "Acme CRM",
      group: "Prompt templates",
      template: { key: "acme::reconcile", opensForm: false },
    });
    expect(formRow!.template?.opensForm).toBe(true);
  });

  it("keeps two plugins' templates apart when they declare the same id", () => {
    const ours = template("acme::reconcile", "Reconcile this month");
    const theirs = template("ledger::reconcile", "Reconcile this month", { pluginName: "Ledger" });
    const items = toPromptTemplateItems([ours, theirs], "");
    expect(new Set(items.map((item) => item.key)).size).toBe(2);
    expect(items.map((item) => item.template?.key)).toEqual([
      "acme::reconcile",
      "ledger::reconcile",
    ]);
  });
});

describe("promptTemplateTokenCut", () => {
  it("takes a token at the end with the whitespace before it", () => {
    const draft = "Fix the loop.\n /rec";
    expect(promptTemplateTokenCut(draft, { from: 15, to: 19 })).toEqual({ from: 13, to: 19 });
  });

  it("takes a token followed only by whitespace to the end of the draft", () => {
    const draft = "Fix it /rec  \n";
    expect(promptTemplateTokenCut(draft, { from: 7, to: 11 })).toEqual({ from: 6, to: 14 });
  });

  it("takes a token inside the draft with the one space after it", () => {
    const draft = "Fix /rec the loop";
    expect(promptTemplateTokenCut(draft, { from: 4, to: 8 })).toEqual({ from: 4, to: 9 });
  });

  it("takes a token that opens the draft with the space after it", () => {
    expect(promptTemplateTokenCut("/rec then", { from: 0, to: 4 })).toEqual({ from: 0, to: 5 });
  });

  it("leaves a line break after a token in place", () => {
    expect(promptTemplateTokenCut("/rec\nthen", { from: 0, to: 4 })).toEqual({ from: 0, to: 4 });
  });
});
