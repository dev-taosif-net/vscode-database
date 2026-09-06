import { build, context } from 'esbuild';
import { cp, mkdir } from 'node:fs/promises';

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

/** @type {import('esbuild').BuildOptions} */
const host = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'dist/extension.js',
  platform: 'node',
  target: 'node18',
  format: 'cjs',
  // vscode is provided by the host. The two drivers stay external and are
  // required lazily, so neither one is parsed until a connection is opened.
  external: ['vscode', 'pg', 'tedious'],
  sourcemap: !production,
  minify: production,
  logLevel: 'info'
};

/**
 * The connection editor. It runs in a webview, which is a browser, so it is
 * bundled separately for the browser with React linked in. Nothing here is
 * loaded until an editor is opened.
 */
/** @type {import('esbuild').BuildOptions} */
const webview = {
  entryPoints: ['src/webview/index.tsx'],
  bundle: true,
  outfile: 'dist/webview/editor.js',
  platform: 'browser',
  target: 'es2020',
  format: 'iife',
  jsx: 'automatic',
  define: { 'process.env.NODE_ENV': production ? '"production"' : '"development"' },
  sourcemap: !production,
  minify: production,
  logLevel: 'info'
};

/** @type {import('esbuild').BuildOptions} */
const styles = {
  entryPoints: ['src/webview/styles/editor.css'],
  bundle: true,
  outfile: 'dist/webview/editor.css',
  // The codicon font ships beside this file and is linked from the page, so
  // its url() is left exactly as written.
  external: ['*.ttf'],
  minify: production,
  logLevel: 'info'
};

/** The icon set the workbench itself draws, copied in so nothing is fetched. */
async function copyCodicons() {
  await mkdir('dist/webview', { recursive: true });
  const from = 'node_modules/@vscode/codicons/dist';
  await cp(`${from}/codicon.ttf`, 'dist/webview/codicon.ttf');
  await cp(`${from}/codicon.css`, 'dist/webview/codicon.css');
}

if (watch) {
  await copyCodicons();
  for (const options of [host, webview, styles]) {
    const ctx = await context(options);
    await ctx.watch();
  }
} else {
  await copyCodicons();
  await Promise.all([host, webview, styles].map((options) => build(options)));
}
