# Gripterm

Observe, name and restore your Claude Code terminals inside VS Code.

Running several Claude Code sessions at once costs you the two things a terminal
tab cannot give back: you stop knowing **which terminal is which**, and you lose
every conversation when the editor restarts. Gripterm keeps both.

- **A named terminal.** Give a session a task and notes; they belong to you and
  no agent overwrites them.
- **Live state without polling.** Working, waiting for a permission, finished —
  observed through Claude Code hooks, not by scraping terminal output.
- **Restore after a restart.** Sessions come back through `--resume`, with their
  task and notes, and without you typing a session id.
- **Every window sees every terminal.** Registry is per machine, so a second
  window — even in another editor — shows the same terminals in read-only mode.

## Requirements

| | |
|---|---|
| VS Code | 1.94 or newer |
| Node.js | 20 or newer (development only) |
| Claude Code CLI | **2.1.225** — see below |

The supported CLI build is pinned. The extension compares it with what is
actually on your PATH and warns on a mismatch, because a patch release can move
the behaviour the extension relies on. Check yours with `claude --version`.

## Status

Early development. Nothing here is released yet.

## Development

```bash
pnpm install
pnpm build          # tsc project references, both packages
pnpm lint           # eslint, zero warnings allowed
pnpm test           # unit tests for the domain
pnpm test:integration   # downloads a real VS Code and runs inside it
```

Press <kbd>F5</kbd> to launch an Extension Development Host with the extension
loaded.

The workspace is a pnpm monorepo of two packages. `@gripterm/core` holds the
domain and infrastructure and **must not import the editor API** — that boundary
is enforced by ESLint and, independently, by keeping `@types/vscode` out of its
dependencies. `gripterm` is the extension: the only place that talks to VS Code.

## License

Apache-2.0. The `LICENSE` and `NOTICE` files are added before the first public
release; until then the terms above are the stated intent.
