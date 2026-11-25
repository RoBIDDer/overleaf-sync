'use strict';
const vscode = require('vscode');
const bisync = require('./bisync');
exports.activate = context => {
  const output = vscode.window.createOutputChannel('Overleaf 论文同步');
  context.subscriptions.push(output);
  async function run(dryRun) {
    try {
      const folders = vscode.workspace.workspaceFolders;
      if (!folders || folders.length !== 1 || folders[0].uri.scheme !== 'file') throw Error('请在 VS Code 中打开单个本地 LaTeX 文件夹。');
      if (!(await bisync.isBisync(folders[0].uri))) throw Error('此文件夹没有 .overleaf/bisync.json，请先完成首次配置。');
      await bisync.runManual(folders[0].uri, dryRun, output);
    } catch (error) { vscode.window.showErrorMessage('Overleaf 同步: ' + error.message); }
  }
  context.subscriptions.push(
    vscode.commands.registerCommand('overleaf-paper-sync.sync', () => run(false)),
    vscode.commands.registerCommand('overleaf-paper-sync.check', () => run(true)));
  const folders = vscode.workspace.workspaceFolders;
  if (folders && folders.length === 1 && folders[0].uri.scheme === 'file') {
    bisync.isBisync(folders[0].uri).then(yes => yes && bisync.startAuto(folders[0].uri, output, context))
      .catch(error => output.appendLine('[自动] 启动失败：' + (error.stack || error)));
  }
};
