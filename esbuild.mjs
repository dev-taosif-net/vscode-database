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
 * The two webviews: the connection editor in a tab, and the connections list in
 * the sidebar. Each is a browser, so each is bundled for the browser with React
 * linked in. They are separate entry points rather than one shared bundle
 * because the sidebar is resolved on startup and the editor is not: sharing a
 * bundle would make opening the sidebar pay for a form nobody has asked for.
 */
/** @type {import('esbuild').BuildOptions} */
const webview = {
  entryPoints: {
    editor: 'src/webview/index.tsx',
    sidebar: 'src/webview/sidebar/index.tsx'
  },
  bundle: true,
  outdir: 'dist/webview',
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
  entryPoints: ['src/webview/styles/editor.css', 'src/webview/styles/sidebar.css'],
  bundle: true,
  outdir: 'dist/webview',
  // The codicon font ships beside these files and is linked from each page, so
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
