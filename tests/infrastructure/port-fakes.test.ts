import { SessionId, TerminalId } from '../../packages/core/src/index.js';
import { CREATED_AT, makeTerminalSpec } from '../helpers/domain-fixtures.js';
import {
  FixedClock,
  InMemoryTerminalGateway,
  SequentialIdGenerator,
} from '../helpers/port-fakes.js';

/**
 * The fakes are tested too. A broken double does not fail loudly -- it agrees
 * with whatever the code under test does, and every suite built on it turns
 * green for the wrong reason.
 */

describe('FixedClock', () => {
  it('stands still until a test moves it', () => {
    const clock = new FixedClock(CREATED_AT);

    expect(clock.now()).toStrictEqual(CREATED_AT);
    clock.advance(60_000);
    expect(clock.now().getTime()).toBe(CREATED_AT.getTime() + 60_000);
  });

  it('hands out a fresh Date, so a caller mutating it cannot reach another reader', () => {
    // Asserted between two live references on purpose. The obvious spelling --
    // mutate `clock.now()` and then read `clock.now()` again -- passes even on
    // an implementation that returns one shared `Date` and re-stamps it on
    // every read, because the re-stamp undoes the mutation before the
    // assertion sees it. Found by mutation, 2026-08-10.
    const clock = new FixedClock(CREATED_AT);
    const first = clock.now();
    const second = clock.now();

    first.setTime(0);

    expect(first).not.toBe(second);
    expect(second).toStrictEqual(CREATED_AT);
  });
});

describe('SequentialIdGenerator', () => {
  it('produces distinct ids the domain accepts', () => {
    const generator = new SequentialIdGenerator();
    const ids = Array.from({ length: 300 }, () => generator.newUuid());

    expect(new Set(ids).size).toBe(ids.length);
    expect(() => ids.map((id) => TerminalId.fromString(id))).not.toThrow();
    expect(SessionId.create(generator).value).toBe('00000000-0000-4000-8000-00000000012d');
  });
});

describe('InMemoryTerminalGateway', () => {
  it('records the spec it was asked for and hands back a handle for it', async () => {
    const gateway = new InMemoryTerminalGateway();
    const spec = makeTerminalSpec();

    const handle = await gateway.create(spec);

    expect(gateway.specs).toStrictEqual([spec]);
    expect(handle.terminalId).toBe(spec.terminalId);
    expect(gateway.listKnown()).toStrictEqual([handle]);
    expect(gateway.handleFor(spec.terminalId)).toBe(handle);
  });

  it('refuses to invent a handle it never created', () => {
    expect(() => new InMemoryTerminalGateway().handleFor(makeTerminalSpec().terminalId)).toThrow(
      /never created/
    );
  });

  it('forgets a terminal the way the editor does', async () => {
    const gateway = new InMemoryTerminalGateway();
    const spec = makeTerminalSpec();
    await gateway.create(spec);

    gateway.forget(spec.terminalId);

    expect(gateway.listKnown()).toStrictEqual([]);
  });
});

describe('FakeTerminalHandle', () => {
  it('records what was sent and shown, in order', async () => {
    const gateway = new InMemoryTerminalGateway();
    const spec = makeTerminalSpec();
    await gateway.create(spec);
    const handle = gateway.handleFor(spec.terminalId);

    handle.sendText('first', false);
    handle.sendText('second', true);
    handle.show(true);
    handle.show(false);

    expect(handle.sent).toStrictEqual([
      { text: 'first', execute: false },
      { text: 'second', execute: true },
    ]);
    expect(handle.shownWith).toStrictEqual([true, false]);
  });

  it('reports a close with its exit code, and stops after unsubscribing', async () => {
    const gateway = new InMemoryTerminalGateway();
    const spec = makeTerminalSpec();
    await gateway.create(spec);
    const handle = gateway.handleFor(spec.terminalId);
    const seen: (number | undefined)[] = [];
    const subscription = handle.onDidClose((exit) => {
      seen.push(exit.code);
    });

    handle.close(1);
    handle.close(undefined);
    subscription.dispose();
    handle.close(127);

    expect(seen).toStrictEqual([1, undefined]);
  });

  it('does not pretend to know whether disposing raises a close', async () => {
    // Unmeasured on the platform. A fake that guessed would make every test
    // built on it agree with the guess, so the test that cares says which
    // happened.
    const gateway = new InMemoryTerminalGateway();
    const spec = makeTerminalSpec();
    await gateway.create(spec);
    const handle = gateway.handleFor(spec.terminalId);
    let closes = 0;
    handle.onDidClose(() => {
      closes += 1;
    });

    handle.dispose();

    expect(handle.disposed).toBe(true);
    expect(closes).toBe(0);
  });
});
