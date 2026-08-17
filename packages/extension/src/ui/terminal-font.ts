import type { ConfigurationChangeEvent } from 'vscode';

/**
 * Which font a Gripterm terminal is drawn in, and where that answer comes from.
 *
 * A webview cannot read the editor's settings: it is a separate document with
 * one message channel, and `terminal.integrated.fontFamily` is not among the CSS
 * variables the editor injects into it. So the extension reads them and the page
 * is told -- at load, through the shell, and afterwards through a message. Both
 * deliveries call the SAME rule below, so there is one answer with two ways of
 * arriving rather than two answers that can drift.
 *
 * Nothing here touches the editor at run time: the `vscode` import is a type and
 * erases, which is what lets the rule be tested by plain `jest` with no host.
 */

/** The four values the editor can offer, exactly as `getConfiguration` gives them. */
export interface FontSettings {
  readonly terminalFamily: string | undefined;
  readonly editorFamily: string | undefined;
  readonly terminalSize: number | undefined;
  readonly editorSize: number | undefined;
}

export interface TerminalFont {
  readonly fontFamily: string;
  readonly fontSize: number;
}

const FALLBACK_FAMILY = 'monospace';
const FALLBACK_SIZE = 14;

/**
 * The rule, and the trap it exists for.
 *
 * `terminal.integrated.fontFamily` defaults to the EMPTY STRING rather than to
 * absence, so `??` walks straight past the fallback and hands a canvas `14px `
 * -- an invalid font that the browser silently replaces with a proportional one.
 * That is not a hypothesis: it is the first defect the M3.1 stand found in
 * itself, and the reason its first character-width measurement was wrong.
 */
export function chooseTerminalFont(settings: FontSettings): TerminalFont {
  return {
    fontFamily: firstNamed([settings.terminalFamily, settings.editorFamily]) ?? FALLBACK_FAMILY,
    fontSize: firstSized([settings.terminalSize, settings.editorSize]) ?? FALLBACK_SIZE,
  };
}

/** Whether a settings change could have moved that answer. */
export function affectsTerminalFont(event: ConfigurationChangeEvent): boolean {
  return (
    event.affectsConfiguration('terminal.integrated.fontFamily') ||
    event.affectsConfiguration('terminal.integrated.fontSize') ||
    event.affectsConfiguration('editor.fontFamily') ||
    event.affectsConfiguration('editor.fontSize')
  );
}

function firstNamed(candidates: readonly (string | undefined)[]): string | null {
  for (const candidate of candidates) {
    const named = candidate?.trim() ?? '';
    if (named.length > 0) {
      return named;
    }
  }
  return null;
}

function firstSized(candidates: readonly (number | undefined)[]): number | null {
  for (const candidate of candidates) {
    if (candidate !== undefined && Number.isFinite(candidate) && candidate > 0) {
      return candidate;
    }
  }
  return null;
}
