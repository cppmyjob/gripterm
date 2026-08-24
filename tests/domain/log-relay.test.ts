import { LogRelay, describeDetails } from '../../packages/core/src/index';
import { FixedClock, RecordingLogger } from '../helpers/port-fakes';
import type { LogLine, LogSink } from '../../packages/core/src/index';

/**
 * The thing that lets a log line reach a place nobody had opened yet.
 *
 * The order of activation is what makes this necessary rather than clever: the
 * logger exists on the first line of `activate`, and where the store IS -- the
 * only directory a person can be asked to send -- is not settled until a
 * hundred lines later, after the setting has been read, refused or fallen back
 * on. Every line said in between is a line about how the store was chosen, and
 * those are exactly the lines that explain a window that came up looking at
 * nothing.
 *
 * So the lines are held and replayed. Replayed WITH THE MOMENT THEY HAPPENED,
 * because a support log where the first thirty lines all carry the timestamp of
 * the thirty-first is a log that cannot be read against a person's account of
 * what they saw.
 */

const AT = new Date('2026-08-24T09:15:00.000Z');

class RecordingSink implements LogSink {
  public readonly lines: LogLine[] = [];

  public write(line: LogLine): void {
    this.lines.push(line);
  }
}

/** A sink that fails the way a full disk or a revoked permission fails. */
class BrokenSink implements LogSink {
  public calls = 0;

  public write(): void {
    this.calls += 1;
    throw new Error('EACCES: the log file could not be written');
  }
}

describe('the relay that carries a log line to the store as well as the channel', () => {
  it('says everything to the channel, whether or not a store was ever found', () => {
    const channel = new RecordingLogger();
    const relay = new LogRelay({ first: channel, clock: new FixedClock(AT) });

    relay.info('the window woke up');
    relay.warn('the setting named a store that is not there', { path: 'C:/nowhere' });
    relay.error('the base could not be opened', { reason: 'EPERM' });

    expect(channel.infos).toEqual([{ message: 'the window woke up', details: undefined }]);
    expect(channel.warnings).toEqual([
      { message: 'the setting named a store that is not there', details: { path: 'C:/nowhere' } },
    ]);
    expect(channel.errors).toEqual([
      { message: 'the base could not be opened', details: { reason: 'EPERM' } },
    ]);
  });

  it('replays what was said before the store was known, with the moment each line happened', () => {
    const clock = new FixedClock(AT);
    const relay = new LogRelay({ first: new RecordingLogger(), clock });

    relay.info('the storage path was read from the settings', { configured: true });
    clock.advance(2000);
    relay.warn('the store was refused', { reason: 'not absolute' });
    clock.advance(3000);

    const sink = new RecordingSink();
    relay.alsoTo(sink);

    expect(sink.lines.map((line) => line.message)).toEqual([
      'the storage path was read from the settings',
      'the store was refused',
    ]);
    expect(sink.lines.map((line) => line.at.toISOString())).toEqual([
      '2026-08-24T09:15:00.000Z',
      '2026-08-24T09:15:02.000Z',
    ]);
    expect(sink.lines[0]?.level).toBe('info');
    expect(sink.lines[1]?.level).toBe('warn');
    expect(sink.lines[1]?.details).toEqual({ reason: 'not absolute' });
  });

  it('writes to the sink as it happens once the store is known', () => {
    const clock = new FixedClock(AT);
    const sink = new RecordingSink();
    const relay = new LogRelay({ first: new RecordingLogger(), clock });
    relay.alsoTo(sink);

    relay.error('a conversation did not come back', { reason: 'owner-live' });

    expect(sink.lines).toHaveLength(1);
    expect(sink.lines[0]?.message).toBe('a conversation did not come back');
    expect(sink.lines[0]?.at.toISOString()).toBe('2026-08-24T09:15:00.000Z');
  });

  /*
   * The held lines are bounded, because the store may never be found at all --
   * a window whose setting was refused runs for a whole day with nowhere to put
   * them, and an unbounded buffer would be this build growing in a person's
   * memory for the sake of a file it is never going to write.
   *
   * The EARLIEST lines are the ones kept, and that is the decision: what a held
   * line is for is the story of activation, and the story of activation is at
   * the front.
   */
  it('holds a bounded number of lines and says how many it had to drop', () => {
    const relay = new LogRelay({ first: new RecordingLogger(), clock: new FixedClock(AT), held: 3 });

    for (let said = 1; said <= 7; said += 1) {
      relay.info(`line ${String(said)}`);
    }
    const sink = new RecordingSink();
    relay.alsoTo(sink);

    expect(sink.lines.slice(0, 3).map((line) => line.message)).toEqual([
      'line 1',
      'line 2',
      'line 3',
    ]);
    const last = sink.lines[sink.lines.length - 1];
    expect(sink.lines).toHaveLength(4);
    expect(last?.level).toBe('warn');
    expect(last?.details).toEqual({ dropped: 4, held: 3 });
  });

  /*
   * A sink that throws is the one failure this class must not pass on. It runs
   * inside every other failure's reporting path, so a throw here would replace
   * the sentence explaining a defect with a second defect -- and it would do it
   * on the line that was about to say what went wrong.
   */
  it('lets go of a sink that throws, and says so once rather than on every line', () => {
    const channel = new RecordingLogger();
    const sink = new BrokenSink();
    const relay = new LogRelay({ first: channel, clock: new FixedClock(AT) });
    relay.alsoTo(sink);

    expect(() => {
      relay.info('the first line after the store was found');
      relay.info('the second');
      relay.info('the third');
    }).not.toThrow();

    expect(sink.calls).toBe(1);
    expect(channel.errors).toHaveLength(1);
    expect(channel.errors[0]?.message).toContain('log');
    expect(describeDetails(channel.errors[0]?.details)).toContain('EACCES');
  });
});
