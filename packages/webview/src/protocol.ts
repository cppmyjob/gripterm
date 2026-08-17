/**
 * The contract between the page and the extension host.
 *
 * One channel, two parsers, and both directions are parsed rather than cast.
 * A webview is a separate document with its own lifetime: it can be rebuilt
 * under the host, it can be a page of the previous build after a reload, and it
 * can die halfway through its own start-up. `postMessage` carries whatever the
 * other side sent, and a cast would turn every one of those cases into an
 * `undefined` three layers away -- in a `fit` that quietly does nothing, or in a
 * report that says a terminal has no columns because it has no report at all.
 *
 * So the rule of this module: what is not recognised is `null`, and `null` is
 * said out loud rather than acted on.
 *
 * This file is the one part of the webview package that runs on BOTH sides, so
 * it may not touch the document or the editor API. Nothing here does, and the
 * page's own code lives under `page/` where a linter rule keeps `vscode` and the
 * Node builtins out.
 */

/** What the page knows about itself, and the only thing the host learns from it. */
export interface ViewReport {
  /**
   * How many times this view has built a page, counted through the webview's own
   * persisted state.
   *
   * It exists because `retainContextWhenHidden: true` is a DECISION of M3.6 and
   * this is the only number that can check it: a page that survived being hidden
   * reports the generation it was born with, and a page that was thrown away and
   * rebuilt reports the next one.
   */
  readonly generation: number;
  readonly cols: number;
  readonly rows: number;
  /** Width of each half in CSS pixels, as the page's own box reports it. */
  readonly terminalWidth: number;
  readonly detailsWidth: number;
  readonly scrollback: number;
  /** The colour xterm was actually given, so "the theme arrived" is a value. */
  readonly background: string;
  readonly fontFamily: string;
  readonly fontSize: number;
  /** Whether the codicon font loaded -- what M3.9 draws terminal state with. */
  readonly codiconLoaded: boolean;
  /**
   * Which Unicode width table xterm is using.
   *
   * In the report because it is otherwise unfalsifiable: the addon is loaded in
   * one line, and dropping that line breaks nothing a suite can see -- while
   * every `✅` and every CJK glyph Claude Code prints becomes one cell instead
   * of two, and the frame after it is off by a column (M3.2 stage B, answer 4).
   */
  readonly unicodeVersion: string;
}

export type ViewMessage =
  | { readonly kind: 'ready', readonly report: ViewReport }
  | { readonly kind: 'measured', readonly report: ViewReport, readonly because: string }
  | { readonly kind: 'refused', readonly what: string }
  | { readonly kind: 'csp-violation', readonly directive: string, readonly blockedUri: string };

export type HostMessage =
  | { readonly kind: 'restyle', readonly fontFamily: string, readonly fontSize: number }
  | { readonly kind: 'measure', readonly because: string }
  /**
   * The seam the integration suite drives the page through, and it is named
   * `probe` so that nobody has to guess what it is for.
   *
   * A suite has no pointer. "The border between the halves moves" is an
   * acceptance line of M3.6, and the alternatives to this are worse: asserting
   * on the handler through a copy of it, or asserting nothing and calling the
   * step done. The page answers a probe by dispatching REAL pointer events at
   * the splitter, so what runs is the path a person's mouse takes.
   */
  | { readonly kind: 'probe', readonly action: ProbeAction, readonly byPx: number };

/**
 * What a probe may ask for.
 *
 * `break-policy` is the one that keeps `violations: []` from being a vacuum:
 * the page deliberately reaches for a resource the policy forbids, and the
 * suite then asserts that the attempt was BLOCKED and REPORTED. Without it,
 * "no violations" would pass just as happily on a page whose listener was
 * deleted -- which is the defect class this repository keeps meeting.
 */
export type ProbeAction = 'drag-splitter' | 'break-policy';

type Fields = Record<string, unknown>;

function fields(value: unknown): Fields | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }
  return value as Fields;
}

/** A number that is really one: `NaN` and the infinities are not measurements. */
function count(source: Fields, key: string): number | null {
  const found = source[key];
  return typeof found === 'number' && Number.isFinite(found) ? found : null;
}

function text(source: Fields, key: string): string | null {
  const found = source[key];
  return typeof found === 'string' ? found : null;
}

function flag(source: Fields, key: string): boolean | null {
  const found = source[key];
  return typeof found === 'boolean' ? found : null;
}

function parseReport(value: unknown): ViewReport | null {
  const source = fields(value);
  if (source === null) {
    return null;
  }
  const generation = count(source, 'generation');
  const cols = count(source, 'cols');
  const rows = count(source, 'rows');
  const terminalWidth = count(source, 'terminalWidth');
  const detailsWidth = count(source, 'detailsWidth');
  const scrollback = count(source, 'scrollback');
  const background = text(source, 'background');
  const fontFamily = text(source, 'fontFamily');
  const fontSize = count(source, 'fontSize');
  const codiconLoaded = flag(source, 'codiconLoaded');
  const unicodeVersion = text(source, 'unicodeVersion');
  if (
    generation === null ||
    cols === null ||
    rows === null ||
    terminalWidth === null ||
    detailsWidth === null ||
    scrollback === null ||
    background === null ||
    fontFamily === null ||
    fontSize === null ||
    codiconLoaded === null ||
    unicodeVersion === null
  ) {
    return null;
  }
  return {
    generation,
    cols,
    rows,
    terminalWidth,
    detailsWidth,
    scrollback,
    background,
    fontFamily,
    fontSize,
    codiconLoaded,
    unicodeVersion,
  };
}

/** What the host is willing to hear from the page. */
export function parseViewMessage(value: unknown): ViewMessage | null {
  const source = fields(value);
  if (source === null) {
    return null;
  }
  switch (source.kind) {
    case 'ready': {
      const report = parseReport(source.report);
      return report === null ? null : { kind: 'ready', report };
    }
    case 'measured': {
      const report = parseReport(source.report);
      const because = text(source, 'because');
      return report === null || because === null ? null : { kind: 'measured', report, because };
    }
    case 'refused': {
      const what = text(source, 'what');
      return what === null ? null : { kind: 'refused', what };
    }
    case 'csp-violation': {
      const directive = text(source, 'directive');
      const blockedUri = text(source, 'blockedUri');
      return directive === null || blockedUri === null
        ? null
        : { kind: 'csp-violation', directive, blockedUri };
    }
    default:
      return null;
  }
}

/** What the page is willing to hear from the host. */
export function parseHostMessage(value: unknown): HostMessage | null {
  const source = fields(value);
  if (source === null) {
    return null;
  }
  switch (source.kind) {
    case 'restyle': {
      const fontFamily = text(source, 'fontFamily');
      const fontSize = count(source, 'fontSize');
      return fontFamily === null || fontSize === null
        ? null
        : { kind: 'restyle', fontFamily, fontSize };
    }
    case 'measure': {
      const because = text(source, 'because');
      return because === null ? null : { kind: 'measure', because };
    }
    case 'probe': {
      const byPx = count(source, 'byPx');
      const action = source.action;
      return (action === 'drag-splitter' || action === 'break-policy') && byPx !== null
        ? { kind: 'probe', action, byPx }
        : null;
    }
    default:
      return null;
  }
}
