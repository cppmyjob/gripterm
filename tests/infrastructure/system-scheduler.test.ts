import { SystemScheduler } from '../../packages/core/src/infrastructure/system-scheduler';

describe('the platform timer behind the scheduler port', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('runs the action once the time has passed', () => {
    const done = jest.fn();

    new SystemScheduler().after(1000, done);
    jest.advanceTimersByTime(1000);

    expect(done).toHaveBeenCalledTimes(1);
  });

  it('does not run it early', () => {
    const done = jest.fn();

    new SystemScheduler().after(1000, done);
    jest.advanceTimersByTime(999);

    expect(done).not.toHaveBeenCalled();
  });

  it('cancels when disposed', () => {
    const done = jest.fn();

    const timer = new SystemScheduler().after(1000, done);
    timer.dispose();
    jest.advanceTimersByTime(5000);

    expect(done).not.toHaveBeenCalled();
  });

  it('is unbothered by being disposed after it has fired', () => {
    // The watch disposes every timer it holds when the window goes, without
    // asking which of them have already run.
    const done = jest.fn();

    const timer = new SystemScheduler().after(1000, done);
    jest.advanceTimersByTime(1000);
    timer.dispose();

    expect(done).toHaveBeenCalledTimes(1);
  });
});
