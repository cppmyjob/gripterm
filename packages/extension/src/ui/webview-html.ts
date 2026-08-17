import { randomBytes } from 'node:crypto';

/**
 * The shell of the page: the policy it runs under, and the values it is born
 * with.
 *
 * Separated from the view that serves it because a policy is a STRING, and a
 * string is the kind of thing that rots without a sound: a directive dropped in
 * an edit costs nothing at build time, nothing at run time, and everything the
 * day the page loads somebody else's script. Here it can be read by a test.
 *
 * The page itself -- the halves, the terminal, the observers -- lives in
 * `@gripterm/webview` and is checked inside a real editor. This is only what the
 * page is handed on the way in.
 */

export interface WebviewPage {
  /** The origin the editor gives this webview; every resource comes from it. */
  readonly cspSource: string;
  readonly nonce: string;
  readonly scriptUri: string;
  readonly styleUri: string;
  readonly scrollback: number;
  readonly fontFamily: string;
  readonly fontSize: number;
}

/** 128 bits, which is the length the editor's own webviews use for theirs. */
const NONCE_BYTES = 16;

/** What `makeNonce` produces, and the only thing the policy will carry. */
const NONCE_SHAPE = /^[0-9a-f]+$/u;

/**
 * What a policy source may NOT contain, and the list is short because of what
 * the editor really hands over.
 *
 * Measured 2026-08-17 in VS Code 1.133: `webview.cspSource` is
 * `'self' https://*.vscode-cdn.net` -- a source LIST, with a quoted keyword, a
 * space and a wildcard in it. A guard that refused any of those refused the
 * editor's own value, and that is not a hypothetical: it is what this file did
 * for the first hour of M3.6, and the symptom was a blank panel with the reason
 * nowhere (the throw happened inside `resolveWebviewView`, which the editor
 * swallows).
 *
 * So what is refused is only what would let the value escape where it is put:
 * a double quote ends the attribute, a semicolon starts another directive, and
 * the angle brackets end the element.
 */
const FORBIDDEN_IN_SOURCE = /["<>;]/u;

export function makeNonce(): string {
  return randomBytes(NONCE_BYTES).toString('hex');
}

/**
 * Refused or escaped: the line between them is who owns the value.
 *
 * A font family is the PERSON'S. `editor.fontFamily` on this machine is
 * `Consolas, 'Courier New', monospace` -- measured 2026-08-17, in the test host
 * -- and the first version of this file refused every quote, threw inside
 * `resolveWebviewView`, and left a blank panel with the reason nowhere. A
 * setting of theirs may not be able to take their panel away, so what they own
 * is escaped into an attribute where it can do no harm.
 *
 * A nonce and a policy source are OURS: one is generated four lines above, the
 * other comes from the editor. Escaping would not help either -- both go into
 * the policy itself, which has no entities -- and anything unexpected in them is
 * a defect of this build rather than a preference. Those still throw.
 */
export function webviewPageHtml(page: WebviewPage): string {
  if (!NONCE_SHAPE.test(page.nonce)) {
    throw new RangeError(`a nonce of "${page.nonce}" cannot go into the page`);
  }
  if (FORBIDDEN_IN_SOURCE.test(page.cspSource)) {
    throw new RangeError(`a policy source of "${page.cspSource}" cannot go into the page`);
  }
  if (!Number.isSafeInteger(page.scrollback) || page.scrollback < 0) {
    throw new RangeError(`a scrollback of ${String(page.scrollback)} cannot go into the page`);
  }
  if (!Number.isFinite(page.fontSize) || page.fontSize <= 0) {
    throw new RangeError(`a font size of ${String(page.fontSize)} cannot go into the page`);
  }

  /*
   * The policy, directive by directive:
   *
   *   default-src 'none'  -- nothing is allowed that is not named below, so
   *                          every line under it is a decision somebody made.
   *   img-src             -- our own origin, plus data uris for anything drawn
   *                          inline.
   *   font-src            -- the codicon font, which is what M3.9 draws the
   *                          state of a terminal with.
   *   style-src           -- our own origin AND 'unsafe-inline'. This is
   *                          WORKAROUND C5 (§7.1) and not an oversight:
   *                          @xterm/xterm 6.0.0 creates four <style> elements at
   *                          run time and puts a nonce on none of them, so a
   *                          page that refused inline styles would render a
   *                          terminal with no styles at all. Its expiry is
   *                          executable -- `tests/extension/csp-workaround.test.ts`
   *                          goes red the day that version moves.
   *   script-src          -- the nonce and nothing else. No 'unsafe-inline', no
   *                          'unsafe-eval': the script below is ours, it is
   *                          bundled, and it is the only one.
   */
  const policy = [
    `default-src 'none'`,
    `img-src ${page.cspSource} data:`,
    `font-src ${page.cspSource}`,
    `style-src ${page.cspSource} 'unsafe-inline'`,
    `script-src 'nonce-${page.nonce}'`,
  ].join('; ');

  const scriptUri = escapeAttribute(page.scriptUri);
  const styleUri = escapeAttribute(page.styleUri);
  const fontFamily = escapeAttribute(page.fontFamily);

  return [
    '<!DOCTYPE html>',
    '<html lang="en">',
    '  <head>',
    '    <meta charset="UTF-8" />',
    '    <meta name="viewport" content="width=device-width, initial-scale=1.0" />',
    `    <meta http-equiv="Content-Security-Policy" content="${policy}" />`,
    `    <link rel="stylesheet" href="${styleUri}" />`,
    '    <title>Gripterm</title>',
    '  </head>',
    '  <body>',
    // The page builds its own furniture; this is the box it builds it in, and
    // the three values it cannot read for itself.
    `    <div id="gripterm-root" data-scrollback="${String(page.scrollback)}"` +
      ` data-font-family="${fontFamily}" data-font-size="${String(page.fontSize)}"></div>`,
    `    <script nonce="${page.nonce}" src="${scriptUri}"></script>`,
    '  </body>',
    '</html>',
  ].join('\n');
}

/**
 * A value that can stand inside a double-quoted attribute and nowhere else.
 *
 * The ampersand goes first, and the order is the rule: escaping it last would
 * rewrite the `&` of an escape this function had just written, and `&quot;`
 * would come back out of the browser as `"`.
 */
function escapeAttribute(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}
