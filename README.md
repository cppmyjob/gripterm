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

`gripterm.terminal.engine` chooses, and the default is **`own`**.

The default moved from `editor` to `own` on 2026-08-30. If you have configured
nothing, your agents now come up in the Gripterm panel rather than among your
editors, and `gripterm.launch.location` no longer reaches them — that setting
applies to the `editor` engine and to nothing else. Set
`gripterm.terminal.engine` to `editor` to have the old arrangement back; it is
kept whole, and it is what `own` falls back to when it cannot run.

| | `editor` | `own` |
|---|---|---|
| Who makes the terminal | the editor | Gripterm |
| Where the agent is | wherever `gripterm.launch.location` says: a group of the editor area, an editor tab, or the terminal panel | in the Gripterm panel: the terminal on the left, what is known about it on the right, and a strip of tabs when there are several |
| Platforms | wherever the editor runs | Windows and macOS. On Linux there is no prebuilt native addon to load, so the editor makes the terminal instead — said to you in a notification naming the setting, and to the log with the cause |
| `gripterm.launch.mode: shell` | yes | refused: the editor makes the terminal instead, said to you in a notification naming both settings, and to the log |
| What other extensions add to a terminal | reaches the agent: the channel from the Claude Code extension to the CLI, the git askpass of the editor | mostly does not: it arrives through a mechanism the editor applies to its own terminals, and no extension can read another one. The Claude Code channel is the exception — the CLI finds that extension by itself, with no port from us — but you raise it by hand, with `/ide` in the agent. Measured 2026-08-30 on Claude Code CLI 2.1.245, which is newer than the version pinned above, so it says nothing about that one: no agent raised it unasked, at either value of `gripterm.terminal.ideChannel`, which is the setting that governs the unasked attempt and nothing else (that measurement used a copy of the extension installed by a test run rather than an ordinary installation, so yours may behave differently). While the channel is up the agent is handed the file you have open and the text you have selected, and only one agent holds the channel however many are running. There was a third thing, and it is now in doubt: on 2026-08-20, in VS Code, the editor's own terminal took the focus away from the Gripterm panel on every prompt sent — on 2026-08-30 that could not be reproduced in Cursor, on connecting or on sending, and in VS Code only connecting was re-checked |
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
pnpm test:stand     # opens and closes a real editor four times over one folder, and judges the layout

pnpm gate           # types, lint, unit, the live suites, the stand. Not everything -- it says what it skips
pnpm gate:fast      # types, lint, unit only -- ~50 s, no editor. What the pre-push hook runs
```

`pnpm gate` runs types, lint, the unit suites with their coverage thresholds,
the live suites and the two-sitting stand, in that order, stopping at the first
failure. It is the one run here that may be called "checked", and it is **not**
everything: mutation testing, the live suites under Cursor, and
`test:acceptance` / `test:vsix` (which spend real turns on the owner's account)
are outside it. It prints that list by name on every run, whatever colour it
ends in, and leaves a receipt in `.gate/` naming the revision it checked.

Three points of the stand are admitted red today — two of them in every run
measured, and a third that comes and goes with the window — each by name, with a
ceiling and an expiry date, in [`gate/allowed-red.json`](gate/allowed-red.json).
Two more stood there until 2026-08-25 and were taken out the day the second half
of Ш8 fixed them, because a fixed defect does not keep its permission. **Those
admissions are the Ш6 orchestrator's own decision (2026-08-25); the owner has
not seen them and has ratified none of them**, which is what `ratifiedBy: null`
on every line means, and the full gate prints it whenever it gets as far as the
stand's budget, so a green cannot be read as agreement. The gate is red if a point outside that file goes red, if an
admitted point gets **worse** than its ceiling, or if an admitted point comes
back **green** — a permission that outlives its defect is a permission nobody
chose, unless that line says in writing that the point has been measured both
ways, with the runs behind it. Every line stops working on its date, only five
may live at once, an unratified line may have that date moved **once** before it
needs a name in `ratifiedBy`, and a ratification has to cite a day and a place
it was said.
`npx jest tests/stand/allowance.test.ts` asserts all of it against the real
file, and goes red on the morning a line comes due, with no editor involved.
None of it is a boundary — whoever edits the file edits the test — and the file
says so; it buys that a false sentence has to be written on purpose.

The `pre-push` hook is **per-machine and not tracked**, so a fresh clone has
none. To install it, and to take it off again:

```bash
printf '#!/bin/sh\nexec "$(git rev-parse --show-toplevel)/tools/pre-push.sh" "$@"\n' > .git/hooks/pre-push
chmod +x .git/hooks/pre-push
rm .git/hooks/pre-push        # to remove it
```

It runs `pnpm gate:fast` and refuses a push whose commits no full gate has ever
passed over. `git push --no-verify` skips it entirely, and nothing in this
repository can see that it did.

`pnpm test:stand` is the one run here that cannot be done inside a single
window: it asks whether the window a person comes back to is the window they
left, and the defect it exists for only shows from one sitting to the next. It
is in two halves — a measurer that starts the editor and writes down what it
saw, and a judge that is a pure function of that recording — so both "it goes
red on a broken layout" and "it goes green on a healthy one" are checked by
`npx jest tests/stand` with no editor at all.

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
