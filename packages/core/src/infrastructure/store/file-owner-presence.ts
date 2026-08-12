import { mkdir, readdir, rm } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { uptime } from 'node:os';
import { ConflictError, ValidationError } from '../../domain/errors/gripterm-error';
import { OwnerId } from '../../domain/entities/owner-id';
import { STORAGE_DIRECTORY_MODE } from './storage-layout';
import { isEditorKind, isOwnerKind } from '../../domain/entities/owner-ref';
import { asFiniteNumber, asRecord, asString, asStringArray } from '../../domain/json/json-readers';
import { readJsonFile, writeJsonFile } from './json-file';
// The pair of numbers lives with the port, not here: it is what every window on
// the machine reasons about the others with, and one implementation is no place
// for a rule the whole store obeys.
import { FRESH_HEARTBEAT_MS } from '../../domain/ports/owner-presence';
import type { Clock } from '../../domain/ports/clock';
import type { EditorKind, OwnerKind } from '../../domain/entities/owner-ref';
import type { Logger } from '../../domain/ports/logger';
import type {
  OwnerIdentity,
  OwnerLiveness,
  OwnerPresence,
} from '../../domain/ports/owner-presence';
import type { StorageLayout } from './storage-layout';

const MS_PER_SECOND = 1000;
const OWNER_FILE_SUFFIX = '.json';

/** The one `process.kill` outcome that means the process is not there (§4.8). */
const NO_SUCH_PROCESS = 'ESRCH';

/** `owners/<ownerId>.json`. Timestamps are epoch milliseconds, as everywhere else in this store. */
export interface PresenceDocument {
  readonly ownerId: string;
  readonly kind: string;
  readonly pid: number;
  readonly editorKind: string;
  readonly editorVersion: string;
  readonly workspaceFolders: readonly string[];
  readonly startedAt: number;
  readonly heartbeatAt: number;
}

/**
 * What that file says, once it is trusted: who the window is, when it started
 * and when it last said anything.
 *
 * `startedAt` is written and validated although no rule reads it. It is the one
 * field that lets a person looking at `owners/` tell a window that has been up
 * for a week from one that restarted a minute ago -- and this store's whole
 * argument for being files is that a person can open them.
 */
export interface PresenceRecord {
  readonly identity: OwnerIdentity;
  readonly startedAt: Date;
  readonly heartbeatAt: Date;
}

export type PresenceDecode =
  | { readonly kind: 'ok', readonly record: PresenceRecord }
  | { readonly kind: 'broken', readonly reason: string };

/**
 * A presence file as a reader meets it. Every answer that is not a record
 * carries the sentence explaining itself, so that logging one needs no branch --
 * and a branch on a case no test can reach is a rule nobody can check.
 */
type PresenceRead =
  | { readonly kind: 'ok', readonly record: PresenceRecord }
  | { readonly kind: 'absent', readonly reason: string }
  | { readonly kind: 'broken', readonly reason: string };

/**
 * Sends signal 0 to a process, or throws the way `process.kill` does.
 *
 * A seam, and a narrow one on purpose. The outcome this whole file turns on --
 * `EPERM`, which means the process IS there and belongs to another user or
 * another privilege level -- cannot be produced by a test that does not run a
 * second user's process, and a rule no test can reach is a rule nobody can say
 * still holds.
 */
export type SignalProbe = (pid: number) => void;

export interface FileOwnerPresenceOptions {
  readonly layout: StorageLayout;
  readonly clock: Clock;
  readonly logger: Logger;
  /**
   * Seconds since the machine booted, defaulting to `os.uptime()`. Injected for
   * the same reason as the clock: the boot rule below is arithmetic, and a test
   * has to be able to state both of its terms.
   */
  readonly uptimeSeconds?: () => number;
  readonly probe?: SignalProbe;
}

/**
 * Who is out there, as a directory of files every window on this machine reads.
 *
 * This is the object that decides whether another window's terminals may be
 * adopted, so the expensive mistake it can make is one-sided: calling a LIVE
 * window dead authorises a second `claude --resume` on a conversation that
 * already has one (O3), while calling a dead window `unknown` costs a person one
 * confirmation click. Every judgement below is written to fail in the second
 * direction.
 *
 * The order of the rules in `_verdict` is the design, not an accident:
 *
 *   1. a heartbeat written BEFORE the machine booted cannot have been written by
 *      any process alive now -- one comparison that deterministically removes the
 *      whole cross-boot class of pid reuse, which on Windows is most of it;
 *   2. no process at that pid -- `dead`;
 *   3. a fresh heartbeat -- `live`;
 *   4. anything else -- `unknown`, which is a window that is there and not
 *      talking: asleep, hung, or on a machine that stalled. Not dead.
 */
export class FileOwnerPresence implements OwnerPresence {
  private _announced: PresenceRecord | null = null;
  private _retired = false;

  constructor(private readonly _options: FileOwnerPresenceOptions) {}

  /**
   * Writes this window into `owners/`, and only then remembers it did.
   *
   * The order matters: an id that cannot be a file name is refused by the layout
   * (M2.1) and this throws with `_announced` still `null`, so a later heartbeat
   * fails loudly as "never announced" instead of quietly beating into nowhere.
   */
  public async announce(identity: OwnerIdentity): Promise<void> {
    const now = this._options.clock.now();
    const record: PresenceRecord = { identity, startedAt: now, heartbeatAt: now };
    await this._write(record);
    this._announced = record;
    this._retired = false;
  }

  /**
   * Says this window is still here.
   *
   * It rewrites the whole file rather than touching one field, because the file
   * has exactly one writer (§4.8) and a partial update would be a second way for
   * its contents to exist -- one more shape for a reader to be right or wrong
   * about, bought for nothing.
   *
   * A beat AFTER `retire()` is refused rather than absorbed: it would recreate
   * the file this window has just said it was done with, and a window that
   * announces its departure and goes on writing is exactly the thing liveness is
   * supposed to be able to trust. The composition root therefore stops the timer
   * before it retires, and gets a loud error if it ever stops doing so.
   */
  public async heartbeat(): Promise<void> {
    const announced = this._requireLiving();
    const record: PresenceRecord = { ...announced, heartbeatAt: this._options.clock.now() };
    await this._write(record);
    this._announced = record;
  }

  public async livenessOf(ownerId: OwnerId): Promise<OwnerLiveness> {
    const path = this._ownerFileOrNull(ownerId);
    if (path === null) {
      return 'unknown';
    }

    const read = await this._readAt(path, ownerId.value);
    if (read.kind === 'ok') {
      return this._verdict(read.record);
    }
    if (read.kind === 'absent') {
      // The one place absence is evidence: `retire()` removes the file, and
      // nothing else does until the reconciler (M2.12) collects a window it has
      // already established as dead.
      return 'dead';
    }

    this._options.logger.warn('an owner file could not be read, so its window is not established as gone', {
      path,
      reason: read.reason,
    });
    return 'unknown';
  }

  /**
   * Every window the directory holds, live or not.
   *
   * Deliberately unfiltered: liveness is a separate question with a separate
   * answer, and folding it in here would hide exactly the files that have to be
   * found in order to be collected -- a dead window's presence file outlives
   * every terminal it owned, so a list of the living could never lead anything
   * to it.
   */
  public async listOwners(): Promise<readonly OwnerIdentity[]> {
    const identities: OwnerIdentity[] = [];
    for (const name of await this._ownerFileNames()) {
      const path = join(this._options.layout.ownersDir, name);
      const read = await this._readAt(path, basename(name, OWNER_FILE_SUFFIX));
      if (read.kind === 'ok') {
        identities.push(read.record.identity);
        continue;
      }
      this._options.logger.warn('an owner file was skipped', { path, reason: read.reason });
    }
    return identities;
  }

  /**
   * Removes this window's file, which is what makes it `dead` to everyone else.
   *
   * Idempotent, because it is called from a disposal path and a disposal path
   * that throws on its second run turns a clean shutdown into a reported fault.
   */
  public async retire(): Promise<void> {
    const announced = this._requireAnnounced();
    await rm(this._options.layout.ownerFile(announced.identity.ownerId), { force: true });
    this._retired = true;
  }

  private async _write(record: PresenceRecord): Promise<void> {
    // The path first: it is the step that can refuse, and refusing before
    // anything has been created leaves nothing half-done.
    const path = this._options.layout.ownerFile(record.identity.ownerId);
    await mkdir(this._options.layout.ownersDir, {
      recursive: true,
      mode: STORAGE_DIRECTORY_MODE,
    });
    await writeJsonFile(path, encodePresence(record));
  }

  /**
   * Reads one presence file and checks it is about the window it is named for.
   *
   * The name check is not ceremony. An owner file that is not the file it looks
   * like is the failure M2.1's refusal of unsafe ids was written against, met
   * from the other side: two ids that a case-insensitive file system folds
   * together would share a file, and the window whose heartbeat lands in
   * somebody else's file looks dead while it is running.
   */
  private async _readAt(path: string, named: string): Promise<PresenceRead> {
    const read = await readJsonFile(path);
    if (read.kind === 'absent') {
      return { kind: 'absent', reason: 'there is no file at that path' };
    }
    if (read.kind === 'unreadable') {
      return { kind: 'broken', reason: read.reason };
    }

    const decoded = decodePresence(read.value);
    if (decoded.kind === 'ok' && decoded.record.identity.ownerId.value !== named) {
      return {
        kind: 'broken',
        reason: `the file is named for ${named} and says it belongs to ${decoded.record.identity.ownerId.value}`,
      };
    }
    return decoded;
  }

  private async _ownerFileNames(): Promise<readonly string[]> {
    try {
      const entries = await readdir(this._options.layout.ownersDir, { withFileTypes: true });
      return entries
        .filter((entry) => entry.isFile() && entry.name.endsWith(OWNER_FILE_SUFFIX))
        .map((entry) => entry.name);
    } catch (cause: unknown) {
      // No `owners/` at all is a machine where nothing has announced itself yet,
      // not a failure: the migrator creates it at activation, and a fresh
      // profile reaches this first.
      this._options.logger.info('no window has announced itself on this machine yet', {
        reason: String(cause),
      });
      return [];
    }
  }

  private _verdict(record: PresenceRecord): OwnerLiveness {
    const nowMs = this._options.clock.now().getTime();
    const heartbeatMs = record.heartbeatAt.getTime();

    // Rule one, and it outranks the two below. `owners/*.json` is removed only by
    // `retire()`, and `deactivate()` is not called when the machine restarts
    // (microsoft/vscode#70665), so orphaned files are normal rather than rare --
    // and Windows hands out pids again aggressively. Without this line a stranger
    // holding a dead window's pid would leave its records `unknown` forever.
    if (heartbeatMs < nowMs - this._uptimeSeconds() * MS_PER_SECOND) {
      return 'dead';
    }
    if (!this._isProcessThere(record.identity.pid)) {
      return 'dead';
    }
    return nowMs - heartbeatMs < FRESH_HEARTBEAT_MS ? 'live' : 'unknown';
  }

  /**
   * Whether a process answers to that pid, by the table measured on this machine
   * (§4.8): no exception means it is there, `ESRCH` means it is not, and
   * **every other refusal -- `EPERM` above all -- means it is there and not
   * ours to signal**. A naive `catch { return false }` would call a window
   * started by an administrator dead while it is running.
   */
  private _isProcessThere(pid: number): boolean {
    const probe = this._options.probe ?? sendSignalZero;
    try {
      probe(pid);
      return true;
    } catch (cause: unknown) {
      return (cause as { readonly code?: unknown }).code !== NO_SUCH_PROCESS;
    }
  }

  private _uptimeSeconds(): number {
    const read = this._options.uptimeSeconds ?? uptime;
    return read();
  }

  /**
   * The path of another window's file, or `null` when its id could never name
   * one.
   *
   * `null` becomes `unknown`, never `dead`. An id like that reached us inside a
   * terminal record written by something else, and the honest reading of "this
   * window could not have a presence file" is that we cannot establish anything
   * about it -- certainly not that it is gone.
   */
  private _ownerFileOrNull(ownerId: OwnerId): string | null {
    try {
      return this._options.layout.ownerFile(ownerId);
    } catch (cause: unknown) {
      this._options.logger.warn('an owner id could not name a presence file', {
        ownerId: ownerId.value,
        reason: String(cause),
      });
      return null;
    }
  }

  private _requireAnnounced(): PresenceRecord {
    const announced = this._announced;
    if (announced === null) {
      throw new ConflictError('this window has not announced itself yet');
    }
    return announced;
  }

  private _requireLiving(): PresenceRecord {
    const announced = this._requireAnnounced();
    if (this._retired) {
      throw new ConflictError('this window has retired and must not write itself back');
    }
    return announced;
  }
}

const sendSignalZero: SignalProbe = (pid) => {
  process.kill(pid, 0);
};

export function encodePresence(record: PresenceRecord): PresenceDocument {
  return {
    ownerId: record.identity.ownerId.value,
    kind: record.identity.kind,
    pid: record.identity.pid,
    editorKind: record.identity.editorKind,
    editorVersion: record.identity.editorVersion,
    workspaceFolders: [...record.identity.workspaceFolders],
    startedAt: record.startedAt.getTime(),
    heartbeatAt: record.heartbeatAt.getTime(),
  };
}

/**
 * One presence file, validated whole.
 *
 * Nothing here is optional. A terminal record is read leniently -- losing a
 * record loses a person's notes, so a missing colour must not throw it away
 * (M2.1) -- and a presence file is the opposite: it is rewritten every ten
 * seconds by a process that is still running, so a half-filled one is not a file
 * to rescue but a file to distrust, and distrusting it costs nothing at all.
 */
export function decodePresence(raw: unknown): PresenceDecode {
  try {
    const document = requireRecord(raw);
    return {
      kind: 'ok',
      record: {
        identity: {
          ownerId: OwnerId.fromString(requireString(document.ownerId, 'ownerId')),
          kind: requireOwnerKind(document.kind),
          pid: requirePid(document.pid),
          editorKind: requireEditorKind(document.editorKind),
          editorVersion: requireString(document.editorVersion, 'editorVersion'),
          workspaceFolders: requireStringArray(document.workspaceFolders, 'workspaceFolders'),
        },
        startedAt: new Date(requireNumber(document.startedAt, 'startedAt')),
        heartbeatAt: new Date(requireNumber(document.heartbeatAt, 'heartbeatAt')),
      },
    };
  } catch (cause: unknown) {
    return { kind: 'broken', reason: String(cause) };
  }
}

function requireRecord(value: unknown): Readonly<Record<string, unknown>> {
  const record = asRecord(value);
  if (record === null) {
    throw new ValidationError('an owner file must be a JSON object');
  }
  return record;
}

function requireString(value: unknown, field: string): string {
  const text = asString(value);
  if (text === null) {
    throw new ValidationError(`${field} must be a string`);
  }
  return text;
}

function requireNumber(value: unknown, field: string): number {
  const number = asFiniteNumber(value);
  if (number === null) {
    throw new ValidationError(`${field} must be a finite number`);
  }
  return number;
}

function requireStringArray(value: unknown, field: string): readonly string[] {
  const items = asStringArray(value);
  if (items === null) {
    throw new ValidationError(`${field} must be an array of strings`);
  }
  return items;
}

function requireOwnerKind(value: unknown): OwnerKind {
  const kind = requireString(value, 'kind');
  if (!isOwnerKind(kind)) {
    throw new ValidationError('kind is not an owner kind this build knows', { details: { kind } });
  }
  return kind;
}

function requireEditorKind(value: unknown): EditorKind {
  const editorKind = requireString(value, 'editorKind');
  if (!isEditorKind(editorKind)) {
    throw new ValidationError('editorKind is not an editor this build knows', {
      details: { editorKind },
    });
  }
  return editorKind;
}

/**
 * A pid a liveness question can be asked about at all.
 *
 * `pid <= 0` is refused HERE rather than answered later, because neither answer
 * would be true: `process.kill(0, 0)` does not signal a process at all -- it
 * signals the caller's process group, and never throws -- so a zero would read
 * as a window that is alive forever, while a negative pid gives `ESRCH` and
 * would read as one whose terminals may be taken. Two opposite wrong answers out
 * of the same bad field, so the field is refused where it enters (§4.8).
 */
function requirePid(value: unknown): number {
  const pid = asFiniteNumber(value);
  if (pid === null || !Number.isSafeInteger(pid) || pid <= 0) {
    throw new ValidationError('pid must be a positive whole number', { details: { pid: value } });
  }
  return pid;
}
