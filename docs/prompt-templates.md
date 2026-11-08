# Your own prompt templates

A reusable prompt kept as a Markdown file in one folder works in every agent's composer, in every project, without writing a plugin or keeping a copy in each agent CLI's own command format.

## The folder

Templates live in `~/.daintree/templates/`, one Markdown file each. Settings → CLI agents → General → Prompt templates shows the path and has an Open folder button, which creates the folder if it isn't there yet. Nothing else creates it, and Daintree ships no templates to put in it (#15759).

## The file

```markdown
---
title: Review a change
description: Review a change for correctness and missing tests
args:
  - name: focus
    label: Focus
    required: true
---

Review this change, focusing on {{focus}}.
```

The frontmatter holds the same fields as a [plugin's prompt template](./plugins/contribution-points.md#prompt-templates--shipped), with the same limits:

| Field | Required | Notes |
| --- | --- | --- |
| `title` | yes | The row's name in the `/` menu and the title of its form. At most 80 characters. |
| `description` | yes | The row's summary line. At most 300 characters. |
| `args` | no | Up to 20 single-line text fields, each `{ name, label, required? }`. `name` is lowercase letters, digits and underscores, starting with a letter. |

Everything after the closing `---` is the prompt, at most 8192 characters. `{{name}}` is replaced by the argument of that name, and every `{{name}}` must name a declared argument. That is the only expansion there is: a template is inert text, with no shell or variable expansion. The file's name, without `.md`, is its identity and can be typed after `/` to find it. Any other frontmatter key is refused, including `id` and `body`, which the file's name and text supply.

Only visible `.md` files directly in the folder are read, in file name order: no subfolders. Links to files kept elsewhere are followed, and so is a linked folder. A file over 64 KB is refused, and only the first 100 files are read.

## In the composer

Type `/` in any agent's composer. Templates are under the "Prompt templates" heading after the agent's own commands, marked "You" and ahead of any plugin's with an equal match. Choosing one does exactly what choosing a plugin's does: it opens a form when the template has arguments and otherwise fills the draft. It never submits.

## Changes

There's no restart and no watcher. The folder is read each time a `/` menu opens and each time the settings section is opened or its window comes back, so an added, edited or removed file shows the next time you look.

## A file that can't be used

A bad file is left out and the others still load. The `/` menu says some templates weren't loaded and links to the settings section, which names each file and what's wrong with it. A file caught half-saved is reported only until the next read.

## Remote Hosts

Your templates are yours, not the machine's, so they come from the machine at the keyboard. A window driving a Remote Host reads this machine's folder and offers those templates beside the plugin templates of the host it's working on; the host never sees the folder or the files. A window on the host itself reads the host's folder. See [channel locality](./architecture/remote-hosts.md#channel-locality).
