import { join } from 'node:path';
import { refuseToReplay } from '../../../packages/core/src/domain/agents/recorded/replaying';

/**
 * The one rule that keeps a recording out of somebody's morning.
 *
 * A window replaying a recording does not ask the machine anything. Every
 * answer it gets is a sentence from a file -- including "nothing is running",
 * which is the sentence that PERMITS a restore. Point such a window at the store
 * a person actually keeps their terminals in and it will start a second
 * `claude --resume` on every live conversation they have, and nothing takes that
 * back.
 *
 * So the rule is the narrowest one that still allows the measurement this whole
 * step exists for: a recording may stand in for an agent only over a store that
 * is NOT the default one. `chooseStorageDir` already draws exactly that line and
 * `readStorageDir` already refuses a test host that has not crossed it; this is
 * the same line, read again for a different act.
 */

const HOME = 'C:\\Users\\somebody';

describe('a window asked to replay a recording instead of asking an agent', () => {
  it('is refused over the store a person keeps their terminals in', () => {
    const refusal = refuseToReplay({ storeDir: join(HOME, '.gripterm'), home: HOME });

    expect(refusal).not.toBeNull();
    expect(refusal).toContain('.gripterm');
  });

  it('is refused however the path is spelled, because a case-different path is the same directory', () => {
    expect(refuseToReplay({ storeDir: join(HOME, '.gripterm').toUpperCase(), home: HOME })).not.toBeNull();
    expect(refuseToReplay({ storeDir: `${join(HOME, '.gripterm')}\\`, home: HOME })).not.toBeNull();
  });

  it('is allowed over a store belonging to a run, which is the only place this is for', () => {
    expect(
      refuseToReplay({ storeDir: 'D:\\Projects\\Gripterm\\source\\.vscode-test\\store-stand', home: HOME })
    ).toBeNull();
  });

  it('says what it refused and why, because a measurement that quietly did not happen is worse than none', () => {
    const refusal = refuseToReplay({ storeDir: join(HOME, '.gripterm'), home: HOME });

    expect(refusal).toContain('recording');
  });
});
