/**
 * Stylesheets are ASSETS here, not modules.
 *
 * The page's bundle is built by esbuild, which turns every `.css` import into
 * one stylesheet beside the script and rewrites the font urls inside it. `tsc`
 * compiles the same sources only to type-check them and to emit the declarations
 * the extension reads, and it has no idea what a stylesheet is -- so it is told
 * here, once.
 */
declare module '*.css';
