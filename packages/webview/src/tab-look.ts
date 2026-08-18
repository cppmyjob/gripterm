/**
 * How an editor's idea of an icon and a colour becomes a page's.
 *
 * Two translations, and both are here because the LITERAL transfer is what an
 * eye would take for correct and a suite would take for passing. The editor
 * hands out values it can resolve itself -- a `ThemeIcon` id, a theme colour id
 * -- and a webview is a document that has neither the icon registry nor the
 * colour table. What it has is a font and a set of CSS variables, and the two
 * are addressed differently:
 *
 *   * `sync~spin` is ONE `ThemeIcon` id and TWO classes: `codicon-sync` for the
 *     glyph and `codicon-modifier-spin` for the turning. Written across as it
 *     stands, the class matches no rule and the tab draws an empty box -- on
 *     `loading~spin` and `sync~spin`, which are the two most common states a
 *     terminal of ours is in (`terminal-presentation.ts`);
 *   * `charts.blue` is a colour id and not a colour. In a document it exists
 *     only as `var(--vscode-charts-blue)`, and written across as it stands it is
 *     an invalid CSS colour -- which browsers do not report, they ignore.
 *
 * Both failures are silent by construction, which is why the rule is a total
 * function of a string, tested to the last branch, and why the page reports the
 * glyph it ACTUALLY drew rather than the class it asked for.
 */

/** The base class every codicon needs, and the prefixes of the other two. */
const BASE = 'codicon';
const GLYPH = 'codicon-';
const MODIFIER = 'codicon-modifier-';

/** What the codicon stylesheet's own names are made of, and nothing else. */
const NAME = /^[a-z0-9-]+$/u;

/** What a theme colour id is made of. Dots separate, and become dashes. */
const COLOR_ID = /^[A-Za-z0-9]+(?:\.[A-Za-z0-9]+)*$/u;

/**
 * The classes that draw one `ThemeIcon` id, or `null` for an id this page
 * cannot draw.
 *
 * `null` rather than a fallback glyph, and that is the same rule the message
 * parser is built on: what is not recognised is said out loud rather than
 * quietly replaced. A tab drawn with a silent substitute would be a state
 * reported as another state, which is the one thing the icon exists to prevent.
 */
export function codiconClasses(iconId: string): readonly string[] | null {
  const [name, ...modifiers] = iconId.split('~');
  if (name === undefined || !NAME.test(name)) {
    return null;
  }
  if (modifiers.some((modifier) => !NAME.test(modifier))) {
    return null;
  }
  return [BASE, `${GLYPH}${name}`, ...modifiers.map((modifier) => `${MODIFIER}${modifier}`)];
}

/**
 * The CSS variable a theme colour id has in a webview, or `null` for an id that
 * is not one.
 *
 * The name only: what it RESOLVES to is the editor's business and the page reads
 * it back off the document, so that "the theme gave us this colour" is a value
 * in a report rather than an assumption in a stylesheet.
 */
export function themeColorVariable(colorId: string): string | null {
  if (!COLOR_ID.test(colorId)) {
    return null;
  }
  return `--vscode-${colorId.replaceAll('.', '-')}`;
}
