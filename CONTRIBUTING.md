# Contributing to Daintree

Thanks for your interest in Daintree.

**Daintree doesn't accept external pull requests.** All of the code is written by AI coding agents running through my own development workflow, which takes an issue through research, planning, implementation, tests and review in one pass. That pipeline is set up and running, and I'd rather it did the work than merge code written outside it. Pull requests from outside the project are closed without review, so please don't spend your time on one.

**Issues are a different story: they're very welcome.** Issues are how Daintree decides what to improve. Every one gets read, and every one is taken into account. Writing the code stopped being the expensive part a while ago. Knowing precisely what's wrong, where it lives, and which decisions are still open is the part that's still hard, and that's exactly what a good issue does. A well-researched issue is the most useful thing you can send.

If something here is unclear, open an issue. The contribution guide is code too.

## Filing a good issue

One problem per issue. If you're writing "and also", it's two issues. No umbrella issues that collect five loosely related things: they can't be worked, only re-read.

What a good issue does:

- **Leads with observed behaviour, not your proposed fix.** What you did, what happened, what you expected. If you have a fix in mind, put it at the end, clearly marked as your suggestion. A small diff showing the idea is fine as context, but it's read as a suggestion, not reviewed as a patch.
- **Cites the code.** `electron/services/mcp-server/resourceOwnership.ts:42` beats "somewhere in the MCP server". If you traced the mechanism, say what it is. If you're guessing, say so. A labelled guess is useful; a guess dressed up as a finding costs a round trip.
- **Says what you ruled out.** The paths you checked and eliminated are often the most valuable paragraph in the report, because nobody else has to walk them again.
- **Separates the invariant from the request.** If the current behaviour is deliberate, say so and design around it. "This is intentional and here's why, but it costs X" is a far stronger issue than "this is broken".
- **Lists the open decisions.** Name the calls that aren't yours to make (surface shape, tier, scope, what's in and what's out) and give your recommendation for each. That's what turns a report into something that can be executed without a conversation.
- **Includes a reproduction.** Daintree version, OS, steps. Which agent CLI, if it's agent-related. A repro that actually fails is worth more than a paragraph describing one.
- **Corrects itself in the open.** If your premise turns out to be wrong, rewrite the body, retitle it, and say what changed. That's a good issue getting better.

What doesn't help: a title with no body, "would be nice if", a stack of feature requests in one thread, screenshots with no context, or a support question filed as a bug. If you're not sure whether something belongs in Daintree at all, read [`docs/feature-curation.md`](docs/feature-curation.md) first. It's the rubric for what deliberately doesn't get built.

Coding agents are a perfectly good way to research an issue: point one at the codebase and have it trace the bug. You're still responsible for what you post, so read it before you file it, and check that the file paths and line numbers it cites are real.

## Building from source

You don't need a local build to file an issue, but it helps when you're tracing a bug or confirming a fix landed.

```bash
git clone https://github.com/daintreehq/daintree.git
cd daintree
npm install        # runs the postinstall rebuild for node-pty
npm run dev        # Main + Renderer with HMR
```

A few things worth knowing up front:

- **Node version:** use the exact version pinned in `.nvmrc`. It's kept in sync with `.node-version` and `package.json`'s `engines.node` floor (`npm run check` enforces this).
- **Native modules:** `node-pty` must be rebuilt against Electron's ABI. The `postinstall` hook does this for you. If you hit errors, run `npm run rebuild`.
- **Don't use `--ignore-scripts`** during install. It skips the native rebuild and the app will crash on startup.

[`docs/development.md`](docs/development.md) covers the commands, architecture and debugging tools, and [`docs/README.md`](docs/README.md) indexes the rest.

## License

Daintree is licensed under the [Apache License 2.0](LICENSE). The Daintree name and logo are not covered by that license; see [TRADEMARKS.md](TRADEMARKS.md).

## Code of Conduct

Be kind, be specific, assume good faith. Harassment, personal attacks, and bad-faith engagement will get you removed from the project. When in doubt, err on the side of generosity.

## Questions

- **Found a bug?** Open an issue with a reproduction.
- **Have a feature idea?** Open an issue describing the problem first, not the solution.
- **Not sure if something belongs in Daintree?** See [`docs/feature-curation.md`](docs/feature-curation.md), then ask on an issue.
- **Stuck on something in this guide?** Open an issue saying what tripped you up and the guide gets fixed.
