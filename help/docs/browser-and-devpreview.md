# Browser and Dev Preview

## Embedded Browser

Canopy includes an embedded browser panel for viewing web content alongside your agent terminals. This is useful for:

- Previewing localhost development servers
- Viewing documentation while working
- Checking agent-generated web output
- Debugging frontend applications with the console visible

### Opening a Browser Panel

Open the panel palette (Cmd+N) and select "Browser". Enter a URL to navigate to.

### Portal

The **Portal** is a tabbed dock for web-based interfaces. Toggle it with **Cmd+\\**.

Portal tab shortcuts (when portal is focused):

- **Cmd+T** — New tab
- **Cmd+W** — Close tab
- **Ctrl+Tab** / **Ctrl+Shift+Tab** — Next/previous tab

The portal is ideal for keeping web-based AI agent UIs (like ChatGPT or Claude.ai) open alongside your terminal-based agents.

## Dev Server Preview

The Dev Preview panel auto-detects and manages development servers running in your worktrees.

### How It Works

1. Canopy monitors your worktrees for running dev servers (Vite, Next.js, Webpack, etc.)
2. When a dev server is detected on a localhost port, it appears in the Dev Preview panel
3. The preview shows a live, embedded view of your application
4. Changes to your code trigger hot-reloads visible in the preview

### Opening a Dev Preview

Open the panel palette (Cmd+N) and select "Dev Preview". It will auto-detect available dev servers in the current worktree.

### Dev Server Management

Canopy tracks dev servers per worktree. When you switch worktrees, the Dev Preview updates to show servers associated with that worktree. Servers from inactive worktrees continue running in the background.

## Tips

- Use the browser panel for documentation and the dev preview for your app — they serve different purposes
- The dev preview is read-only; it shows your app but you can't edit code from it (use your editor for that)
- Multiple dev servers can run simultaneously across different worktrees
