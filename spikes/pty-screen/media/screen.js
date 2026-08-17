/**
 * The consumer half of M3.2 stage B: xterm inside a webview view.
 *
 * It answers three of the ten by being instrumented rather than watched:
 *   (3) how much xterm can actually swallow. `term.write(data, cb)` calls back
 *       when the data has been parsed, and that callback is the only honest
 *       acknowledgement there is -- the number M3.7's back-pressure threshold
 *       has to be picked from is the backlog between what we posted and what
 *       came back, not the size of a chunk.
 *   (4) whether the unicode11 addon changes anything. Two off-screen twins get
 *       the same fixture, one on Unicode 6 and one on Unicode 11, and report
 *       where the cursor ended up. If the two agree, M3.6's insistence on the
 *       addon is superstition; if they disagree, it is a requirement.
 *   (5) what a resize under a live stream does to the screen. The producer
 *       prints numbered lines; the buffer is scanned afterwards for gaps and
 *       duplicates, because "it looked fine" is not an answer.
 */

/* global Terminal, FitAddon, Unicode11Addon, acquireVsCodeApi */

(function () {
  'use strict';

  const vscode = acquireVsCodeApi();
  const status = document.getElementById('status');
  const screen = document.getElementById('screen');

  let term = null;
  let fit = null;
  /** Characters written but not yet acknowledged by xterm's own callback. */
  let backlog = 0;
  let maxBacklog = 0;
  let ackedChars = 0;
  let ackedChunks = 0;
  /** Which run the acknowledgements belong to; a late ack must not be counted twice. */
  let runId = null;
  /**
   * Line numbers seen in the RAW chunks, before xterm ever sees them.
   * Without this a missing line has two possible owners -- a dropped
   * postMessage or xterm's reflow -- and blaming the wrong one would send M3.7
   * to fix the wrong thing.
   */
  let receivedNumbers = new Set();
  let receivedCarry = '';

  function say(text) {
    status.textContent = text;
  }

  function post(message) {
    vscode.postMessage(message);
  }

  function makeTerminal(container, unicode11, options) {
    const settings = Object.assign(
      {
        allowProposedApi: true,
        convertEol: false,
        scrollback: 30000,
        fontFamily: 'Consolas, "Courier New", monospace',
        fontSize: 13,
        theme: { background: '#1e1e1e', foreground: '#cccccc' },
      },
      options || {},
    );
    const made = new Terminal(settings);
    if (unicode11) {
      made.loadAddon(new Unicode11Addon.Unicode11Addon());
      made.unicode.activeVersion = '11';
    }
    made.open(container);
    return made;
  }

  function bufferLines(target, includeScrollback) {
    const buffer = target.buffer.active;
    const from = includeScrollback ? 0 : buffer.baseY;
    const lines = [];
    for (let y = from; y < buffer.length; y += 1) {
      const line = buffer.getLine(y);
      lines.push(line === undefined ? '' : line.translateToString(true));
    }
    return lines;
  }

  /** Sequence check for question (5): every printed line number, exactly once. */
  function scanSequence(target) {
    const seen = new Map();
    let total = 0;
    for (const line of bufferLines(target, true)) {
      const matches = line.match(/L(\d{6})/g);
      if (matches === null) {
        continue;
      }
      for (const token of matches) {
        const value = Number(token.slice(1));
        seen.set(value, (seen.get(value) || 0) + 1);
        total += 1;
      }
    }
    const numbers = Array.from(seen.keys()).sort((a, b) => a - b);
    let duplicated = 0;
    for (const count of seen.values()) {
      if (count > 1) {
        duplicated += 1;
      }
    }
    // Which numbers vanished, not just how many gaps there were: "ten lines are
    // missing" is a rumour until it says which ten and where.
    let gaps = 0;
    const missing = [];
    for (let i = 1; i < numbers.length; i += 1) {
      if (numbers[i] !== numbers[i - 1] + 1) {
        gaps += 1;
        if (missing.length < 20) {
          missing.push({ after: numbers[i - 1], before: numbers[i], count: numbers[i] - numbers[i - 1] - 1 });
        }
      }
    }
    return {
      tokensFound: total,
      distinct: numbers.length,
      lowest: numbers.length === 0 ? null : numbers[0],
      highest: numbers.length === 0 ? null : numbers[numbers.length - 1],
      duplicated,
      gaps,
      missing,
      cols: target.cols,
      rows: target.rows,
    };
  }

  /** One glyph, one line, and the cursor column afterwards -- that is its width. */
  const GLYPHS = ['\u23fa', '\u2705', '\u{1F642}', '\u4e2d', '\uff66', '\u00e9', 'e\u0301', '\u2500', '\u2839'];

  function measureWidths(target, done) {
    const widths = {};
    let index = 0;
    const step = () => {
      if (index >= GLYPHS.length) {
        done(widths);
        return;
      }
      const glyph = GLYPHS[index];
      index += 1;
      target.write(`\r\n${glyph}`, () => {
        widths[glyph] = target.buffer.active.cursorX;
        step();
      });
    };
    step();
  }

  /**
   * `term.write` is asynchronous, and its callback is the only moment the buffer
   * is finished. Measured 2026-08-17: reading the buffer on the next line
   * returned two empty twins and an "identical: true" that meant nothing.
   */
  function twinReport(fixture, done) {
    const out = {};
    const shapes = {};
    const plan = [['unicode6', false, 'twin6'], ['unicode11', true, 'twin11']];
    let index = 0;
    const step = () => {
      if (index >= plan.length) {
        // Compared on shape alone: the version label differs by construction and
        // comparing it would answer a question nobody asked.
        out.identical = shapes.unicode6 === shapes.unicode11;
        done(out);
        return;
      }
      const [name, unicode11, hostId] = plan[index];
      index += 1;
      const host = document.getElementById(hostId);
      host.textContent = '';
      const twin = makeTerminal(host, unicode11, { cols: 80, rows: 12, scrollback: 0 });
      twin.write(fixture, () => {
        const shape = {
          cursorX: twin.buffer.active.cursorX,
          cursorY: twin.buffer.active.cursorY,
          lines: bufferLines(twin, false).filter((line) => line.length > 0),
        };
        // The width a terminal gives a glyph is invisible in the text it stores,
        // so it is asked directly: put one glyph on an empty line and read where
        // the cursor stopped. That number IS the width.
        measureWidths(twin, (widths) => {
          out[name] = Object.assign({ activeUnicodeVersion: twin.unicode.activeVersion, widths }, shape);
          shapes[name] = JSON.stringify(Object.assign({ widths }, shape));
          twin.dispose();
          step();
        });
      });
    };
    step();
  }

  window.addEventListener('message', (event) => {
    const message = event.data;
    if (message === null || typeof message !== 'object') {
      return;
    }

    if (message.t === 'reset') {
      if (term !== null) {
        term.dispose();
      }
      screen.textContent = '';
      // An explicit size when one is asked for. Measured 2026-08-17: the same
      // channel run drained in 0.8 s at 306 columns and did not drain at all in
      // 94 s at 40, because a 90-character line reflows into three rows. A
      // number that swings by two orders of magnitude with the panel height is
      // not a measurement of the channel.
      const size = typeof message.cols === 'number' ? { cols: message.cols, rows: message.rows } : {};
      term = makeTerminal(screen, true, size);
      fit = new FitAddon.FitAddon();
      term.loadAddon(fit);
      if (typeof message.cols !== 'number') {
        try {
          fit.fit();
        } catch (error) {
          say(`fit threw: ${String(error)}`);
        }
      }
      runId = message.runId === undefined ? null : message.runId;
      receivedNumbers = new Set();
      receivedCarry = '';
      term.onData((data) => { post({ t: 'input', data }); });
      backlog = 0;
      maxBacklog = 0;
      ackedChars = 0;
      ackedChunks = 0;
      post({ t: 'reset-done', cols: term.cols, rows: term.rows });
      say(`ready — ${term.cols}x${term.rows}`);
      return;
    }

    if (term === null) {
      return;
    }

    if (message.t === 'data') {
      // Scanned with a carry, because a chunk boundary can cut a token in half.
      // Measured 2026-08-17 without it: 19980 of 20000, which looked like a lost
      // message and was nothing but this scanner losing sight of its own token.
      const text = receivedCarry + message.chunk;
      const found = text.match(/L(\d{6})/g);
      if (found !== null) {
        for (const token of found) {
          receivedNumbers.add(Number(token.slice(1)));
        }
      }
      receivedCarry = text.slice(-8);
      backlog += message.chunk.length;
      if (backlog > maxBacklog) {
        maxBacklog = backlog;
      }
      const at = performance.now();
      const forRun = runId;
      term.write(message.chunk, () => {
        backlog -= message.chunk.length;
        ackedChars += message.chunk.length;
        ackedChunks += 1;
        post({ t: 'ack', runId: forRun, seq: message.seq, chars: message.chunk.length, ms: performance.now() - at, backlog });
      });
      return;
    }

    if (message.t === 'resize') {
      term.resize(message.cols, message.rows);
      post({ t: 'resized', cols: term.cols, rows: term.rows });
      return;
    }

    if (message.t === 'fit') {
      let error = null;
      try {
        fit.fit();
      } catch (thrown) {
        error = String(thrown);
      }
      post({ t: 'fitted', cols: term.cols, rows: term.rows, error });
      say(`fitted — ${term.cols}x${term.rows}`);
      return;
    }

    if (message.t === 'scan') {
      post({
        t: 'scanned',
        report: scanSequence(term),
        maxBacklog,
        ackedChars,
        ackedChunks,
        receivedDistinct: receivedNumbers.size,
      });
      return;
    }

    if (message.t === 'twins') {
      twinReport(message.fixture, (report) => { post({ t: 'twinned', report }); });
      return;
    }

    if (message.t === 'say') {
      say(message.text);
    }
  });

  window.addEventListener('resize', () => {
    if (term !== null && fit !== null) {
      try {
        fit.fit();
        post({ t: 'fitted', cols: term.cols, rows: term.rows, error: null });
      } catch (error) {
        post({ t: 'fitted', cols: null, rows: null, error: String(error) });
      }
    }
  });

  post({ t: 'ready' });
  say('spike: page up, waiting for a terminal');
})();
