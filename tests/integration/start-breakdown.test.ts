import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { readFile } from 'node:fs/promises';
import type { GriptermApi } from '../../packages/extension/src/extension';

/**
 * A start says what it was made of, in a real editor (Ш22).
 *
 * **Why here and not in a unit suite.** `tests/domain/start-ledger.test.ts` holds
 * the RULE -- that the parts and the leftover add up, that a part that did not
 * run is absent, that a slowed part grows alone -- against a clock this run
 * moves by hand. What it cannot see is whether the composition root threads that
 * ledger through anything: a perfect ledger nobody calls prints an empty
 * breakdown and a leftover equal to the whole, and every equality above still
 * holds. Only a real activation can be asked that, and only its own log can be
 * read for the answer.
 *
 * **It reads the FILE in the store**, not a value handed back from `activate`,
 * for the reason Ш3 gave: the evidence a person can send is the store, and a
 * suite that read an object inside the process would be checking something
 * nobody can ever be given.
 *
 * **The names are written out here rather than imported from the product.** A
 * rule that takes its subject from the code it polices goes quiet the day that
 * export is renamed -- and these names are the thing the owner is told to look
 * for, so they are a promise and belong in the statement of it.
 *
 * **Nothing here asserts a duration.** How long a part takes is a fact about
 * this machine this afternoon; what is promised is that the parts are named,
 * that they add up, and that a part which did not happen is missing rather than
 * nought.
 */

/** The product's own two sentences, the whole of what this suite parses for. */
const LISTED = 'the list of terminals is on screen';
const ACTIVATED = 'Gripterm activated';

/** Parts every window has, whatever it finds on the machine. */
const ALWAYS_BEFORE_THE_LIST: readonly string[] = [
  'buildingTheGateway',
  'preparingTheStore',
  'readingTheStore',
  'openingThePort',
  'findingTheCli',
  'findingTheForwarder',
  'buildingTheList',
];

const ALWAYS_AFTER_THE_LIST: readonly string[] = [
  'waitingForTheCliVersion',
  'endingTheirProcesses',
  'readingTheMachine',
  'forgettingClosedTerminals',
];

/** Parts only a window that reads the shared base has. */
const ONLY_WHEN_SHARING: readonly string[] = [
  'theTranscriptIndex',
  'theAgentListing',
  'theFirstSweep',
];

interface Breakdown {
  readonly tookMs: number;
  readonly phases: Readonly<Record<string, number>>;
  readonly remainderMs: number;
}

async function api(): Promise<GriptermApi> {
  const extension = vscode.extensions.getExtension<GriptermApi>('gripterm-placeholder.gripterm');
  assert.ok(extension, 'extension not found in the host');
  return await extension.activate();
}

/**
 * The last line of the log that says `message`, as its details.
 *
 * The LAST, and the message has to be where the format puts it -- after the
 * level, at the start of what remains -- so that a line merely quoting the
 * sentence inside its own context cannot be read as the line itself. Both rules
 * are `tests/stand/start-budget.ts`'s, for the same file format.
 */
function lastSaying(log: string, message: string): Record<string, unknown> | null {
  let found: Record<string, unknown> | null = null;
  for (const line of log.split(/\r?\n/u)) {
    const head = line.split(' ').slice(0, 2).join(' ');
    const rest = line.slice(head.length + 1);
    if (!rest.startsWith(`${message} `)) {
      continue;
    }
    try {
      found = JSON.parse(rest.slice(message.length + 1)) as Record<string, unknown>;
    } catch {
      // A line that is not JSON is not this line; the next one may be.
    }
  }
  return found;
}

function breakdownOf(details: Record<string, unknown>, message: string): Breakdown {
  const tookMs = details.tookMs;
  const phases = details.phases;
  const remainderMs = details.remainderMs;
  assert.equal(typeof tookMs, 'number', `"${message}" printed no tookMs`);
  assert.equal(typeof remainderMs, 'number', `"${message}" printed no remainderMs`);
  assert.ok(
    typeof phases === 'object' && phases !== null && !Array.isArray(phases),
    `"${message}" printed no phases, so a person is told the whole and none of its parts`
  );
  for (const [phase, ms] of Object.entries(phases as Record<string, unknown>)) {
    assert.equal(typeof ms, 'number', `the part ${phase} was printed as something other than a number`);
  }
  return {
    tookMs: tookMs as number,
    phases: phases as Record<string, number>,
    remainderMs: remainderMs as number,
  };
}

async function theTwoLines(): Promise<{ listed: Breakdown, activated: Breakdown }> {
  const { readiness } = await api();
  assert.ok(
    readiness.logFile !== null,
    'this window is writing no log into the store, so nothing here can be read from one'
  );
  const log = await readFile(readiness.logFile, 'utf8');
  const listed = lastSaying(log, LISTED);
  const activated = lastSaying(log, ACTIVATED);
  assert.ok(listed !== null, `the log holds no "${LISTED}" line`);
  assert.ok(activated !== null, `the log holds no "${ACTIVATED}" line`);
  return {
    listed: breakdownOf(listed, LISTED),
    activated: breakdownOf(activated, ACTIVATED),
  };
}

function summed(phases: Readonly<Record<string, number>>): number {
  return Object.values(phases).reduce((total, ms) => total + ms, 0);
}

suite('what a start says it was made of', () => {
  test('both lines break the whole into parts that add up to it', async () => {
    const { listed, activated } = await theTwoLines();

    for (const [what, one] of [['the list', listed], ['activation', activated]] as const) {
      assert.equal(
        summed(one.phases) + one.remainderMs,
        one.tookMs,
        `${what}: the parts and the leftover do not add up to the whole -- ${JSON.stringify(one)}`
      );
      assert.ok(one.remainderMs >= 0, `${what}: the leftover came out negative -- ${JSON.stringify(one)}`);
    }
  });

  test('the line about the list names the parts that ran before it', async () => {
    const { listed } = await theTwoLines();

    for (const phase of ALWAYS_BEFORE_THE_LIST) {
      assert.ok(
        phase in listed.phases,
        `"${LISTED}" did not name ${phase} -- it named ${Object.keys(listed.phases).join(', ')}`
      );
    }
  });

  test('the line about the list does NOT name what had not happened yet', async () => {
    const { listed } = await theTwoLines();

    for (const phase of ['theFirstSweep', 'bringingTerminalsBack', 'endingTheirProcesses']) {
      assert.ok(
        !(phase in listed.phases),
        `"${LISTED}" named ${phase}, which happens after the list is up`
      );
    }
  });

  test('the line about activation names the parts of the whole of it', async () => {
    const { activated } = await theTwoLines();
    const { readiness } = await api();
    const expected = [
      ...ALWAYS_BEFORE_THE_LIST,
      ...ALWAYS_AFTER_THE_LIST,
      ...(readiness.sharing ? ONLY_WHEN_SHARING : []),
    ];

    for (const phase of expected) {
      assert.ok(
        phase in activated.phases,
        `"${ACTIVATED}" did not name ${phase} -- it named ${Object.keys(activated.phases).join(', ')}`
      );
    }
  });

  /**
   * WHEN a part happened, which the parts alone cannot say (Ш23).
   *
   * **What it is about.** `claude --version` is a process spawn whose whole
   * product is one line in this log and one field of `readiness`. Until
   * 2026-08-27 it was awaited between the list going on screen and the machine
   * being read -- so a person whose terminals had not come back yet was waiting
   * on it, and nothing between there and their terminals wanted its answer.
   * Measured in this host that day, over the six activations of ten records:
   * 466, 510, 631, 655, 725 and 882 ms of a wait bought with a string.
   *
   * **Why the ORDER is the assertion and not the duration.** How long the probe
   * takes is a fact about this machine this afternoon; that it is not waited for
   * before the terminals are back is the promise. `phases` is written in the
   * order the parts first opened -- `StartLedger` keeps it that way and JSON
   * preserves it -- so the log itself carries the evidence, and a suite reading
   * it needs no seam the composition root does not have.
   *
   * It is the weakest thing that could still catch the mistake coming back: an
   * await moved above the restore would put the name back in front of it here.
   */
  test('the version probe is not waited for before the terminals are back', async () => {
    const { activated } = await theTwoLines();
    const { readiness } = await api();
    if (!readiness.sharing) {
      // No shared base, so nothing was brought back and there is no "before the
      // restore" to be in front of. Said rather than passed silently.
      assert.ok(!('bringingTerminalsBack' in activated.phases));
      return;
    }

    const order = Object.keys(activated.phases);
    assert.ok(
      order.includes('bringingTerminalsBack'),
      `activation brought nothing back, so this run cannot ask the question -- it named ${order.join(', ')}`
    );
    assert.ok(
      order.indexOf('waitingForTheCliVersion') > order.indexOf('bringingTerminalsBack'),
      'the version probe was waited for before the terminals came back, so a person waited on a log line'
        + ` -- the parts opened in the order ${order.join(', ')}`
    );
  });

  test('a part that did not run is missing rather than nought', async () => {
    const { activated } = await theTwoLines();
    const { readiness } = await api();
    if (readiness.sharing) {
      // This window reads the base, so the parts that need one DID run; the
      // absence this test is about cannot be produced here, and saying so is
      // better than asserting nothing.
      assert.ok('theAgentListing' in activated.phases);
      return;
    }
    for (const phase of ONLY_WHEN_SHARING) {
      assert.ok(
        !(phase in activated.phases),
        `${phase} was printed by a window with no shared base, which never runs it`
      );
    }
  });
});
