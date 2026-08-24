import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { uptime } from 'node:os';
import { newest } from './refuse-stale-builds.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CORE = join(ROOT, 'packages', 'core', 'dist', 'index.js');

/**
 * Why a store folder did not bring its terminals back, answered without a
 * window and without asking the person anything (Ш3).
 *
 * **The shape of the problem.** Somebody writes "my terminals did not come
 * back". The only thing they can send is their `~/.gripterm` folder: a command
 * that reports has to be run IN the window that went wrong, and a person closes
 * that window before they write to anybody. Every answer therefore has to be
 * recoverable from the folder alone. This technique found the cause four times
 * out of four in a day before it was a file, which is why it became one.
 *
 * **It runs the PRODUCT'S OWN planner** -- `planRestore` out of
 * `packages/core/dist`, over the real `FileTerminalRepository` and the real
 * `FileOwnerPresence`. A reimplementation would answer a question about itself:
 * the whole value of this is that it is wrong exactly where the product is
 * wrong, so an answer it gives about somebody's folder is an answer about their
 * build.
 *
 * **It only reads.** Nothing here writes, moves or removes anything, which is
 * what makes it safe to point at a copy of a real store. `readAll` and
 * `livenessOf` are the only two calls made, and neither of them writes.
 *
 * **Two of the planner's inputs are not in a folder at all**, and rather than
 * guess quietly it says what it assumed:
 *
 *   * what the CLI is running -- assumed to be nothing, because an assumption of
 *     "could not be asked" would answer `agents-unavailable` about every record
 *     and hide the reason the folder DOES establish;
 *   * which conversations have a transcript -- assumed to be all of them, for
 *     the same reason;
 *   * which pids are alive -- asked of THIS machine, which is only the right
 *     answer when the folder came off it. `--pids gone` asks the other way.
 *
 * Usage:
 *
 *   node tools/explain-store.mjs <folder>
 *   node tools/explain-store.mjs <folder> --folder C:/projects/mine
 *   node tools/explain-store.mjs <folder> --agents unavailable --transcripts none
 *   node tools/explain-store.mjs <folder> --pids gone --now 2026-08-23T22:12:49Z
 */

function usage() {
  return [
    'usage: node tools/explain-store.mjs <folder> [options]',
    '',
    '  --folder <path>        a folder the asking window had open (repeatable).',
    '                         Default: each record is explained as the window that',
    '                         owns it would have seen it, so `foreign-folder` never',
    '                         fires unless you ask this question.',
    '  --agents unavailable   ask as though `claude agents --json` could not be read.',
    '                         Default: it answered, and nothing is running.',
    '  --agents-running <id>  a conversation the CLI names as running (repeatable).',
    '  --transcripts none     ask as though no conversation has a transcript.',
    '                         Default: every conversation this store names has one.',
    '  --pids gone            treat every recorded pid as established gone.',
    '                         Default: ask THIS machine, which is only right when',
    '                         the folder came off it.',
    '  --now <iso>            the moment to reason from. Default: now.',
  ].join('\n');
}

function parseArguments(argv) {
  const options = {
    store: null,
    folders: null,
    agents: 'listing',
    running: [],
    transcripts: 'all',
    pids: 'here',
    nowMs: Date.now(),
  };
  for (let at = 0; at < argv.length; at += 1) {
    const word = argv[at];
    const next = () => {
      at += 1;
      const value = argv[at];
      if (value === undefined) {
        throw new Error(`${word} needs a value.\n\n${usage()}`);
      }
      return value;
    };
    switch (word) {
      case '--folder':
        options.folders = [...(options.folders ?? []), next()];
        break;
      case '--agents':
        options.agents = next();
        if (options.agents !== 'unavailable') {
          throw new Error(`--agents takes only 'unavailable'.\n\n${usage()}`);
        }
        break;
      case '--agents-running':
        options.running.push(next());
        break;
      case '--transcripts':
        options.transcripts = next();
        if (options.transcripts !== 'none') {
          throw new Error(`--transcripts takes only 'none'.\n\n${usage()}`);
        }
        break;
      case '--pids':
        options.pids = next();
        if (options.pids !== 'gone' && options.pids !== 'here') {
          throw new Error(`--pids takes 'gone' or 'here'.\n\n${usage()}`);
        }
        break;
      case '--now': {
        const at2 = Date.parse(next());
        if (Number.isNaN(at2)) {
          throw new Error(`--now was not a moment I can read.\n\n${usage()}`);
        }
        options.nowMs = at2;
        break;
      }
      case '--help':
      case '-h':
        throw new Error(usage());
      default:
        if (word.startsWith('-')) {
          throw new Error(`I do not know the option ${word}.\n\n${usage()}`);
        }
        if (options.store !== null) {
          throw new Error(`only one folder at a time, and I already have ${options.store}.\n\n${usage()}`);
        }
        options.store = resolve(word);
    }
  }
  if (options.store === null) {
    throw new Error(usage());
  }
  return options;
}

/**
 * Refuses to answer out of a build older than its source.
 *
 * The same guard `.vscode-test.mjs` carries, for the same reason and after the
 * same incident: a run that measures code nobody wrote today says green about
 * it, and here it would say a REASON about it -- a sentence somebody is going
 * to act on. `pnpm run build` is what fixes it.
 */
function refuseAStalePlanner() {
  if (!existsSync(CORE)) {
    throw new Error(
      `the product's planner has not been built (${CORE} is missing). Run \`pnpm run build\`.`
    );
  }
  /*
   * The NEWEST file under `dist`, not `dist/index.js`.
   *
   * Measured 2026-08-24, and it cost a red gate: `tsc --build` rewrites only the
   * outputs whose content actually changed, so `index.js` can honestly sit at
   * yesterday's timestamp while the file that was edited an hour ago is fresh.
   * A guard on one file would refuse every correct build that did not happen to
   * touch that one -- and a guard that cries wolf is a guard people switch off.
   */
  const built = newest(['packages/core/dist']);
  const source = newest(['packages/core/src']);
  if (built !== null && source !== null && built < source) {
    throw new Error(
      'the planner in packages/core/dist is older than its source, so this would explain a store '
      + `with code that is not in the build: dist was last written ${new Date(built).toISOString()}, `
      + `packages/core/src at ${new Date(source).toISOString()}. Run \`pnpm run build\`.`
    );
  }
}

/**
 * The `Logger` the store's own objects are handed, and it says nothing.
 *
 * The report below is the whole output on purpose: a reader who asked "why did
 * this not come back" must not have the answer buried under the repository's
 * own commentary about directories it skipped. What those lines would have said
 * is in the person's own log, in the folder, which is the other half of Ш3.
 */
const QUIET = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

/** A probe that answers "there is no such process", used by `--pids gone`. */
const NOTHING_IS_THERE = () => {
  const gone = new Error('ESRCH');
  gone.code = 'ESRCH';
  throw gone;
};

async function main() {
  const options = parseArguments(process.argv.slice(2));
  refuseAStalePlanner();

  const core = await import(pathToFileURL(CORE).href);
  const {
    FileOwnerPresence,
    FileTerminalRepository,
    OwnerId,
    StorageLayout,
    explainRefusal,
    planRestore,
    sendSignalZero,
    pidsEstablishedGone,
  } = core;

  const layout = new StorageLayout(options.store);
  if (!existsSync(layout.terminalsDir) && !existsSync(layout.versionFile)) {
    throw new Error(
      `${options.store} is not a Gripterm store: it has neither a \`version\` file nor a \`terminals\` `
      + 'directory. The folder to send is the one called `.gripterm`.'
    );
  }

  const presence = new FileOwnerPresence({
    layout,
    // The clock the verdict is measured against. A presence file is `live` when
    // its heartbeat is fresh AGAINST THIS, so `--now` is what lets somebody ask
    // "what would this store have said at the moment it went wrong".
    clock: { now: () => new Date(options.nowMs) },
    logger: QUIET,
    ...(options.pids === 'gone' ? { probe: NOTHING_IS_THERE } : {}),
  });
  const repository = new FileTerminalRepository({
    layout,
    // Never used: `readAll` is the only call made, and `owner` is what `write`
    // checks against. A drawn id rather than a real one, so that nothing here
    // could be mistaken for a window announcing itself.
    owner: { ownerId: OwnerId.fromString('explain-store'), kind: 'window' },
    presence,
    clock: { now: () => new Date(options.nowMs) },
    logger: QUIET,
  });

  const entries = await repository.readAll();
  const probe = options.pids === 'gone' ? NOTHING_IS_THERE : sendSignalZero;
  const pids = new Set(entries.map((entry) => entry.observed.pid).filter((pid) => pid !== null));
  const ownerLiveness = new Map();
  for (const entry of entries) {
    const { ownerId } = entry.owner;
    if (!ownerLiveness.has(ownerId.value)) {
      ownerLiveness.set(ownerId.value, await presence.livenessOf(ownerId));
    }
  }

  const world = {
    entries,
    ownerLiveness,
    deadPids: pidsEstablishedGone(pids, probe),
    agents:
      options.agents === 'unavailable'
        ? { kind: 'unavailable', reason: 'you asked me to answer as though the CLI could not be read' }
        : { kind: 'listing', agents: options.running.map((id) => ({ sessionId: { value: id } })) },
    transcripts:
      options.transcripts === 'none'
        ? { kind: 'indexed', sessionIds: new Set(), skipped: 0 }
        : { kind: 'indexed', sessionIds: new Set(entries.map((entry) => entry.sessionId.value)), skipped: 0 },
    nowMs: options.nowMs,
    uptimeSeconds: uptime(),
  };

  process.stdout.write(report({ options, entries, world, planRestore, explainRefusal }));
}

/**
 * The verdict for one record, as the window that could have brought it back
 * would have reached it.
 *
 * The planner is run once per record with THAT record's own folder as the
 * window's, unless `--folder` was given -- because a store does not say which
 * window was asking, and answering `foreign-folder` about every record on the
 * strength of a default would be the tool inventing the reason it reports.
 * The rest of the base is in `entries` every time, which is what keeps the
 * duplicate check honest.
 */
function verdictFor(entry, options, world, planRestore) {
  const windowFolders =
    options.folders ?? (entry.owner.workspaceFolder === null ? [] : [entry.owner.workspaceFolder]);
  const plan = planRestore({ ...world, windowFolders });
  const step = plan.steps.find((one) => one.entry.terminalId.equals(entry.terminalId));
  if (step !== undefined) {
    return { kind: 'start', intent: step.intent };
  }
  const skip = plan.skipped.find((one) => one.entry.terminalId.equals(entry.terminalId));
  return skip === undefined
    ? { kind: 'unreached', reason: null }
    : { kind: 'refused', reason: skip.reason };
}

function report({ options, entries, world, planRestore, explainRefusal }) {
  const lines = [];
  lines.push('gripterm: why the terminals in this folder did not come back');
  lines.push(`store            ${options.store}   (read only -- nothing here is written)`);
  lines.push(`records          ${String(entries.length)}`);
  lines.push(`reasoning as of  ${new Date(options.nowMs).toISOString()}`);
  lines.push('');
  lines.push('assumed, because a folder cannot hold it:');
  lines.push(
    options.agents === 'unavailable'
      ? '  what the CLI is running       the CLI could not be asked      (you passed --agents unavailable)'
      : `  what the CLI is running       nothing, ${String(options.running.length)} named as running   (--agents unavailable asks the other way)`
  );
  lines.push(
    options.transcripts === 'none'
      ? '  which have a transcript       none of them                    (you passed --transcripts none)'
      : '  which have a transcript       all of them                     (--transcripts none asks the other way)'
  );
  lines.push(
    options.pids === 'gone'
      ? '  which pids are alive          none of them                    (you passed --pids gone)'
      : '  which pids are alive          asked of THIS machine           (--pids gone asks the other way)'
  );
  lines.push(
    options.folders === null
      ? '  the folders the window had    each record`s own, so the folder rule never fires  (--folder <path> asks it)'
      : `  the folders the window had    ${options.folders.join(', ')}`
  );
  lines.push('');

  for (const entry of entries) {
    const verdict = verdictFor(entry, options, world, planRestore);
    lines.push(`${entry.terminalId.value}  "${entry.metadata.displayName}"`);
    lines.push(`    owner        ${entry.owner.ownerId.value}  (${world.ownerLiveness.get(entry.owner.ownerId.value) ?? 'unknown'})`);
    lines.push(`    folder       ${entry.owner.workspaceFolder ?? '(none)'}`);
    lines.push(`    conversation ${entry.sessionId.value}`);
    lines.push(
      `    state        ${entry.observed.state}   pid ${entry.observed.pid === null ? '(none)' : String(entry.observed.pid)}`
      + `   closed ${entry.closedAt === null ? 'no' : new Date(entry.closedAt).toISOString()}`
    );
    if (verdict.kind === 'start') {
      lines.push(`    VERDICT      would come back -- ${verdict.intent}`);
      lines.push(
        verdict.intent === 'resume'
          ? '                 continuing the conversation it names'
          : '                 nothing was ever said in its conversation, so it comes back holding a new one'
      );
    } else if (verdict.kind === 'refused') {
      lines.push(`    VERDICT      did NOT come back -- ${verdict.reason}`);
      lines.push(`                 ${explainRefusal(verdict.reason)}`);
    } else {
      // Cannot happen: the planner puts every record it considered into one of
      // the two lists. Said rather than left blank, because a blank verdict is
      // exactly the silence this whole tool exists against.
      lines.push('    VERDICT      the planner returned neither a step nor a refusal for this record, which is a defect in it');
    }
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
}

main().catch((cause) => {
  process.stderr.write(`${cause instanceof Error ? cause.message : String(cause)}\n`);
  process.exitCode = 1;
});
