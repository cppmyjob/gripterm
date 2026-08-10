/**
 * The source of new identifiers. A port rather than a direct `randomUUID()`
 * call so that a test can hand out a known sequence and assert on it, without
 * the domain knowing that Node has a crypto module.
 */
export interface IdGenerator {
  newUuid: () => string;
}
