import type { Disposable } from '../domain/ports/disposable';
import type { Scheduler } from '../domain/ports/scheduler';

/**
 * The platform's own timer, behind the port.
 *
 * `unref` because nothing here is worth keeping a process alive for: a window
 * being torn down must not wait twenty seconds to say that a terminal was
 * quiet.
 */
export class SystemScheduler implements Scheduler {
  public after(ms: number, action: () => void): Disposable {
    const timer = setTimeout(action, ms);
    timer.unref();
    return {
      dispose: (): void => {
        clearTimeout(timer);
      },
    };
  }
}
