import { chooseEngine } from '@gripterm/core';
import { PtyTerminalGateway } from './adapters/pty-terminal-gateway';
import { VsCodeTerminalGateway } from './adapters/vscode-terminal-gateway';
import { loadNodePty } from './adapters/node-pty-module';
import type {
  Disposable,
  EditorIdentity,
  LaunchLocation,
  LaunchMode,
  Logger,
  TerminalEngine,
  TerminalGateway,
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
  readonly logger: Logger;
}

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
  }

  if (choice.engine === 'editor') {
    return new VsCodeTerminalGateway(params.location, params.logger);
  }

  const pty = loadNodePty(params.extensionPath, params.logger);
  if (pty === null) {
    // `loadNodePty` has already said why. The engine that answers is the editor's,
    // and because the record is stamped from the gateway, every terminal this
    // window makes will be recorded as `editor` -- which is what stops
    // reconciliation from ending a `claude` that outlives the extension host on
    // purpose (M2.16).
    return new VsCodeTerminalGateway(params.location, params.logger);
  }

  // Said at every activation that chooses this engine, because it is the whole of
  // what a person notices today: the agent runs, and there is nothing on the
  // screen. Our own view is M3.6 and the strip that switches between terminals is
  // M3.9. The setting's own description says the same thing where it is chosen.
  params.logger.warn(
    'terminals are opened by Gripterm itself, and Gripterm has no view to show them in yet -- an agent started now runs unseen',
    { setting: 'gripterm.terminal.engine', engine: 'own' }
  );
  return new PtyTerminalGateway({
    pty,
    editor: params.editor,
    logger: params.logger,
  });
}
