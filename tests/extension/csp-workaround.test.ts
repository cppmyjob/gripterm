import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The expiry date on workaround C5, and it is executable rather than written in
 * a document (§7.1, and the ban on traces one can fail to read).
 *
 * C5 is the `'unsafe-inline'` in `style-src` of our page. It is there for a
 * measured reason and not a general one: @xterm/xterm 6.0.0 calls
 * `document.createElement("style")` four times and sets a nonce on none of them,
 * so a page that refused inline styles would render a terminal with no styles at
 * all. The measurement is about a VERSION. When that version moves, the
 * measurement is void -- and the only honest thing a suite can do is go red and
 * say so, rather than let a loosened policy outlive its reason.
 *
 * Failing here does NOT mean the upgrade is wrong. It means somebody has to
 * open the new xterm, count the `createElement("style")` calls again, and either
 * lift C5 from `§7.1` and this file with it, or move the number below and say in
 * the plan that the reason still holds.
 */

const MEASURED_XTERM = '6.0.0';
const MEASURED_ON = '2026-08-17';

const WEBVIEW_PACKAGE = join(__dirname, '..', '..', 'packages', 'webview', 'package.json');

describe('workaround C5, and when it stops being one', () => {
  it(`still stands on the xterm it was measured against (${MEASURED_XTERM}, ${MEASURED_ON})`, () => {
    const manifest = JSON.parse(readFileSync(WEBVIEW_PACKAGE, 'utf8')) as {
      dependencies?: Record<string, string>;
    };
    const version = manifest.dependencies?.['@xterm/xterm'];

    expect(version).toBe(MEASURED_XTERM);
  });

  it('pins that version exactly, so a range cannot slide out from under the measurement', () => {
    const raw = readFileSync(WEBVIEW_PACKAGE, 'utf8');

    expect(raw).not.toMatch(/"@xterm\/[^"]+":\s*"[\^~]/u);
  });
});
