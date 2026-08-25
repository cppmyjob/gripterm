import { ContextWindowSnapshot } from '../../domain/entities/context-window-snapshot';
import { CostSnapshot } from '../../domain/entities/cost-snapshot';
import { HumanMetadata } from '../../domain/entities/human-metadata';
import { LaunchRecipe } from '../../domain/entities/launch-recipe';
import { Note } from '../../domain/entities/note';
import { ObservedState, type SnapshotProvenance } from '../../domain/entities/observed-state';
import { OwnerId } from '../../domain/entities/owner-id';
import { OwnerRef, isEditorKind, isOwnerKind } from '../../domain/entities/owner-ref';
import { SessionId } from '../../domain/entities/session-id';
import { TerminalEntry, type ClosedBy } from '../../domain/entities/terminal-entry';
import { TerminalId } from '../../domain/entities/terminal-id';
import { ValidationError } from '../../domain/errors/gripterm-error';
import { isPermissionMode } from '../../domain/entities/permission-mode';
import { isTerminalEngine } from '../../domain/entities/terminal-engine';
import { isPersistedTerminalState } from '../../domain/entities/terminal-state';
import type { TerminalEngine } from '../../domain/entities/terminal-engine';
import {
  asArray,
  asFiniteNumber,
  asRecord,
  asString,
  asStringArray,
  asStringMap,
} from '../../domain/json/json-readers';

/**
 * `record.json`. Timestamps are epoch milliseconds, matching how the entry
 * holds them, so that a round trip cannot lose a time zone it never had.
 */
export interface RecordDocument {
  readonly terminalId: string;
  readonly sessionId: string;
  readonly sessionIdHistory: readonly string[];
  readonly owner: {
    readonly kind: string;
    readonly ownerId: string;
    readonly editorKind: string;
    readonly workspaceFolder: string | null;
  };
  readonly metadata: {
    readonly displayName: string;
    readonly task: string | null;
    readonly notes: readonly { readonly at: number, readonly text: string }[];
    readonly tags: readonly string[];
    readonly color: string | null;
  };
  readonly launch: {
    readonly cwd: string;
    readonly addDirs: readonly string[];
    readonly permissionMode: string | null;
    readonly agent: string | null;
    readonly model: string | null;
    readonly worktree: string | null;
    readonly mcpConfigPaths: readonly string[];
    readonly appendSystemPrompt: string | null;
    readonly extraEnv: Readonly<Record<string, string>>;
  };
  /**
   * Which engine made the terminal (M3.4).
   *
   * Optional in the document and NOT a schema version bump, deliberately: the
   * directory version is what prior builds refuse a whole base over
   * (`storage-migrator.ts:122`), and `StorageMigrator` does not rewrite records
   * (`:36`). So absence is given a meaning instead -- `editor`, the engine that
   * kills nothing -- and every record ever written stays readable.
   */
  readonly engine?: string;
  /**
   * Where the person put this terminal among the others, or absent.
   *
   * Optional and NOT a schema bump, for the same reason `engine` above is: prior
   * builds refuse a whole base over the directory version, and the migrator does
   * not rewrite records. Absence is given a meaning instead -- "nobody arranged
   * this one" -- and `TerminalEntry.placement` reads it as the moment the
   * terminal was made, which is the order the tabs appeared in.
   */
  readonly order?: number | null;
  readonly createdAt: number;
  readonly closedAt: number | null;
  /**
   * Which hand closed it. Optional and NOT a schema bump, for the same reason
   * `engine` and `order` above are not: a build that has never heard of it
   * reads the record exactly as it did before, and absence has a meaning.
   */
  readonly closedBy?: string | null;
  readonly revision: number;
}

/** `observed.json`. A separate file because it is rewritten far more often. */
export interface ObservedDocument {
  readonly state: string;
  readonly lastEventAt: number;
  readonly currentTool: string | null;
  readonly lastAssistantMessage: string | null;
  readonly cost: { readonly totalUsd: number, readonly durationMs: number } | null;
  readonly contextWindow: { readonly usedPercentage: number } | null;
  readonly pid: number | null;
  /**
   * Who was working in the conversation when this was written: the main agent
   * and the subagents it had started (2026-08-21).
   *
   * Absent in every file written before that date, and absent is empty --
   * which is exactly what this build believed before it: that a `Stop` settles
   * the record whatever else is running.
   */
  readonly running: readonly string[];
  /**
   * `recovered` when this file holds a snapshot the store stood up rather than
   * one it observed, and absent on every file written before 2026-08-25.
   *
   * Absent reads as `observed`, which is what every one of those files holds
   * and what this build assumed about all of them until the mark existed. It is
   * stored rather than recomputed at each read because a stand-in that is
   * written back -- `_store` writes both halves on every write -- would
   * otherwise come back next time as an observation, and the one thing this
   * mark exists to prevent is exactly that laundering.
   *
   * It clears itself: the next real event builds a state out of what arrived,
   * and that state says `observed` without anybody remembering to reset this.
   */
  readonly provenance?: string;
}

/**
 * Where the observed half came from.
 *
 * `recovered` carries a sentence because it is the interesting case and it is
 * SILENT otherwise: the terminal reappears with a plausible-looking state and
 * nothing on screen says the cache was lost. The repository logs this.
 */
export type ObservedProvenance =
  | { readonly kind: 'stored' }
  | { readonly kind: 'recovered', readonly reason: string };

export type EntryDecode =
  | {
      readonly kind: 'ok';
      readonly entry: TerminalEntry;
      readonly observed: ObservedProvenance;
    }
  | { readonly kind: 'broken', readonly reason: string };

export function encodeRecord(entry: TerminalEntry): RecordDocument {
  return {
    terminalId: entry.terminalId.value,
    sessionId: entry.sessionId.value,
    sessionIdHistory: entry.sessionIdHistory.map((id) => id.value),
    owner: {
      kind: entry.owner.kind,
      ownerId: entry.owner.ownerId.value,
      editorKind: entry.owner.editorKind,
      workspaceFolder: entry.owner.workspaceFolder,
    },
    metadata: {
      displayName: entry.metadata.displayName,
      task: entry.metadata.task,
      notes: entry.metadata.notes.map((note) => ({ at: note.at.getTime(), text: note.text })),
      tags: [...entry.metadata.tags],
      color: entry.metadata.color,
    },
    launch: {
      cwd: entry.launch.cwd,
      addDirs: [...entry.launch.addDirs],
      permissionMode: entry.launch.permissionMode,
      agent: entry.launch.agent,
      model: entry.launch.model,
      worktree: entry.launch.worktree,
      mcpConfigPaths: [...entry.launch.mcpConfigPaths],
      appendSystemPrompt: entry.launch.appendSystemPrompt,
      extraEnv: { ...entry.launch.extraEnv },
    },
    engine: entry.engine,
    order: entry.order,
    createdAt: entry.createdAt.getTime(),
    closedAt: entry.closedAt === null ? null : entry.closedAt.getTime(),
    closedBy: entry.closedBy,
    revision: entry.revision,
  };
}

export function encodeObserved(state: ObservedState): ObservedDocument {
  return {
    state: state.state,
    lastEventAt: state.lastEventAt.getTime(),
    currentTool: state.currentTool,
    lastAssistantMessage: state.lastAssistantMessage,
    cost:
      state.cost === null
        ? null
        : { totalUsd: state.cost.totalUsd, durationMs: state.cost.durationMs },
    contextWindow:
      state.contextWindow === null ? null : { usedPercentage: state.contextWindow.usedPercentage },
    pid: state.pid,
    running: state.running,
    // Written only when there is something to say. Absent is `observed`, which
    // is what every file written before this mark existed holds and what almost
    // every file written after it will hold -- so the exceptional case is the
    // one that costs a key, and no snapshot on disk changes shape for it.
    ...(state.provenance === 'recovered' ? { provenance: 'recovered' } : {}),
  };
}

/**
 * One terminal, out of the two files it is stored in.
 *
 * The validation is the DOMAIN's: every field is handed to the constructor that
 * already owns the rule, and anything those constructors refuse comes back here
 * as `broken`. There is deliberately no second list of what is valid -- one
 * would drift from the first, and the drift would show up as a record this
 * codec accepted and the aggregate then could not build.
 *
 * The two halves fail differently, and that asymmetry is the point:
 *
 *   * a broken `record.json` loses the terminal, so it is reported and the
 *     caller isolates that one entry rather than failing the whole read;
 *   * a broken or absent `observed.json` loses nothing that matters -- observed
 *     state is rebuilt from events and is explicitly cheap to lose -- so the
 *     entry survives with a recovered snapshot and a sentence saying so.
 *
 * Pass `undefined` for `observed` when the file is not there.
 */
export function decodeEntry(record: unknown, observed: unknown): EntryDecode {
  try {
    const document = requireRecord(record, 'record');
    const createdAt = new Date(requireNumber(document.createdAt, 'createdAt'));
    const recovery = readObserved(observed, createdAt);

    const entry = TerminalEntry.create({
      terminalId: TerminalId.fromString(requireString(document.terminalId, 'terminalId')),
      sessionId: SessionId.fromString(requireString(document.sessionId, 'sessionId')),
      sessionIdHistory: optionalStringArray(document.sessionIdHistory, 'sessionIdHistory').map(
        (id) => SessionId.fromString(id)
      ),
      owner: decodeOwner(document.owner),
      metadata: decodeMetadata(document.metadata),
      launch: decodeLaunch(document.launch),
      observed: recovery.state,
      engine: decodeEngine(document.engine),
      // Refused rather than ignored when it is there and unreadable: an
      // arrangement this build cannot understand is a strip drawn in an order
      // the person did not choose, and silently drawing it differently is the
      // defect this field exists to end.
      order: document.order === undefined || document.order === null
        ? null
        : requireNumber(document.order, 'order'),
      createdAt,
      closedAt: nullableNumberToDate(document.closedAt, 'closedAt'),
      closedBy: decodeClosedBy(document.closedBy),
      revision: requireNumber(document.revision, 'revision'),
    });

    return { kind: 'ok', entry, observed: recovery.provenance };
  } catch (cause: unknown) {
    return { kind: 'broken', reason: sentenceOf(cause) };
  }
}

interface Recovery {
  readonly state: ObservedState;
  readonly provenance: ObservedProvenance;
}

/**
 * The observed half, or a stand-in for it.
 *
 * The stand-in is `degraded` -- "the process may well be alive, but we do not
 * know its state" -- which is the literal truth after losing the cache, and its
 * `lastEventAt` is the record's own creation time rather than the clock's now.
 * Stamping it with now would claim we had just heard from a terminal we have
 * heard nothing from, and every watch and reconciler downstream reads that
 * field as evidence.
 */
function readObserved(raw: unknown, createdAt: Date): Recovery {
  if (raw === undefined) {
    return { state: lostObserved(createdAt), provenance: recovered('there is no observed.json') };
  }
  try {
    return { state: decodeObserved(raw), provenance: { kind: 'stored' } };
  } catch (cause: unknown) {
    return { state: lostObserved(createdAt), provenance: recovered(sentenceOf(cause)) };
  }
}

function recovered(reason: string): ObservedProvenance {
  return { kind: 'recovered', reason };
}

function lostObserved(createdAt: Date): ObservedState {
  return ObservedState.create({
    // Said on the snapshot itself and not only in the report beside it. The
    // report reaches the log; this reaches the rules that decide whether a
    // second `claude --resume` may be started on the conversation, and the
    // stamp below is the record's creation time rather than a sign of life.
    provenance: 'recovered',
    state: 'degraded',
    lastEventAt: createdAt,
    currentTool: null,
    lastAssistantMessage: null,
    cost: null,
    contextWindow: null,
    pid: null,
  });
}

function decodeObserved(raw: unknown): ObservedState {
  const document = requireRecord(raw, 'observed');
  const state = requireString(document.state, 'observed.state');
  if (!isPersistedTerminalState(state)) {
    throw new ValidationError('observed.state is not a state this build stores', {
      details: { state },
    });
  }

  const cost = requireRecordOrNull(document.cost, 'observed.cost');
  const context = requireRecordOrNull(document.contextWindow, 'observed.contextWindow');

  return ObservedState.create({
    state,
    lastEventAt: new Date(requireNumber(document.lastEventAt, 'observed.lastEventAt')),
    currentTool: nullableString(document.currentTool, 'observed.currentTool'),
    lastAssistantMessage: nullableString(
      document.lastAssistantMessage,
      'observed.lastAssistantMessage'
    ),
    cost:
      cost === null
        ? null
        : CostSnapshot.create(
            requireNumber(cost.totalUsd, 'observed.cost.totalUsd'),
            requireNumber(cost.durationMs, 'observed.cost.durationMs')
          ),
    contextWindow:
      context === null
        ? null
        : ContextWindowSnapshot.create(
            requireNumber(context.usedPercentage, 'observed.contextWindow.usedPercentage')
          ),
    pid: nullableNumber(document.pid, 'observed.pid'),
    running: names(document.running),
    provenance: readProvenance(document.provenance),
  });
}

/**
 * The mark, or the answer every file without one carries.
 *
 * Nothing is refused here and nothing throws, which is the opposite of the rule
 * the fields above follow -- and the asymmetry is the direction of the mistake.
 * A field this build cannot read means it cannot tell an invented snapshot from
 * an observed one, and the answer to not being able to tell is to say
 * `recovered`, which only ever keeps a record OUT of a restore. Refusing the
 * whole snapshot instead would throw the record onto `lostObserved`, which says
 * `recovered` too -- by a longer road and with a warning about a file that is
 * not broken.
 */
function readProvenance(value: unknown): SnapshotProvenance {
  return value === 'observed' || value === undefined ? 'observed' : 'recovered';
}

/**
 * The names of what was running, read leniently on purpose.
 *
 * Every other field here throws on rubbish, and this one does not: it is the
 * cheapest thing in the file -- rebuilt by the next hook that arrives -- and
 * refusing the whole `observed.json` over it would throw away the state, the
 * last message and the cost, all of which cost something to lose. Anything that
 * is not a list of strings reads as "nobody", which is this build's own
 * behaviour before the field existed.
 */
function names(raw: unknown): readonly string[] {
  return Array.isArray(raw) ? raw.filter((one): one is string => typeof one === 'string') : [];
}

/**
 * The engine, whose two failure directions were chosen separately.
 *
 * Absent means `editor`: that is every record written before the field existed,
 * and the answer costs nothing worse than a process nobody cleans up.
 *
 * Present and unreadable means BROKEN -- a whole row lost from the list, logged
 * with its reason (`file-terminal-repository.ts:270`), the file itself untouched
 * so that rolling forward reads it again. That is heavier than the usual default,
 * and it is heavier on purpose: this is the field reconciliation reads before it
 * kills a process, and a build that called a value it cannot read `editor` would
 * be asserting knowledge it does not have. One row back is recoverable; one
 * conversation ended is not.
 */
/**
 * Lenient where `engine` is strict, and the difference is argued rather than
 * inherited.
 *
 * A record whose `closedBy` this build cannot read is a record a NEWER build
 * wrote, and refusing it outright would take a person's whole conversation away
 * over one word. Unknown is read as `editor`, which is the answer that keeps the
 * record: the cost of being wrong is a row that a person has to sweep by hand,
 * against a conversation that no longer exists.
 */
function decodeClosedBy(raw: unknown): ClosedBy | null {
  if (raw === undefined || raw === null) {
    return null;
  }
  return requireString(raw, 'closedBy') === 'person' ? 'person' : 'editor';
}

function decodeEngine(raw: unknown): TerminalEngine {
  if (raw === undefined) {
    return 'editor';
  }
  const engine = requireString(raw, 'engine');
  if (!isTerminalEngine(engine)) {
    throw new ValidationError('engine is not an engine this build knows', { details: { engine } });
  }
  return engine;
}

function decodeOwner(raw: unknown): OwnerRef {
  const document = requireRecord(raw, 'owner');
  const kind = requireString(document.kind, 'owner.kind');
  const editorKind = requireString(document.editorKind, 'owner.editorKind');
  if (!isOwnerKind(kind)) {
    throw new ValidationError('owner.kind is not a kind this build knows', { details: { kind } });
  }
  if (!isEditorKind(editorKind)) {
    throw new ValidationError('owner.editorKind is not an editor this build knows', {
      details: { editorKind },
    });
  }
  return OwnerRef.create({
    kind,
    ownerId: OwnerId.fromString(requireString(document.ownerId, 'owner.ownerId')),
    editorKind,
    workspaceFolder: nullableString(document.workspaceFolder, 'owner.workspaceFolder'),
  });
}

function decodeMetadata(raw: unknown): HumanMetadata {
  const document = requireRecord(raw, 'metadata');
  return HumanMetadata.create({
    displayName: requireString(document.displayName, 'metadata.displayName'),
    task: nullableString(document.task, 'metadata.task'),
    notes: decodeNotes(document.notes),
    tags: optionalStringArray(document.tags, 'metadata.tags'),
    color: nullableString(document.color, 'metadata.color'),
  });
}

function decodeNotes(raw: unknown): readonly Note[] {
  if (raw === undefined || raw === null) {
    return [];
  }
  const items = asArray(raw);
  if (items === null) {
    throw new ValidationError('metadata.notes must be an array');
  }
  return items.map((item) => {
    const note = requireRecord(item, 'metadata.notes[]');
    return Note.create(
      new Date(requireNumber(note.at, 'metadata.notes[].at')),
      requireString(note.text, 'metadata.notes[].text')
    );
  });
}

function decodeLaunch(raw: unknown): LaunchRecipe {
  const document = requireRecord(raw, 'launch');
  const permissionMode = nullableString(document.permissionMode, 'launch.permissionMode');
  if (permissionMode !== null && !isPermissionMode(permissionMode)) {
    throw new ValidationError('launch.permissionMode is not a mode the CLI accepts', {
      details: { permissionMode },
    });
  }

  const extraEnv = document.extraEnv;
  const env = extraEnv === undefined ? {} : asStringMap(extraEnv);
  if (env === null) {
    throw new ValidationError('launch.extraEnv must be an object of strings');
  }

  return LaunchRecipe.create({
    cwd: requireString(document.cwd, 'launch.cwd'),
    addDirs: optionalStringArray(document.addDirs, 'launch.addDirs'),
    permissionMode,
    agent: nullableString(document.agent, 'launch.agent'),
    model: nullableString(document.model, 'launch.model'),
    worktree: nullableString(document.worktree, 'launch.worktree'),
    mcpConfigPaths: optionalStringArray(document.mcpConfigPaths, 'launch.mcpConfigPaths'),
    appendSystemPrompt: nullableString(document.appendSystemPrompt, 'launch.appendSystemPrompt'),
    extraEnv: env,
  });
}

/*
 * Below: the readers. Two rules, and they are not the same rule.
 *
 * A field the record cannot exist without -- an id, a creation time -- is
 * REQUIRED, and its absence makes the record broken. A field that is allowed to
 * be empty treats a missing key as `null` or as an empty list, because the cost
 * of the two mistakes is not symmetric: refusing a record because it lacks a
 * colour would throw away the task and the notes with it, and those are the one
 * thing in this store that nothing can rebuild.
 */

function requireRecord(value: unknown, field: string): Readonly<Record<string, unknown>> {
  const record = asRecord(value);
  if (record === null) {
    throw new ValidationError(`${field} must be a JSON object`);
  }
  return record;
}

function requireRecordOrNull(value: unknown, field: string): Readonly<Record<string, unknown>> | null {
  return value === undefined || value === null ? null : requireRecord(value, field);
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

function nullableString(value: unknown, field: string): string | null {
  return value === undefined || value === null ? null : requireString(value, field);
}

function nullableNumber(value: unknown, field: string): number | null {
  return value === undefined || value === null ? null : requireNumber(value, field);
}

function nullableNumberToDate(value: unknown, field: string): Date | null {
  const number = nullableNumber(value, field);
  return number === null ? null : new Date(number);
}

function optionalStringArray(value: unknown, field: string): readonly string[] {
  if (value === undefined || value === null) {
    return [];
  }
  const items = asStringArray(value);
  if (items === null) {
    throw new ValidationError(`${field} must be an array of strings`);
  }
  return items;
}

/** Total over `unknown` by having no branch at all -- see `cli-probe`. */
function sentenceOf(error: unknown): string {
  return String(error);
}
