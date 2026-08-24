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
- **A panel of your own, if you want one.** Gripterm can make the terminal
  itself and show it beside what is known about it — see below.

## Requirements

| | |
|---|---|
| VS Code | 1.94 or newer |
| Node.js | 20 or newer (development only) |
| Claude Code CLI | **2.1.225** — see below |

The supported CLI build is pinned. The extension compares it with what is
actually on your PATH and warns on a mismatch, because a patch release can move
the behaviour the extension relies on. Check yours with `claude --version`.

## Which engine makes the terminal

`gripterm.terminal.engine` chooses, and the default is **`editor`**.

| | `editor` | `own` |
|---|---|---|
| Who makes the terminal | the editor | Gripterm |
| Where the agent is | wherever `gripterm.launch.location` says: a group of the editor area, an editor tab, or the terminal panel | in the Gripterm panel: the terminal on the left, what is known about it on the right, and a strip of tabs when there are several |
| Platforms | wherever the editor runs | Windows and macOS. On Linux there is no prebuilt native addon to load, so the editor makes the terminal instead and the log says so |
| `gripterm.launch.mode: shell` | yes | refused the same way: the editor makes the terminal and the log says so |
| What other extensions add to a terminal | reaches the agent: the channel from the Claude Code extension to the CLI, the git askpass of the editor | mostly does not: it arrives through a mechanism the editor applies to its own terminals, and no extension can read another one. The Claude Code channel is the exception — the CLI finds that extension by itself, with no port from us — and it is **off unless you turn on `gripterm.terminal.ideChannel`**: while it is on, the agent is handed the file you have open and the text you have selected, and the editor's own terminal takes the focus from the Gripterm panel every time you send a prompt |
| History | the editor's own scrollback | 1000 lines, and less if the panel was destroyed and redrawn |
| Search over the history | the editor's | not built |

Both engines keep the same records, the same restore and the same
notifications — the difference is who owns the bytes. Every Gripterm setting,
this one included, is read once when the window loads, so a change needs a
window reload; the extension says so when you make one.

## Status

Early development. Nothing here is released yet.

## Development

```bash
pnpm install
pnpm build          # tsc project references, both packages
pnpm lint           # eslint, zero warnings allowed
pnpm test           # builds, then unit tests
pnpm test:integration   # downloads a real VS Code and runs inside it, twice: once per engine
pnpm test:vsix      # packages, installs the archive into a profile of its own, runs it
```

Press <kbd>F5</kbd> to launch an Extension Development Host with the extension
loaded, or start one by hand with `--extensionDevelopmentPath`. Either way it
gets a store of its own under the extension's global storage, and says so on
opening.

That is the rule everywhere outside a released window. `gripterm.storage.path`
defaults to `~/.gripterm`, which is where a person's terminals, conversations
and trash live -- a run that announced a window there, seeded records there or
swept that trash could not take any of it back. So the test runners write the
setting into the user data they hand to VS Code, a development host falls back
to a store of its own, and a **test** host with no setting refuses to activate
at all: nobody is watching a suite, so there is nobody to read a warning.

The workspace is a pnpm monorepo of two packages. `@gripterm/core` holds the
domain and infrastructure and **must not import the editor API** — that boundary
is enforced by ESLint and, independently, by keeping `@types/vscode` out of its
dependencies. `gripterm` is the extension: the only place that talks to VS Code.

## License

Apache-2.0. The licence text travels with the extension as `LICENSE.txt`, and
`NOTICE.md` names what else does: `node-pty`, `@xterm/xterm` and the icon font,
each under its own terms.
