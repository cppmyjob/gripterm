import { makeNonce, webviewPageHtml } from '../../packages/extension/src/ui/webview-html';

/**
 * The shell of the page: the policy it runs under, and the four values it is
 * born with.
 *
 * This is the one part of the webview a unit test can hold. The page itself
 * needs a document and is checked by the integration run inside a real editor
 * -- but the CSP is a STRING, and a string is exactly the kind of thing that
 * rots silently: a directive dropped in an edit costs nothing at build time,
 * nothing at run time, and everything the day the page loads somebody's script.
 */

const PAGE = {
  // What VS Code 1.133 really hands a webview, measured 2026-08-17 rather than
  // invented: a source LIST, with a quoted keyword, a space and a wildcard.
  cspSource: `'self' https://*.vscode-cdn.net`,
  nonce: 'deadbeefdeadbeefdeadbeefdeadbeef',
  scriptUri: 'https://host/dist/webview/main.js',
  styleUri: 'https://host/dist/webview/main.css',
  scrollback: 1000,
  fontFamily: 'Consolas, monospace',
  fontSize: 14,
};

/** The policy as one string, so a directive can be read whole. */
function policy(html: string): string {
  // Found by its own attribute rather than by being the first `content=` in the
  // page: the viewport meta has one too, and a helper that read it would have
  // made every assertion below about the wrong string.
  const found = /http-equiv="Content-Security-Policy" content="(?<policy>[^"]*)"/u.exec(html);
  expect(found?.groups?.policy).toBeDefined();
  return found?.groups?.policy ?? '';
}

/** One directive of it, by name. */
function directive(html: string, name: string): string {
  const part = policy(html)
    .split(';')
    .map((one) => one.trim())
    .find((one) => one.startsWith(`${name} `));
  expect(part).toBeDefined();
  return part ?? '';
}

describe('the policy the page runs under', () => {
  it('permits nothing by default, so every source below is a decision', () => {
    expect(directive(webviewPageHtml(PAGE), 'default-src')).toBe(`default-src 'none'`);
  });

  it('runs scripts by nonce and by nothing else', () => {
    const found = directive(webviewPageHtml(PAGE), 'script-src');
    expect(found).toBe(`script-src 'nonce-${PAGE.nonce}'`);
    // Said separately from the equality above, because this is the assertion
    // that has to survive somebody widening the directive for a good reason.
    expect(found).not.toContain('unsafe-inline');
    expect(found).not.toContain('unsafe-eval');
  });

  it('loosens style-src, and that is workaround C5 rather than an oversight', () => {
    // @xterm/xterm 6.0.0 creates four <style> elements at run time and puts a
    // nonce on none of them. The version that measurement was made against is
    // held by `csp-workaround.test.ts`, which is the expiry date on this line.
    expect(directive(webviewPageHtml(PAGE), 'style-src')).toBe(
      `style-src ${PAGE.cspSource} 'unsafe-inline'`
    );
  });

  it('lets the codicon font load, which is the whole reason font-src is here', () => {
    expect(directive(webviewPageHtml(PAGE), 'font-src')).toBe(`font-src ${PAGE.cspSource}`);
  });

  it('lets images through from our own origin and from data uris', () => {
    expect(directive(webviewPageHtml(PAGE), 'img-src')).toBe(`img-src ${PAGE.cspSource} data:`);
  });
});

describe('what the page is born knowing', () => {
  it('loads the one script, under the nonce it was given', () => {
    expect(webviewPageHtml(PAGE)).toContain(
      `<script nonce="${PAGE.nonce}" src="${PAGE.scriptUri}"></script>`
    );
  });

  it('loads the one stylesheet', () => {
    expect(webviewPageHtml(PAGE)).toContain(`<link rel="stylesheet" href="${PAGE.styleUri}" />`);
  });

  it('carries the scrollback as a number the page can read', () => {
    expect(webviewPageHtml(PAGE)).toContain('data-scrollback="1000"');
  });

  it('carries the terminal font, because a webview cannot read the settings itself', () => {
    const html = webviewPageHtml(PAGE);
    expect(html).toContain('data-font-family="Consolas, monospace"');
    expect(html).toContain('data-font-size="14"');
  });

  it('carries a font family with quotes in it, which is what a real setting looks like', () => {
    // Measured in the test host on 2026-08-17, and this test exists because of
    // what the measurement found: `editor.fontFamily` is
    // `Consolas, 'Courier New', monospace` and `terminal.integrated.fontFamily`
    // is the empty string, so this is the value the shell really gets. The
    // first version of this file REFUSED any quote and threw inside
    // `resolveWebviewView` -- which is a blank panel, with the reason nowhere.
    const html = webviewPageHtml({ ...PAGE, fontFamily: `Consolas, 'Courier New', monospace` });

    expect(html).toContain(`data-font-family="Consolas, 'Courier New', monospace"`);
  });
});

describe('what the shell escapes rather than refuses', () => {
  // The line between the two is who owns the value. A font family is the
  // PERSON'S, and a setting of theirs may not be able to take their panel away
  // -- so it is escaped into an attribute where it cannot do harm. A nonce and
  // a policy source are OURS, and anything unexpected in them is a defect of
  // this build rather than a preference, so those still throw.

  it('escapes a font family that tries to close the element', () => {
    const html = webviewPageHtml({ ...PAGE, fontFamily: 'Consolas</div><script>alert(1)</script>' });

    expect(html).not.toContain('<script>alert(1)');
    expect(html).toContain('data-font-family="Consolas&lt;/div&gt;&lt;script&gt;alert(1)&lt;/script&gt;"');
  });

  it('escapes a quote in a uri, so the attribute cannot be ended', () => {
    const html = webviewPageHtml({ ...PAGE, scriptUri: 'https://host/a"onload="alert(1)' });

    expect(html).not.toContain('"onload="');
    expect(html).toContain('src="https://host/a&quot;onload=&quot;alert(1)"');
  });

  it('escapes the ampersand first, or the escaping itself becomes the injection', () => {
    const html = webviewPageHtml({ ...PAGE, fontFamily: '&quot;' });

    expect(html).toContain('data-font-family="&amp;quot;"');
  });
});

describe('what the shell refuses to build', () => {
  it.each([
    ['a double quote in the policy source would end the attribute', { cspSource: `'self' a"` }],
    ['a semicolon in it would start another directive', { cspSource: `'self'; script-src *` }],
    ['a tag in it would end the element', { cspSource: `'self' <script>` }],
    ['a quote in the nonce would end the attribute', { nonce: 'abc"def' }],
    ['a nonce that is not a nonce at all', { nonce: 'let me in' }],
  ])('refuses to write a page where %s', (_why, broken) => {
    expect(() => webviewPageHtml({ ...PAGE, ...broken })).toThrow(/cannot go into the page/u);
  });

  it.each([
    ['a scrollback that is not a whole number', { scrollback: 1000.5 }],
    ['a scrollback of NaN', { scrollback: Number.NaN }],
    ['a negative scrollback', { scrollback: -1 }],
    ['a font size that is not a number', { fontSize: Number.NaN }],
    ['a font size of zero', { fontSize: 0 }],
  ])('refuses %s', (_why, broken) => {
    expect(() => webviewPageHtml({ ...PAGE, ...broken })).toThrow(/cannot go into the page/u);
  });
});

describe('the nonce', () => {
  it('is different every time, or it is not a nonce', () => {
    const seen = new Set(Array.from({ length: 64 }, () => makeNonce()));
    expect(seen.size).toBe(64);
  });

  it('is long enough and made of nothing that needs escaping', () => {
    expect(makeNonce()).toMatch(/^[0-9a-f]{32}$/u);
  });
});
