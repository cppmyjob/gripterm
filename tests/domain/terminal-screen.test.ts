import type { ScreenExit } from '../../packages/core/src/index';
import { InMemoryTerminalScreen } from '../helpers/port-fakes';

/**
 * The promises of `TerminalScreen`, asked of the only implementation there is.
 *
 * **Said plainly, because a suite that only ever runs a fake is the vacuum test
 * this project has been caught building twice (M1.5, M2.11):** nothing below
 * proves anything about node-pty. What it does is fix what the port MEANS, so
 * that the pty-backed screen of M3.4 has a list to be held to and the webview
 * tests of M3.7 are written against a fake that behaves like the real thing
 * rather than like whatever was convenient. M3.4 runs this same list against
 * the real screen; that is where it becomes evidence, and that is where it is
 * lifted out into a harness two suites share.
 *
 * Four of the five promises are ordinary. The fifth is not, and it is here
 * because of a measurement: after the process ends, `write` and `resize` are
 * ignored rather than thrown out of. Measured 2026-08-17 (M3.2 stage B, §8) --
 * four of five resizes under a live stream threw `Cannot resize a pty that has
 * already exited`, because the pty exited while the resize was in flight. A
 * caller cannot check first: there is no instant between the check and the call
 * in which the answer is guaranteed to hold.
 */

const EXIT: ScreenExit = { code: 0, signal: undefined };

describe('TerminalScreen delivers what the process produced', () => {
  it('gives every listener each chunk, in arrival order', () => {
    const screen = new InMemoryTerminalScreen();
    const first: string[] = [];
    const second: string[] = [];
    screen.onData((chunk) => first.push(chunk));
    screen.onData((chunk) => second.push(chunk));

    screen.emit('one');
    screen.emit('two');

    expect(first).toStrictEqual(['one', 'two']);
    expect(second).toStrictEqual(['one', 'two']);
  });

  it('stops delivering to a subscription that was disposed, and only to it', () => {
    const screen = new InMemoryTerminalScreen();
    const leaving: string[] = [];
    const staying: string[] = [];
    const subscription = screen.onData((chunk) => leaving.push(chunk));
    screen.onData((chunk) => staying.push(chunk));

    screen.emit('before');
    subscription.dispose();
    screen.emit('after');

    expect(leaving).toStrictEqual(['before']);
    expect(staying).toStrictEqual(['before', 'after']);
  });

  it('carries writes and sizes towards the process', () => {
    const screen = new InMemoryTerminalScreen();

    screen.write('ls\r');
    screen.resize(120, 30);

    expect(screen.written).toStrictEqual(['ls\r']);
    expect(screen.sizes).toStrictEqual([{ cols: 120, rows: 30 }]);
  });

  it('holds the process back and lets it go, in the order it was told to', () => {
    // The order is the promise, not the state: a pause with no resume after it
    // is the one failure of this port that leaves an agent blocked forever with
    // nothing on any screen to say so (§I.3).
    const screen = new InMemoryTerminalScreen();

    screen.pause();
    screen.resume();

    expect(screen.flow).toStrictEqual(['pause', 'resume']);
    expect(screen.paused).toBe(false);
  });
});

describe('TerminalScreen reports the end of the process once', () => {
  it('reports the exit to every listener', () => {
    const screen = new InMemoryTerminalScreen();
    const seen: ScreenExit[] = [];
    screen.onExit((exit) => seen.push(exit));

    screen.end(EXIT);

    expect(seen).toStrictEqual([EXIT]);
  });

  it('reports it once however often the process is said to have ended', () => {
    // A pty's exit reaches us from more than one place -- the event, and the
    // kill that provoked it -- and a record written twice is two death events
    // for one death.
    const screen = new InMemoryTerminalScreen();
    const seen: ScreenExit[] = [];
    screen.onExit((exit) => seen.push(exit));

    screen.end(EXIT);
    screen.end({ code: 1, signal: undefined });

    expect(seen).toStrictEqual([EXIT]);
  });

  it('delivers nothing after the process has ended', () => {
    const screen = new InMemoryTerminalScreen();
    const seen: string[] = [];
    screen.onData((chunk) => seen.push(chunk));

    screen.end(EXIT);
    screen.emit('too late');

    expect(seen).toStrictEqual([]);
  });
});

describe('TerminalScreen survives being used after it is over', () => {
  it('ignores a write to a process that has ended', () => {
    const screen = new InMemoryTerminalScreen();
    screen.end(EXIT);

    expect(() => { screen.write('ls\r'); }).not.toThrow();
    expect(screen.written).toStrictEqual([]);
  });

  it('ignores a resize of a process that has ended', () => {
    // The measured one: node-pty throws here, and the pty decides when it ends.
    const screen = new InMemoryTerminalScreen();
    screen.end(EXIT);

    expect(() => { screen.resize(80, 24); }).not.toThrow();
    expect(screen.sizes).toStrictEqual([]);
  });

  it('ignores flow control on a process that has ended', () => {
    // The same race as `resize`, on the call where it matters most: a pause
    // aimed at a pty that has just gone must not throw out of the listener that
    // was reporting the flood.
    const screen = new InMemoryTerminalScreen();
    screen.end(EXIT);

    expect(() => { screen.pause(); }).not.toThrow();
    expect(() => { screen.resume(); }).not.toThrow();
    expect(screen.flow).toStrictEqual([]);
  });

  it('can be disposed twice', () => {
    const screen = new InMemoryTerminalScreen();

    screen.dispose();

    expect(() => { screen.dispose(); }).not.toThrow();
    expect(screen.disposed).toBe(true);
  });

  it('delivers nothing once disposed', () => {
    const screen = new InMemoryTerminalScreen();
    const data: string[] = [];
    const exits: ScreenExit[] = [];
    screen.onData((chunk) => data.push(chunk));
    screen.onExit((exit) => exits.push(exit));

    screen.dispose();
    screen.emit('output');
    screen.end(EXIT);

    expect(data).toStrictEqual([]);
    expect(exits).toStrictEqual([]);
  });
});
