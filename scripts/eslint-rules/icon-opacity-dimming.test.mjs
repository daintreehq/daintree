import { RuleTester } from "eslint";
import { describe, it } from "vitest";

import rule from "./icon-opacity-dimming.js";

RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

const ruleTester = new RuleTester({
  languageOptions: {
    ecmaVersion: 2022,
    sourceType: "module",
    parserOptions: { ecmaFeatures: { jsx: true } },
  },
});

ruleTester.run("no-icon-opacity-dimming", rule, {
  valid: [
    {
      name: "icon with a solid theme token",
      code: `import { Settings2 } from "lucide-react";
        const A = () => <Settings2 className="mr-2 h-3.5 w-3.5 text-text-muted" />;`,
    },
    {
      name: "opacity-0 visibility toggle on an icon is allowed",
      code: `import { Filter } from "lucide-react";
        const A = () => <Filter className="w-3 h-3 opacity-0 group-hover:opacity-30" />;`,
    },
    {
      name: "opacity-100 is allowed",
      code: `import { Check } from "lucide-react";
        const A = () => <Check className="opacity-100" />;`,
    },
    {
      name: "modifier-prefixed opacity on an icon is allowed (scoped interaction state)",
      code: `import { X } from "lucide-react";
        const A = () => <X className="hover:opacity-50 disabled:opacity-50" />;`,
    },
    {
      name: "opacity on a non-icon element (disabled button) is out of scope",
      code: `const A = () => <button className="opacity-50 pointer-events-none">Go</button>;`,
    },
    {
      name: "grayscale on a non-icon pane is out of scope",
      code: `const A = () => <div className="opacity-75 grayscale">pane</div>;`,
    },
    {
      name: "conditional opacity on a non-icon span (semantic state) is out of scope",
      code: `const A = ({ isStale }) => (
        <span className={cn("flex", isStale && "opacity-50 transition-opacity duration-150")}>x</span>
      );`,
    },
    {
      name: "opacity on a non-imported lowercase element is out of scope",
      code: `const A = () => <span className="opacity-60">label</span>;`,
    },
  ],
  invalid: [
    {
      name: "bare opacity on a lucide icon",
      code: `import { Globe } from "lucide-react";
        const A = () => <Globe className="w-12 h-12 opacity-50" />;`,
      errors: [{ messageId: "opacity" }],
    },
    {
      name: "opacity on an icon imported from @/components/icons",
      code: `import { Activity } from "@/components/icons";
        const A = () => <Activity className="h-4 w-4 opacity-60" />;`,
      errors: [{ messageId: "opacity" }],
    },
    {
      name: "opacity on a *Icon component (brand glyph)",
      code: `import GitHubIcon from "./brands/GitHubIcon";
        const A = () => <GitHubIcon className="opacity-50" />;`,
      errors: [{ messageId: "opacity" }],
    },
    {
      name: "opacity on a member-expression icon (row.Icon)",
      code: `const A = ({ row }) => <row.Icon className="opacity-50" />;`,
      errors: [{ messageId: "opacity" }],
    },
    {
      name: "opacity on a raw svg element",
      code: `const A = () => <svg className="opacity-40" />;`,
      errors: [{ messageId: "opacity" }],
    },
    {
      name: "grayscale on an icon",
      code: `import { CircleDot } from "lucide-react";
        const A = () => <CircleDot className="grayscale" />;`,
      errors: [{ messageId: "grayscale" }],
    },
    {
      name: "opacity inside a cn() ternary on an icon",
      code: `import { GitPullRequest } from "lucide-react";
        const A = ({ missing, color }) => (
          <GitPullRequest className={cn("shrink-0", missing ? "opacity-50" : color)} />
        );`,
      errors: [{ messageId: "opacity" }],
    },
    {
      name: "grayscale inside a cn() logical expression on an icon",
      code: `import { CircleDot } from "lucide-react";
        const A = ({ missing }) => (
          <CircleDot className={cn("shrink-0", missing && "grayscale opacity-50")} />
        );`,
      errors: [{ messageId: "grayscale" }, { messageId: "opacity" }],
    },
    {
      name: "opacity in a template literal on an icon",
      code:
        'import { Clock } from "lucide-react";\n' +
        "const A = ({ size }) => <Clock className={`${size} opacity-40`} />;",
      errors: [{ messageId: "opacity" }],
    },
    {
      name: "opacity in clsx object form on an icon (quoted key)",
      code: `import { Search } from "lucide-react";
        const A = ({ dim }) => <Search className={cn({ "opacity-50": dim })} />;`,
      errors: [{ messageId: "opacity" }],
    },
    {
      name: "grayscale in clsx object form on an icon (unquoted identifier key)",
      code: `import { CircleDot } from "lucide-react";
        const A = ({ dim }) => <CircleDot className={cn({ grayscale: dim })} />;`,
      errors: [{ messageId: "grayscale" }],
    },
    {
      name: "aliased lucide import is still tracked as an icon",
      code: `import { Settings2 as SettingsIcon } from "lucide-react";
        const A = () => <SettingsIcon className="opacity-60" />;`,
      errors: [{ messageId: "opacity" }],
    },
  ],
});
