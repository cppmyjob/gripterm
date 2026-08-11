import { ListeningAddress, launchReadiness } from '../../packages/core/src/index';

const ADDRESS = ListeningAddress.loopback(51_337);
const READY = { cliName: 'claude', cliPath: 'C:/bin/claude.exe', address: ADDRESS };

describe('whether this window can start a terminal at all', () => {
  it('hands back both halves when everything is there', () => {
    // As a pair, so that the composition root cannot assemble a factory out of
    // one of them: `--settings` names a port, and a command with no port is a
    // terminal that runs unseen.
    expect(launchReadiness(READY)).toEqual({
      kind: 'ready',
      cliPath: 'C:/bin/claude.exe',
      address: ADDRESS,
    });
  });

  it('refuses when the agent CLI was not found, and names it', () => {
    const readiness = launchReadiness({ ...READY, cliPath: null });

    expect(readiness.kind).toBe('refused');
    expect(readiness.kind === 'refused' && readiness.reason).toContain('claude');
    expect(readiness.kind === 'refused' && readiness.reason).toContain('PATH');
  });

  it('refuses when nothing is listening for hook events', () => {
    const readiness = launchReadiness({ ...READY, address: null });

    expect(readiness.kind === 'refused' && readiness.reason).toContain('unseen');
  });

  it('names the missing CLI first, because that is the one a person can fix', () => {
    const readiness = launchReadiness({ ...READY, cliPath: null, address: null });

    expect(readiness.kind === 'refused' && readiness.reason).toContain('claude');
  });
});
