import { SessionId, SystemIdGenerator, TerminalId } from '../../packages/core/src/index';

describe('SystemIdGenerator', () => {
  it('mints ids the domain accepts', () => {
    // The generator's output is validated like any other input (`TerminalId
    // .create`), so an id this class produced and the domain refused would be a
    // failure with no other symptom.
    const generator = new SystemIdGenerator();

    expect(() => TerminalId.fromString(generator.newUuid())).not.toThrow();
    expect(() => SessionId.fromString(generator.newUuid())).not.toThrow();
  });

  it('does not repeat itself', () => {
    // A collision is a conversation adopted by the wrong record. A hundred draws
    // prove nothing about the generator's quality -- that is `node:crypto`'s to
    // promise -- but they do catch a constant returned by mistake.
    const generator = new SystemIdGenerator();
    const drawn = new Set(Array.from({ length: 100 }, () => generator.newUuid()));

    expect(drawn.size).toBe(100);
  });
});
