# Spike: panel keys (M3.1)

Throwaway measurement stand for step **M3.1** of `14-m3-plan.md` — the keyboard
gate. That plan is named and deliberately not linked: it lives in a private
repository, so a link would be dead for every reader of this public one and
would publish that repository's layout besides. Nothing here moves into
`packages/`; the product of this directory is a protocol in `docs/experiments/`.

## What it answers

- **Question zero (A40).** Does a webview view render in the bottom panel of this
  editor at all? Machine-readable: the protocol holds `view.resolveCount` (we were
  asked for html) and `view.readyAt` (the page itself spoke). Resolve without ready
  is exactly the Cursor symptom — the tab switches and the body stays empty.
- **A31.** For each key: does it reach the page by itself, does it arrive only as
  our contributed keybinding, or does the editor take it?
- Side questions, not gates: how many cells fit at the usual panel height, and
  whether `retainContextWhenHidden` keeps the state across `Ctrl+J`.

## Run

```powershell
pnpm --filter spike-panel-keys run build
code  --extensionDevelopmentPath=D:\Projects\Gripterm\source\spikes\panel-keys --new-window <some folder>
cursor --extensionDevelopmentPath=D:\Projects\Gripterm\source\spikes\panel-keys --new-window <some folder>
```

The tab opens itself and takes focus. Then, in the board:

1. Press the keys of the table one by one. Green — the key reached the page.
   Yellow — only our keybinding fired. Nothing happened? Press the row's
   **did not arrive** button and write what the editor did instead.
2. **`Ctrl+W` may close the window** in VS Code. That is a legitimate result, and
   the protocol is written after every change, so the run is not lost.
3. `Ctrl+K` in VS Code is a chord prefix — expect it to wait for a second key.
4. For the O6 question: put focus in the right-hand field and press `Escape` or
   an arrow. If a row still turns yellow, `focusedView` guards too much — which is
   why M3.8 contributes its own context key instead.
5. Toggle the panel with `Ctrl+J` a few times and return: `view.resolveCount` and
   the raw log tell you whether the page survived.

## Where the results land

`spikes/panel-keys/results/<editor>-<version>-<stamp>.json`, ignored by git.
Written on activation and after every change. `Spike: save protocol` from the
command palette forces a write and shows the path.

## Two things this stand deliberately does not do

- It draws no terminal. Columns are estimated from a canvas measurement of the
  configured terminal font, not from xterm — that is M3.2's job.
- It never loads `node-pty`. Also M3.2.
