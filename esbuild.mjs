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

/**
 * One diagnostic per line, in the shape `.vscode/tasks.json` reads.
 *
 * esbuild draws a four-line frame around every error, which is the nicer thing
 * to read in a terminal and the impossible thing to parse from a task. Watch
 * mode is the build a task watches, so watch mode prints this instead.
 */
function report(messages, severity) {
  for (const message of messages) {
    const where = message.location
      ? `${message.location.file}:${message.location.line}:${message.location.column + 1}`
      : 'esbuild:0:0';
    console.log(`${where}: ${severity}: ${message.text}`);
  }
}

/**
 * The two lines a launch waits on.
 *
 * `pending` counts builds in flight across all three contexts rather than per
 * context, so one edit is one `started` and one `finished` however many bundles
 * it happens to touch. The three contexts do not begin in lockstep, though, so
 * a count that reaches zero is not proof the edit is done being built: the
 * finish is held for a quiet moment and withdrawn if another bundle starts
 * inside it. A launch that believes a half-written `dist` is finished is
 * exactly the failure this file is here to avoid.
 */
const QUIET = 100;
let pending = 0;
let announced = false;
let idle = null;

const marker = {
  name: 'build-markers',
  setup(build) {
    build.onStart(() => {
      if (idle !== null) {
        clearTimeout(idle);
        idle = null;
      }
      if (pending++ === 0 && !announced) {
        announced = true;
        console.log('[build] started');
      }
    });
    build.onEnd((result) => {
      report(result.warnings, 'warning');
      report(result.errors, 'error');
      if (--pending > 0) {
        return;
      }
      idle = setTimeout(() => {
        idle = null;
        announced = false;
        console.log('[build] finished');
      }, QUIET);
    });
  }
};

const configs = [host, webview, styles];

if (watch) {
  await copyCodicons();
  const contexts = await Promise.all(
    configs.map((options) => context({ ...options, logLevel: 'silent', plugins: [marker] }))
  );
  await Promise.all(contexts.map((ctx) => ctx.watch()));
} else {
  await copyCodicons();
  try {
    await Promise.all(configs.map((options) => build(options)));
  } catch {
    // esbuild has already printed the failure at `logLevel: 'info'`. All this
    // has to do is make the task fail rather than exit zero on a broken build.
    process.exitCode = 1;
  }
}
