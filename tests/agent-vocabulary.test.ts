import { readFileSync, readdirSync } from 'node:fs';
import * as path from 'node:path';
import * as ts from 'typescript';

/**
 * The vocabulary boundary: the neutral domain may not speak one agent's words.
 *
 * `eslint.config.mjs` already forbids the domain to IMPORT from
 * `domain/agents/**`, and `tests/boundaries.test.ts` asks the linter whether
 * that still works. A dependency rule cannot see the defect this file is about:
 * a `case 'PreToolUse':` imports nothing at all, and neither does
 * `CLAUDE_CODE_AUTO_CONNECT_IDE`. Copying a foreign word is how a boundary is
 * crossed without a single import.
 *
 * It reads the SOURCE TREE rather than a list of files, so a literal added
 * tomorrow to a module that does not exist today is caught on the same run.
 *
 * **Comments are excluded structurally, not by a regular expression.** The scan
 * walks a TypeScript syntax tree, and a comment is trivia: it is attached to no
 * node and reaches no check here. So "Claude Code emits over thirty event
 * types" in a doc comment is invisible to this file by construction, which is
 * the intended outcome -- it is a true sentence about the world, written where
 * a reader needs it.
 *
 * **Human texts are excluded by an explicit register, not by a heuristic.**
 * Nothing in the syntax tells `'CLAUDE_CLI_ERROR'` from `'Claude Code names its
 * conversation among the ones it is running'`: both are string literals in
 * value position, and both are `const`. Rather than guess, every sentence a
 * person may read that names the agent is written out below with its reason.
 * A new one costs an entry and a line of justification, which is the point --
 * and `the register still describes the tree` keeps it from outliving its
 * subject.
 */

const REPO_ROOT = path.resolve(__dirname, '..');
const DOMAIN_ROOT = path.join(REPO_ROOT, 'packages', 'core', 'src', 'domain');

/** The one directory of the domain that is allowed to know whose CLI it is. */
const AGENTS_ROOT = path.join(DOMAIN_ROOT, 'agents');

/**
 * Claude Code's own thirteen hook names, written out HERE.
 *
 * Deliberately not imported from `domain/agents/claude-code/`. A rule that took
 * its subject from the code it polices goes quiet the day that export is
 * renamed or deleted, and it would then pass over a domain full of the very
 * words it exists to keep out. These are a fact about somebody else's CLI, so
 * the statement of the rule owns them, exactly as the state machine's table
 * lives in its test rather than beside the machine.
 */
const CLAUDE_CODE_HOOK_NAMES: readonly string[] = [
  'SessionStart',
  'SessionEnd',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'PermissionRequest',
  'Notification',
  'Stop',
  'StopFailure',
  'SubagentStart',
  'SubagentStop',
  'CwdChanged',
];

/** Case-insensitive, because `CLAUDE_CODE_AUTO_CONNECT_IDE` and `'claude'` are the same word. */
const NAMES_THE_AGENT = /claude/iu;

interface HumanText {
  /** Relative to the repository root, forward slashes. */
  readonly file: string;
  /** The literal exactly as the syntax tree reports it -- one template span counts as one entry. */
  readonly text: string;
  readonly why: string;
}

/**
 * Every sentence in the neutral domain that names Claude Code to a person.
 *
 * None of these is a mistake. "Install Claude Code" is the right sentence for
 * somebody who has Claude Code and has not put it on PATH, and a build that
 * said "install the agent" would be helping nobody. They are listed rather than
 * detected because they are a decision: each one is a place where the domain
 * hard-codes WHICH agent it is talking about in words, and the register is what
 * makes that visible in one place instead of scattered through six files.
 *
 * THE WAY OUT, when somebody takes it: the display name belongs to the port
 * implementation, not to the domain -- `AgentCommandFactory` (or a sibling
 * port) hands over the name and these sentences interpolate it. Then this
 * register empties, and the day it is empty the exclusion can be deleted rather
 * than trusted.
 */
const HUMAN_TEXTS: readonly HumanText[] = [
  {
    file: 'packages/core/src/domain/services/launch-readiness.ts',
    text: ' on this machine. Install Claude Code, or start the editor from a shell whose PATH has it, then reload the window.',
    why: 'told to a person whose CLI is not on PATH: naming the product is the whole help',
  },
  {
    file: 'packages/core/src/domain/services/restore-orchestrator.ts',
    text: '" did not come back: Claude Code could not continue that conversation ',
    why: 'announced to a person whose conversation was replaced by a new one',
  },
  {
    file: 'packages/core/src/domain/services/restore-planner.ts',
    text: 'its Claude Code process has not been established to have stopped',
    why: 'the answer to "why is my terminal not back", read by a person',
  },
  {
    file: 'packages/core/src/domain/services/restore-planner.ts',
    text: 'Claude Code names its conversation among the ones it is running',
    why: 'the answer to "why is my terminal not back", read by a person',
  },
  {
    file: 'packages/core/src/domain/services/restore-planner.ts',
    text: 'Claude Code still has the process it was running as, under a conversation this record does not name',
    why: 'the answer to "why is my terminal not back", read by a person',
  },
  {
    file: 'packages/core/src/domain/services/restore-planner.ts',
    text: 'Claude Code could not be asked what it is running, and nothing starts on a guess',
    why: 'the answer to "why is my terminal not back", read by a person',
  },
  {
    file: 'packages/core/src/domain/services/restore-planner.ts',
    text: 'the Claude Code conversations could not be listed, so nothing is known to be resumable',
    why: 'the answer to "why is my terminal not back", read by a person',
  },
  {
    file: 'packages/core/src/domain/services/session-name-mirror.ts',
    text: 'the name Claude Code has for a conversation could not be read',
    why: 'a log line: the reader is a person looking for why a row kept its old name',
  },
  {
    file: 'packages/core/src/domain/services/session-name-mirror.ts',
    text: 'a conversation was renamed in Claude Code, and its row followed',
    why: 'a log line: the reader is a person looking for why a row changed its name',
  },
  {
    file: 'packages/core/src/domain/services/storage-directory.ts',
    text: 'nothing would stand between them and a second claude --resume on a transcript that is already ',
    why: 'the refusal shown to a person whose two hosts would share one store',
  },
];

interface Token {
  /** Relative to the repository root, forward slashes. */
  readonly file: string;
  readonly line: number;
  readonly text: string;
  readonly role: 'identifier' | 'string';
}

const TOKENS = scanNeutralDomain();

describe('the neutral domain does not speak Claude Code hook names', () => {
  it('has no identifier or string literal that IS a hook name', () => {
    // Exact equality, not "contains". `stop()` on a service and a `Stop` hook
    // are different words that happen to share letters, and a rule that could
    // not tell them apart would be switched off within a week.
    const offenders = TOKENS.filter((token) => CLAUDE_CODE_HOOK_NAMES.includes(token.text));
    expect(reported(offenders)).toStrictEqual([]);
  });
});

describe('the neutral domain does not name the agent in its identifiers or constants', () => {
  it('has no identifier and no string constant carrying the word claude', () => {
    const offenders = TOKENS.filter(
      (token) => NAMES_THE_AGENT.test(token.text) && !isRegisteredHumanText(token)
    );
    expect(reported(offenders)).toStrictEqual([]);
  });

  it('keeps the register of human texts describing the tree it excuses', () => {
    // An exclusion nobody can see rot is an exclusion that grows. Every entry
    // has to still be in the file it claims, so a sentence that was reworded or
    // deleted is reported here instead of quietly widening the rule.
    const stale = HUMAN_TEXTS.filter(
      (allowed) =>
        !TOKENS.some(
          (token) =>
            token.role === 'string' && token.file === allowed.file && token.text === allowed.text
        )
    );
    expect(stale.map((entry) => `${entry.file} :: ${entry.text}`)).toStrictEqual([]);
  });
});

function isRegisteredHumanText(token: Token): boolean {
  return (
    token.role === 'string' &&
    HUMAN_TEXTS.some((allowed) => allowed.file === token.file && allowed.text === token.text)
  );
}

/** Readable failures: a count says a rule broke, a list says where. */
function reported(offenders: readonly Token[]): readonly string[] {
  return offenders.map(
    (token) => `${token.file}:${token.line.toString()} ${token.role} ${token.text}`
  );
}

function scanNeutralDomain(): readonly Token[] {
  return neutralDomainFiles().flatMap((file) => tokensOf(file));
}

/** Every `.ts` of the domain except the one directory that may name an agent. */
function neutralDomainFiles(): readonly string[] {
  const found: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (full === AGENTS_ROOT) {
        continue;
      }
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.name.endsWith('.ts')) {
        found.push(full);
      }
    }
  };
  walk(DOMAIN_ROOT);
  return found.sort((left, right) => left.localeCompare(right));
}

/**
 * Every name and every written string of one file.
 *
 * What is collected is what a machine matches on: identifiers (which no person
 * ever reads on a screen) and string literals, including the pieces of a
 * template literal, each span on its own. What is NOT collected is everything
 * the parser treats as trivia -- line comments, block comments, doc comments --
 * because none of it is a node.
 */
function tokensOf(file: string): readonly Token[] {
  const source = ts.createSourceFile(
    file,
    readFileSync(file, 'utf8'),
    ts.ScriptTarget.ES2022,
    true
  );
  const relative = path.relative(REPO_ROOT, file).split(path.sep).join('/');
  const found: Token[] = [];

  const record = (node: ts.Node, text: string, role: Token['role']): void => {
    found.push({
      file: relative,
      line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
      text,
      role,
    });
  };

  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) || ts.isPrivateIdentifier(node)) {
      record(node, node.text, 'identifier');
    } else if (ts.isStringLiteralLike(node)) {
      record(node, node.text, 'string');
    } else if (ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
      record(node, node.text, 'string');
    }
    ts.forEachChild(node, visit);
  };

  ts.forEachChild(source, visit);
  return found;
}
