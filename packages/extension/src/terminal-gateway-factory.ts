import { chooseEngine, remindOnFirstTerminal } from '@gripterm/core';
import { PtyTerminalGateway } from './adapters/pty-terminal-gateway';
import { VsCodeTerminalGateway } from './adapters/vscode-terminal-gateway';
import type { StripKeeper } from './adapters/vscode-terminal-gateway';
import { loadNodePty } from './adapters/node-pty-module';
import type {
  Disposable,
  EditorIdentity,
  LaunchLocation,
  LaunchMode,
  Logger,
  TerminalAudience,
  TerminalEngine,
  TerminalGateway,
  TerminalId,
} from '@gripterm/core';

/**
 * Which engine this window's terminals are made by, and every way that answer
 * can differ from the one that was asked for.
 *
 * Separate from `extension.ts` because it is the one piece of the composition
 * that has to be EXERCISED: two settings, an addon that may not be there, and a
 * fallback whose whole value is that a person can hear it. Inside `activate` it
 * could only be tested by starting a second Extension Host per case.
 *
 * The engine is not returned beside the gateway. It is `gateway.engine`, read off
 * the object that will make the terminals, because that is the only spelling in
 * which a record cannot disagree with what happened (M3.4).
 */
export interface TerminalGatewayParams {
  /** What `gripterm.terminal.engine` says. What is asked for, not what answers. */
  readonly setting: TerminalEngine;
  readonly mode: LaunchMode;
  readonly location: LaunchLocation;
  /** The extension's own directory: where `build:extension` left the copy of node-pty. */
  readonly extensionPath: string;
  readonly editor: EditorIdentity;
  /**
   * What `gripterm.terminal.ideChannel` says: may the agent reach the Claude
   * Code extension of this editor.
   *
   * Read here rather than deeper because it belongs to the engine question in
   * every way that matters -- only a terminal of our own has to decide it. The
   * editor's engine gets its terminals from the editor, the extension hands them
   * its port there itself, and nothing in this build is in the middle of it.
   */
  readonly ideChannel: boolean;
  readonly logger: Logger;
  /**
   * Whoever will draw the terminals this gateway makes, or nobody.
   *
   * Optional because the editor's engine has no use for it -- its terminals are
   * the editor's own and it is the editor that shows them -- and because the
   * contract suite builds gateways with no view at all. Passed through untouched
   * rather than interpreted here: this function's whole job is which engine, and
   * an audience is neither an engine nor a reason to choose one.
   */
  readonly audience?: TerminalAudience | null;
  /**
   * How the person is told that the engine they asked for is not the one they got.
   *
   * O5 asks for the fallback to be audible rather than merely logged, and the
   * difference is the whole of it: a window that fell back and only wrote a line
   * looks, from the chair in front of it, exactly like a window that did what it
   * was told. Both refusals below are silent about everything else -- an engine
   * that WAS honoured says nothing to anybody.
   *
   * Optional because a gateway can be built where there is nobody to tell: the
   * contract suite makes several per run, and a toast per gateway would be a
   * test talking to a person.
   */
  readonly announce?: (message: string) => void;
  /**
   * Told when a terminal of ours has been made by the EDITOR's engine, so that
   * whoever draws its tab can pair the two (customer's third complaint,
   * 2026-08-21).
   *
   * Optional and editor-only: a terminal of our own has no editor tab at all,
   * and the contract suite builds gateways with nobody watching.
   */
  readonly tabOpened?: (terminalId: TerminalId, terminal: unknown) => void;
  /**
   * Handed the strip when the gateway that was built has one -- the editor's
   * engine, whichever way it was arrived at.
   *
   * A callback rather than a second return value because there are two ways out
   * of this function and one of them wraps the gateway in a decorator: after
   * that wrapping the strip cannot be reached from the object at all, and the
   * one thing a window must be able to do at startup is take away the empty
   * strip a restart brought back.
   *
   * Optional: the contract suite builds gateways with nobody to hand it to.
   */
  readonly keepTheStrip?: (keeper: StripKeeper) => void;
}

/**
 * The editor's gateway, and the strip handed to whoever asked for it. Both ways
 * out of `terminalGatewayFor` that end in editor terminals come through here,
 * so neither of them can forget the second half.
 */
function editorGateway(params: TerminalGatewayParams): VsCodeTerminalGateway {
  const gateway = new VsCodeTerminalGateway(params.location, params.logger, params.tabOpened ?? null);
  params.keepTheStrip?.(gateway);
  return gateway;
}

/**
 * What is said when `own` was asked for and the addon would not load.
 *
 * Composed here rather than in `loadNodePty`, which says the same thing to the
 * log with the directory and the error in it. This one is for a person: it names
 * the setting they set, says which engine is really running, and points at the
 * log for the cause -- because the causes are several and only one of them is
 * their doing.
 */
const ADDON_REFUSAL =
  'gripterm.terminal.engine: own could not be used: the native terminal that ships with Gripterm ' +
  'would not load here, so the editor is making the terminals instead. Run "Gripterm: Show Logs" ' +
  'for what the load failed with. It is missing on Linux by construction -- node-pty carries builds ' +
  'for Windows and macOS only -- and elsewhere it is usually a copy that never arrived or one a ' +
  'security tool has taken away.';

export function terminalGatewayFor(params: TerminalGatewayParams): TerminalGateway & Disposable {
  const choice = chooseEngine(params.setting, params.mode);
  if (choice.refusal !== null) {
    // Out loud, and with both settings named in the sentence itself: a person who
    // set one of them has no way to guess that the other one turned it off.
    params.logger.warn(choice.refusal, {
      setting: 'gripterm.terminal.engine',
      configured: params.setting,
      mode: params.mode,
      using: choice.engine,
    });
    return fallenBackTo(params, choice.refusal);
  }

  if (choice.engine === 'editor') {
    return editorGateway(params);
  }

  const pty = loadNodePty(params.extensionPath, params.logger);
  if (pty === null) {
    // `loadNodePty` has already said why to the LOG; this says it to the person.
    // The engine that answers is the editor's, and because the record is stamped
    // from the gateway, every terminal this window makes will be recorded as
    // `editor` -- which is what stops reconciliation from ending a `claude` that
    // outlives the extension host on purpose (M2.16).
    return fallenBackTo(params, ADDON_REFUSAL);
  }

  const audience = params.audience ?? null;
  if (audience === null) {
    // Said out loud, because it is the difference between an agent on a screen
    // and an agent nobody can see. It is the ordinary shape for a gateway built
    // by the contract suite, and a defect for one built by a window.
    params.logger.warn(
      'terminals are opened by Gripterm itself and nothing is set up to draw them -- an agent started now runs unseen',
      { setting: 'gripterm.terminal.engine', engine: 'own' }
    );
  }
  return new PtyTerminalGateway({
    pty,
    editor: params.editor,
    ideChannel: params.ideChannel,
    logger: params.logger,
    audience,
  });
}

/**
 * The gateway a fallback leaves behind, and the sentence said twice.
 *
 * Once here, which is inside `activate`, and once more when this window makes
 * its first terminal. The second one is not belt and braces: M3.14 measured a
 * fallback in Cursor that worked and that the owner never heard, and the reason
 * is the editor's own -- `workbench.desktop.main.js` purges a warning toast
 * after `PURGE_TIMEOUT[Warning] = 18e3` ms and makes only an ERROR with buttons
 * `sticky`, so the sentence expires while the person is still answering the
 * question about trusting the folder. The rule and its price live in
 * `remindOnFirstTerminal`.
 */
function fallenBackTo(params: TerminalGatewayParams, refusal: string): TerminalGateway & Disposable {
  params.announce?.(refusal);
  // The editor's gateway in both of the two ways a fallback happens, and there
  // is no third: `chooseEngine` refuses exactly one pair of settings, and the
  // addon either loads or it does not.
  return remindOnFirstTerminal(
    editorGateway(params),
    (message) => { params.announce?.(message); },
    refusal
  );
}
