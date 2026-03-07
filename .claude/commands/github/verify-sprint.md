---
description: Generate a manual verification PDF for a completed sprint and post a summary comment on the sprint issue.
argument-hint: <sprint-issue-number-or-url e.g. 2513>
---

# Sprint Verification Guide Generator

You generate a professional manual verification PDF for a completed Canopy sprint and post a verification comment to the sprint issue.

**Input:** `$ARGUMENTS` -- a GitHub issue number or full URL for the sprint orchestration issue.

---

## Phase 0: Parse Input

Extract the issue number from `$ARGUMENTS`. It may be:

- A plain number: `2513`
- A full URL: `https://github.com/canopyide/canopy/issues/2513`
- A shorthand: `#2513`

The repo is `canopyide/canopy`. Always use `gh` CLI for GitHub access.

---

## Phase 1: Validate Sprint Completion

### Step 1: Fetch the sprint issue

```bash
gh issue view <number> --repo canopyide/canopy --json title,body,state
```

Read the issue body to find all referenced sub-issues. Look for issue numbers in the format `#NNNN` in the body (dependency graph, execution queue, etc.).

### Step 2: Check all sub-issues are closed

For each sub-issue found:

```bash
gh issue view <sub-issue> --repo canopyide/canopy --json title,state,closedAt
```

**All sub-issues must be in CLOSED state.** If any are open, stop and report which issues are still open. Do not generate the verification document for an incomplete sprint.

### Step 3: Find and validate merged PRs

For each sub-issue, find the associated merged PR:

```bash
gh pr list --repo canopyide/canopy --search "is:merged <sub-issue-number>" --json number,title,mergedAt,files --limit 5
```

Verify each sub-issue has at least one merged PR. Collect the PR numbers, titles, and changed files for the document.

### Step 4: Review the actual code changes

For each PR, fetch the diff to understand what was changed:

```bash
gh pr diff <pr-number> --repo canopyide/canopy
```

This is critical for writing accurate verification steps. Understand what each change does so you can describe precise manual testing steps.

---

## Phase 2: Generate the Verification Document

### Document Structure

Create a Markdown file with the following structure. Each issue gets its own page.

**Front matter:**

```yaml
---
title: "Sprint #NNNN -- Manual Verification"
subtitle: "<sprint-title>"
date: "<today's date>"
mainfont: "Avenir Next"
monofont: "IBM Plex Mono"
fontsize: 11pt
---
```

**Typst styling block (immediately after front matter):**

````markdown
```{=typst}
#set text(font: "Avenir Next", size: 11pt)
#show raw: set text(font: "IBM Plex Mono", size: 9pt)
#show heading.where(level: 1): it => {
  set text(size: 1.3em, weight: "bold")
  it
  v(-0.6em)
  line(length: 100%, stroke: 0.5pt + luma(200))
}
#show link: it => underline(text(fill: rgb("#10b981"), it))
```
````

**Icon block (centered, after styling):**

````markdown
```{=typst}
#align(center)[
  #image("icon-dark.svg", width: 48pt)
]
```
````

**Intro paragraph:** Brief description of the sprint, link to the sprint issue, note that automated tests pass.

**Per-issue sections:** Each issue gets a `# N. <title> -- [#NNNN](url)` heading followed by a page break. The format for each section:

1. **One-line description** of what changed and why.
2. **Setup:** (if needed) -- what state to create before testing.
3. **Verify:** -- numbered list of specific actions and expected outcomes. Be precise: what to click, what to press, what to look for.
4. **What would be broken:** -- one-line description of the failure mode this fix addresses.

### Writing Guidelines

- Be direct and concise. The reader is familiar with Canopy.
- Use `Cmd+X` for keyboard shortcuts (this is a macOS app).
- Use `--` (double dash) for em-dashes, never Unicode em-dash characters.
- Never use Unicode arrow characters like →. Use "then" or commas instead.
- For the icon change issue (#2507 or similar visual issues), include a subjective quality check: "Does the icon look good? Is it visually balanced?"
- Include bash commands for any filesystem verification steps (clipboard GC, etc.).
- Keep each issue to roughly one page of content.

### Page Breaks

Between each issue section, insert a raw Typst page break:

````markdown
```{=typst}
#pagebreak()
```
````

---

## Phase 3: Build the PDF

### Step 1: Create a temp directory and assemble files

```bash
TMPDIR=$(mktemp -d)
```

Copy the icon SVG to the temp directory:

```bash
cp /Users/gpriday/Projects/Canopy/canopy-electron/build/icon-dark.svg "$TMPDIR/icon-dark.svg"
```

Write the markdown file to the temp directory.

### Step 2: Convert to PDF

```bash
cd "$TMPDIR" && pandoc sprint-verification.md -o sprint-verification.pdf --pdf-engine=typst
```

Check for errors. Warnings about variable fonts can be ignored. Actual errors need to be fixed.

### Step 3: Copy to Downloads and clean up

The output filename must follow this convention:

```
canopy-sprint-<issue-number>-verification.pdf
```

```bash
cp "$TMPDIR/sprint-verification.pdf" ~/Downloads/canopy-sprint-<number>-verification.pdf
rm -rf "$TMPDIR"
```

---

## Phase 4: Upload PDF and Post Verification Comment

### Step 1: Upload the PDF to the attachments-store release

The repo has a dedicated GitHub release tagged `attachments-store` that acts as a file hosting bucket for issue attachments.

```bash
gh release upload attachments-store ~/Downloads/canopy-sprint-<number>-verification.pdf --repo canopyide/canopy --clobber
```

### Step 2: Get the download URL

```bash
ASSET_URL=$(gh release view attachments-store --repo canopyide/canopy --json assets \
  --jq '.assets[] | select(.name=="canopy-sprint-<number>-verification.pdf") | .url')
```

### Step 3: Post the verification comment

The comment should include:

- A table of all sub-issues and their merged PRs
- A link to download the verification PDF
- Next steps for the verifier

Build the table dynamically from the data gathered in Phase 1. The comment format:

```bash
gh issue comment <number> --repo canopyide/canopy --body "$(cat <<EOF
## Manual Verification Guide

All issues in this sprint have been resolved and their pull requests merged.

### Merged Pull Requests

| # | Issue | PR | Status |
|---|-------|----|--------|
| 1 | #XXXX -- Title | #YYYY | Merged |
| ... | ... | ... | ... |

### Next Steps

Download the verification guide and work through each section (one page per issue) to manually verify all fixes.

[canopy-sprint-NNNN-verification.pdf](${ASSET_URL})
EOF
)"
```

**Note:** The `ASSET_URL` variable must be interpolated into the heredoc (use `EOF` without quotes, not `'EOF'`).

---

## Technical Notes

- **Font:** Avenir Next (macOS system font with proper bold weight support in Typst). IBM Plex Mono for code. Install IBM Plex Mono via `brew install --cask font-ibm-plex-mono` if not present.
- **PDF engine:** Typst via Pandoc. Install with `brew install pandoc typst`.
- **Icon:** `build/icon-dark.svg` -- a dark-on-transparent version of the Canopy logo for light-mode documents.
- **Links:** Underlined in Canopy accent green (#10b981) for clear clickability.
- **Headings:** Bold with a thin gray underline rule for clean visual hierarchy.
- **Page breaks:** Use raw Typst blocks: ` ```{=typst}\n#pagebreak()\n``` `
- **Character safety:** Avoid Unicode em-dashes (use `--`), arrows (use text), and other non-ASCII that may render as boxes in Typst's default font configuration.
- **Attachments:** PDFs are uploaded to the `attachments-store` GitHub release (tagged `attachments-store`, marked as prerelease). Use `gh release upload attachments-store <file> --clobber` to upload, then link the asset URL in the issue comment.
- **This is a Canopy-specific command.** The repo is `canopyide/canopy`. Always use `gh` CLI for GitHub access. The app runs on macOS with Electron. Keyboard shortcuts use `Cmd`.
