import * as vscode from "vscode";

const GADF_URL = "https://muzoorabenard-bit.github.io/gadf";

export function activate(context: vscode.ExtensionContext) {
  const disposable = vscode.commands.registerCommand("gadf.openChat", () => {
    const panel = vscode.window.createWebviewPanel(
      "gadfChat",
      "G.A.D.F",
      vscode.ViewColumn.Beside,
      { enableScripts: true, retainContextWhenHidden: true },
    );
    panel.webview.html = getHtml();
  });

  context.subscriptions.push(disposable);
}

function getHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta
      http-equiv="Content-Security-Policy"
      content="default-src 'none'; frame-src ${GADF_URL}; style-src 'unsafe-inline';"
    />
    <style>
      html, body { height: 100%; margin: 0; padding: 0; }
      iframe { width: 100%; height: 100vh; border: none; }
    </style>
  </head>
  <body>
    <iframe src="${GADF_URL}" title="G.A.D.F"></iframe>
  </body>
</html>`;
}

export function deactivate() {}
