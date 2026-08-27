/**
 * What to say about the build of the agent this window will actually run.
 *
 * The neutral half of what `describeCliVersion` has always returned: a version
 * when one could be established, how loudly to say it, and the sentence a person
 * reads. The sentence names the agent, and that is the point of it being made
 * HERE, by the implementation: the domain no longer has to know whose product it
 * is talking about in order to pass the words on.
 */
export interface AgentBuildReport {
  /** The build, when one was established. `null` covers both "would not say" and "could not be read". */
  readonly version: string | null;
  /** `info` when this is the build the product was measured against, `warn` otherwise. */
  readonly level: 'info' | 'warn';
  /** For a person, in the implementation's own words. Never a mismatch we did not establish. */
  readonly message: string;
}

/**
 * Which build is this, established by asking rather than by reading a file.
 *
 * A warning and never a refusal: every fact this product rests on was measured
 * against a pinned build, so a different one is a reason to distrust our facts
 * -- not a reason to stop a person using their own installation.
 */
export interface AgentBuild {
  /** What the build is and what to say about it. Never throws. */
  describe: () => Promise<AgentBuildReport>;
}
