import * as vscode from 'vscode';

/**
 * The page every phase 3 webview is served in.
 *
 * The content security policy is the one the editor and the sidebar already
 * run under, unchanged: no network at all. No remote script, no remote style,
 * no remote font, and no connection of any kind from inside the page.
 * Everything a webview needs ships with the extension.
 */
export function webviewHtml(
  webview: vscode.Webview,
  extensionUri: vscode.Uri,
  options: { bundle: string; stylesheet: string; title: string; view: string; address?: string }
): string {
  const nonce = makeNonce();
  const asset = (...parts: string[]) =>
    webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'dist', 'webview', ...parts));

  const csp = [
    "default-src 'none'",
    `img-src ${webview.cspSource} data:`,
    `style-src ${webview.cspSource}`,
    `font-src ${webview.cspSource}`,
    `script-src 'nonce-${nonce}'`
  ].join('; ');

  // The view name and the address ride on the body rather than in a message.
  // The name is there so the app knows which surface it is before the host has
  // said anything — a bundle that waited for a message would flash an empty
  // frame on every tab switch. The address is there so the page can hand it
  // back through `setState`, which is the only thing a serializer gets after a
  // window reload.
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link href="${asset('codicon.css')}" rel="stylesheet">
<link href="${asset(options.stylesheet)}" rel="stylesheet">
<title>${escapeHtml(options.title)}</title>
</head>
<body data-view="${escapeHtml(options.view)}"${
    options.address ? ` data-address="${escapeHtml(options.address)}"` : ''
  }>
<div id="root"></div>
<script nonce="${nonce}" src="${asset(options.bundle)}"></script>
</body>
</html>`;
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function makeNonce(): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let text = '';
  for (let i = 0; i < 32; i++) {
    text += alphabet.charAt(Math.floor(Math.random() * alphabet.length));
  }
  return text;
}
