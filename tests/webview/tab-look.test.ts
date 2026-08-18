import { codiconClasses, themeColorVariable } from '../../packages/webview/src/tab-look';

/**
 * The two translations between an editor's names and a document's.
 *
 * Both failures they exist for are invisible: a class that matches no rule
 * draws an empty box, and a colour that is not a colour is ignored by the
 * browser without a word. So the expectations below are written as the LITERAL
 * strings a stylesheet and a theme use, never as the expression that produced
 * them -- a test that recomputed the rule would agree with any rule at all.
 */

describe('an icon id becomes the classes that draw it', () => {
  it('turns a plain id into the base class and the glyph', () => {
    expect(codiconClasses('check')).toStrictEqual(['codicon', 'codicon-check']);
  });

  it.each([
    ['loading~spin', ['codicon', 'codicon-loading', 'codicon-modifier-spin']],
    ['sync~spin', ['codicon', 'codicon-sync', 'codicon-modifier-spin']],
  ])('splits %s, which is one id and two classes', (iconId, classes) => {
    // The two states a terminal of ours is in most of the time. Carried across
    // whole, they name no rule in the stylesheet and the tab draws nothing.
    expect(codiconClasses(iconId)).toStrictEqual(classes);
  });

  it('keeps a hyphen, because half the icons have one', () => {
    expect(codiconClasses('debug-disconnect')).toStrictEqual(['codicon', 'codicon-debug-disconnect']);
  });

  it('takes more than one modifier, since the id may carry them', () => {
    expect(codiconClasses('sync~spin~disabled')).toStrictEqual([
      'codicon',
      'codicon-sync',
      'codicon-modifier-spin',
      'codicon-modifier-disabled',
    ]);
  });

  it.each([
    ['', 'nothing at all'],
    ['~spin', 'a modifier with no icon'],
    ['sync~', 'an icon with an empty modifier'],
    ['sync spin', 'a space, which would make two classes out of one name'],
    ['Sync', 'a capital, which the stylesheet does not have'],
    ['sync"onerror', 'a quote'],
  ])('refuses %s -- %s', (iconId) => {
    // `null` and not a substitute glyph: an icon quietly replaced is a state
    // reported as another state, which is the one thing the icon is for.
    expect(codiconClasses(iconId)).toBeNull();
  });
});

describe('a theme colour id becomes the variable a document has for it', () => {
  it.each([
    ['charts.blue', '--vscode-charts-blue'],
    ['charts.yellow', '--vscode-charts-yellow'],
    ['disabledForeground', '--vscode-disabledForeground'],
    ['terminal.ansiRed', '--vscode-terminal-ansiRed'],
  ])('turns %s into %s', (colorId, variable) => {
    // The case is kept and only the dots move: the editor writes these names
    // into the document itself, and `--vscode-disabledforeground` is a variable
    // that does not exist -- which CSS answers by ignoring the whole
    // declaration, silently.
    expect(themeColorVariable(colorId)).toBe(variable);
  });

  it.each([
    ['', 'nothing at all'],
    ['charts..blue', 'an empty part'],
    ['.blue', 'a leading dot'],
    ['charts.', 'a trailing dot'],
    ['charts blue', 'a space'],
    ['red; background: url(x)', 'a declaration pretending to be a colour'],
  ])('refuses %s -- %s', (colorId) => {
    expect(themeColorVariable(colorId)).toBeNull();
  });
});
