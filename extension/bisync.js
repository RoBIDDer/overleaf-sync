'use strict';
// Two-way, incremental sync. Active only for folders that contain .overleaf/bisync.json.
const vscode = require('vscode');
const core = require('./bisync-core');
const { takeControl } = require('./workshop');
const { sendFile } = require('./multipart');

const CONFIG = '.overleaf/bisync.json', STATE = '.overleaf/bisync-state.json', BASE = '.overleaf/bisync-base', BACKUP = '.overleaf/bisync-backup';
const KEEP_BACKUPS = 30;
const wfs = () => vscode.workspace.fs;
const join = (root, name) => vscode.Uri.joinPath(root, ...name.split('/'));
const notFound = e => e && (e.code === 'FileNotFound' || e.code === 'ENOENT');
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function readOrNull(uri) { try { return Buffer.from(await wfs().readFile(uri)); } catch (e) { if (notFound(e)) return null; throw e; } }
async function readJson(uri) { const d = await readOrNull(uri); return d === null ? null : JSON.parse(d.toString('utf8')); }

exports.isBisync = async root => (await readOrNull(join(root, CONFIG))) !== null;

class Session {
  constructor(root, output) { this.root = root; this.output = output; this.dirtyTree = false; }

  async open() {
    const meta = await readJson(join(this.root, '.overleaf/settings.json'));
    if (!meta) throw Error('缺少 .overleaf/settings.json。');
    this.meta = meta;
    this.remoteRoot = vscode.Uri.parse(meta.uri);
    if (this.remoteRoot.scheme !== 'overleaf-workshop' || this.remoteRoot.authority !== meta.serverName) throw Error('Overleaf 项目连接配置不匹配。');
    this.config = (await readJson(join(this.root, CONFIG))) || {};
    this.state = (await readJson(join(this.root, STATE))) || { projectUri: meta.uri, files: {}, ignoredRemote: [] };
    if (this.state.projectUri !== meta.uri) throw Error('同步状态与当前项目不匹配。');
    const workshop = vscode.extensions.getExtension('iamhyc.overleaf-workshop');
    if (!workshop) throw Error('请先安装 Overleaf Workshop。');
    await workshop.activate();
    const vfs = await vscode.commands.executeCommand('remoteFileSystem.prefetch', this.remoteRoot);
    if (!vfs || typeof vfs.init !== 'function') throw Error('无法获取 Overleaf 项目连接。');
    await vfs.init();
    if (!vfs.root || !vfs.socket || typeof vfs.socket.joinDoc !== 'function' || typeof vfs._resolveUri !== 'function') throw Error('当前 Workshop 版本与助手不兼容。');
    this.vfs = vfs;
  }

  async saveState() { await wfs().writeFile(join(this.root, STATE), Buffer.from(JSON.stringify(this.state, null, 1))); }

  // ---- remote ----
  remoteTree() {
    const out = new Map();
    const walk = (folder, prefix) => {
      for (const d of folder.docs || []) out.set(prefix + d.name, { type: 'doc', id: d._id, entity: d, folder });
      for (const f of folder.fileRefs || []) out.set(prefix + f.name, { type: 'file', id: f._id, hash: f.hash, entity: f, folder });
      for (const s of folder.folders || []) walk(s, prefix + s.name + '/');
    };
    walk(this.vfs.root.rootFolder[0], '');
    return out;
  }
  // Always asks the server. Workshop's own cache is refreshed so a later write is based on this content.
  async readDoc(entry) {
    const res = await this.vfs.socket.joinDoc(entry.id);
    const text = res.docLines.join('\n');
    Object.assign(entry.entity, { version: res.version, remoteCache: text, localCache: text });
    return core.normalize(text);
  }
  async download(name, entry) {
    let last;
    for (let i = 0; i < 3; i++) {
      try {
        const data = Buffer.from((await wfs().readFile(join(this.remoteRoot, name))) || []);
        if (!data.length) throw Error('下载内容为空');
        if (entry.hash && core.gitBlobSha1(data) !== entry.hash) throw Error('下载内容校验不一致');
        return data;
      } catch (e) { last = e; await sleep(500 * (i + 1)); }
    }
    throw Error('下载失败：' + (last.message || last));
  }
  async ensureParents(name) {
    const parts = name.split('/');
    for (let i = 1; i < parts.length; i++) {
      const uri = vscode.Uri.joinPath(this.remoteRoot, ...parts.slice(0, i));
      try { await wfs().stat(uri); } catch (e) { if (!notFound(e)) throw e; await wfs().createDirectory(uri); }
    }
  }
  // Uploads through Workshop's session and returns the new entity entry.
  async upload(name, bytes) {
    const uri = join(this.remoteRoot, name);
    const { parentFolder, fileName } = await this.vfs._resolveUri(uri);
    const original = this.vfs.api.uploadFile;
    let uploaded;
    this.vfs.api.uploadFile = async (identity, projectId, folderId, filename, content) => {
      uploaded = await sendFile({ apiUrl: this.vfs.api.url, server: uri.authority, identity, projectId, folderId, filename, bytes: content });
      return uploaded;
    };
    try { await this.vfs.createFile(uri, Buffer.from(bytes), true); } finally { this.vfs.api.uploadFile = original; }
    if (!uploaded) throw Error('上传未完成。');
    const id = uploaded.entity._id;
    // The server's own events remove the old entity; drop it here too so the tree has one entry per name.
    for (const key of ['docs', 'fileRefs']) {
      const list = parentFolder[key];
      if (list) for (let i = list.length - 1; i >= 0; i--) if (list[i].name === fileName && list[i]._id !== id) list.splice(i, 1);
    }
    const entry = this.remoteTree().get(name);
    if (!entry || entry.id !== id) throw Error('上传后在远端目录中找不到该文件。');
    return entry;
  }

  // ---- local ----
  async scanLocal() {
    const files = new Map();
    const walk = async (dir, prefix) => {
      for (const [n, type] of await wfs().readDirectory(dir)) {
        const name = prefix + n;
        if (!core.safePath(name) || (type & vscode.FileType.SymbolicLink)) continue;
        const uri = vscode.Uri.joinPath(dir, n);
        if (type & vscode.FileType.Directory) await walk(uri, name + '/');
        else if (core.isText(name) || core.isImage(name)) {
          const st = await wfs().stat(uri);
          files.set(name, { mtime: st.mtime, size: st.size });
        }
      }
    };
    await walk(this.root, '');
    return files;
  }
  async backup(name) {
    const data = await readOrNull(join(this.root, name));
    if (data === null) return;
    if (!this.backupDir) this.backupDir = BACKUP + '/' + new Date().toISOString().replace(/[:.]/g, '-');
    await wfs().writeFile(join(this.root, this.backupDir + '/' + name), data);
  }
  async pruneBackups() {
    try {
      const dirs = (await wfs().readDirectory(join(this.root, BACKUP))).map(x => x[0]).filter(x => /^\d{4}-\d\d-\d\dT/.test(x)).sort();
      for (const d of dirs.slice(0, Math.max(0, dirs.length - KEEP_BACKUPS))) await wfs().delete(join(this.root, BACKUP + '/' + d), { recursive: true });
    } catch (e) { if (!notFound(e)) throw e; }
  }
  isDirty(name) {
    const target = join(this.root, name).toString();
    return vscode.workspace.textDocuments.some(d => d.isDirty && d.uri.toString() === target);
  }
  // Writes local only if it still has the content the decision was based on.
  async writeLocal(name, data, expectedSha) {
    if (this.isDirty(name)) throw Error('编辑器里有未保存的改动，已跳过。');
    const now = await readOrNull(join(this.root, name));
    if ((now === null ? null : core.sha256(now)) !== expectedSha) throw Error('检查期间本地文件发生变化，请重试。');
    await this.backup(name);
    await wfs().writeFile(join(this.root, name), data);
  }
  baseUri(name) { return join(this.root, BASE + '/' + name); }
  async record(name, kind, id, remote, baseText) {
    const st = await wfs().stat(join(this.root, name));
    const data = await readOrNull(join(this.root, name));
    this.state.files[name] = { kind, id, remoteId: remote.id, mtime: st.mtime, size: st.size, localSha: core.sha256(data) };
    if (kind === 'doc') await wfs().writeFile(this.baseUri(name), Buffer.from(baseText));
    await this.saveState();
  }
  async forget(name) {
    delete this.state.files[name];
    try { await wfs().delete(this.baseUri(name)); } catch (e) { if (!notFound(e)) throw e; }
    await this.saveState();
  }

  // ---- inspect ----
  // Content ids: docs use sha256 of LF text, binaries use sha256 of bytes.
  async inspect(name, localInfo, remote) {
    const st = this.state.files[name];
    const kind = remote ? remote.type : st ? st.kind : core.isText(name) ? 'doc' : 'file';
    const item = { name, kind, remote, st, local: null, remoteId: null };
    if (localInfo) {
      if (kind === 'doc' || !st || st.kind !== kind || st.mtime !== localInfo.mtime || st.size !== localInfo.size) {
        const data = await readOrNull(join(this.root, name));
        if (data !== null) {
          item.localSha = core.sha256(data);
          if (kind === 'doc') { const raw = core.decodeUtf8(data); item.localText = core.normalize(raw); item.eol = core.eolOf(raw); item.local = core.sha256(item.localText); }
          else item.local = item.localSha;
        }
      } else { item.local = st.id === undefined ? null : st.localSha; item.localSha = st.localSha; }
    }
    if (remote) {
      if (kind === 'doc') { item.remoteText = await this.readDoc(remote); item.remoteId = core.sha256(item.remoteText); }
      else if (st && st.kind === kind && st.remoteId === remote.id) item.remoteId = st.id;
      else if (remote.hash && item.local !== null) {
        const data = await readOrNull(join(this.root, name));
        if (data !== null && core.gitBlobSha1(data) === remote.hash) item.remoteId = core.sha256(data);
      }
      if (item.remoteId === null) { item.remoteData = await this.download(name, remote); item.remoteId = core.sha256(item.remoteData); }
    }
    item.base = st && st.kind === kind ? st.id : undefined;
    item.action = core.decide(item.base, item.local, item.remoteId);
    return item;
  }

  // ---- apply ----
  async acceptSame(item) {
    const st = item.st;
    const cur = st && st.kind === item.kind && st.id === item.local && st.remoteId === item.remote.id && st.localSha === item.localSha;
    if (cur && item.kind === 'doc') return;
    if (cur) {
      // Only the timestamp moved. Remember it so the next pass can skip hashing.
      const now = await this.localInfo(item.name);
      if (st.mtime !== now.mtime || st.size !== now.size) { st.mtime = now.mtime; st.size = now.size; await this.saveState(); }
      return;
    }
    await this.record(item.name, item.kind, item.local, item.remote, item.localText);
  }
  async pull(item) {
    let data;
    if (item.kind === 'doc') data = Buffer.from(core.withEol(item.remoteText, item.eol || '\n'));
    else data = item.remoteData || await this.download(item.name, item.remote);
    await this.writeLocal(item.name, data, item.local === null ? null : item.localSha);
    await this.record(item.name, item.kind, item.remoteId, item.remote, item.remoteText);
  }
  // Writes `text` locally and moves the base to the remote content, so the local difference becomes a pending push.
  async rebase(item, text) {
    await this.writeLocal(item.name, Buffer.from(core.withEol(text, item.eol || '\n')), item.localSha);
    await this.record(item.name, 'doc', item.remoteId, item.remote, item.remoteText);
  }
  async pushDoc(item) {
    if (core.hasMarkers(item.localText)) throw Error('文件里还有未处理的冲突标记，请先处理再上传。');
    const uri = join(this.remoteRoot, item.name);
    const fresh = await this.readDoc(item.remote);
    if (core.sha256(fresh) !== item.remoteId) throw Error('检查期间远端发生变化，请重新同步。');
    await this.vfs.writeFile(uri, Buffer.from(item.localText), true, true);
    let seen;
    for (let i = 0; i < 6; i++) {
      await sleep(i ? 500 : 150);
      seen = await this.readDoc(item.remote);
      if (seen === item.localText) break;
    }
    if (seen !== item.localText) throw Error('上传后从服务器回读的内容不一致，请重新同步。');
    await this.record(item.name, 'doc', item.local, item.remote, item.localText);
  }
  async pushFile(item) {
    const uri = join(this.root, item.name);
    const data = await readOrNull(uri);
    if (data === null || core.sha256(data) !== item.localSha) throw Error('检查期间本地文件发生变化，请重试。');
    const tree = this.remoteTree().get(item.name);
    if ((tree ? tree.id : null) !== (item.remote ? item.remote.id : null)) throw Error('检查期间远端发生变化，请重新同步。');
    let bytes = data;
    if (item.kind === 'doc') {
      if (core.hasMarkers(item.localText)) throw Error('文件里还有未处理的冲突标记，请先处理再上传。');
      bytes = Buffer.from(item.localText);
    }
    await this.ensureParents(item.name);
    const entry = await this.upload(item.name, bytes);
    if (entry.type === 'doc') {
      const text = await this.readDoc(entry);
      if (text !== item.localText) throw Error('上传后回读内容不一致。');
      await this.record(item.name, 'doc', item.local, entry, text);
    } else {
      const got = await this.download(item.name, entry);
      if (!got.equals(bytes)) throw Error('上传后回读内容不一致。');
      // The server may store a text file it cannot edit as a binary file.
      await this.record(item.name, 'file', core.sha256(data), entry);
    }
  }
  async deleteRemote(item) {
    const uri = join(this.remoteRoot, item.name);
    if (await readOrNull(join(this.root, item.name)) !== null) throw Error('确认期间本地文件又出现了，已取消删除。');
    const tree = this.remoteTree().get(item.name);
    if (!tree || tree.id !== item.remote.id) throw Error('确认期间远端发生变化，已取消删除。');
    if (item.kind === 'doc' && core.sha256(await this.readDoc(item.remote)) !== item.remoteId) throw Error('确认期间远端发生变化，已取消删除。');
    await wfs().delete(uri, { recursive: false, useTrash: false });
    if (this.remoteTree().get(item.name)) throw Error('远端删除校验未通过。');
    await this.forget(item.name);
  }
  async deleteLocal(item) {
    if (this.isDirty(item.name)) throw Error('编辑器里有未保存的改动，已跳过。');
    const now = await readOrNull(join(this.root, item.name));
    if (now === null || core.sha256(now) !== item.localSha) throw Error('确认期间本地文件发生变化，已取消删除。');
    await this.backup(item.name);
    await wfs().delete(join(this.root, item.name), { useTrash: true });
    await this.forget(item.name);
  }

  async mergeDoc(item, interactive) {
    const baseData = await readOrNull(this.baseUri(item.name));
    if (baseData === null) return this.chooseWhole(item, interactive, '缺少共同基准');
    const merged = await core.merge3(baseData.toString('utf8'), item.localText, item.remoteText);
    if (merged.clean) { await this.rebase(item, merged.text); return 'merged'; }
    if (!interactive) return 'conflict';
    const n = merged.parts.filter(p => typeof p !== 'string').length;
    let text = '', k = 0, manual = false;
    const clip = s => (s.length > 400 ? s.slice(0, 400) + '…' : s) || '（删除）';
    for (const part of merged.parts) {
      if (typeof part === 'string') { text += part; continue; }
      k++;
      const choice = await vscode.window.showWarningMessage(`${item.name} 冲突 ${k}/${n}`,
        { modal: true, detail: `【本地】\n${clip(part.local)}\n\n【远端】\n${clip(part.remote)}\n\n其余不冲突的改动会自动合并。` },
        '采用本地', '采用远端', '手动编辑');
      if (choice === '采用本地') text += part.local;
      else if (choice === '采用远端') text += part.remote;
      else if (choice === '手动编辑') { text += core.markConflict(part); manual = true; }
      else return 'conflict';
    }
    await this.rebase(item, text);
    if (manual) { await vscode.window.showTextDocument(join(this.root, item.name)); return 'manual'; }
    return 'merged';
  }
  async chooseWhole(item, interactive, why) {
    if (!interactive) return 'conflict';
    const choice = await vscode.window.showWarningMessage(`${item.name}：本地与远端不同（${why}），需要选一份。`,
      { modal: true, detail: '选远端会先备份本地文件。取消则两边都不动。' }, '用本地覆盖远端', '用远端覆盖本地');
    if (choice === '用远端覆盖本地') { await this.pull(item); return 'pull'; }
    if (choice === '用本地覆盖远端') { await (item.kind === 'doc' ? this.pushDoc(item) : this.pushFile(item)); return 'push'; }
    return 'conflict';
  }

  // Runs one pass. mode: 'check' reads only; 'auto' pulls and clean-merges without asking; 'sync' does everything.
  async run(mode, progress) {
    const local = await this.scanLocal();
    const remote = this.remoteTree();
    const known = new Set(Object.keys(this.state.files));
    const scopedText = [...local.keys()].filter(n => core.textInScope(n, this.config));
    const texSources = [];
    for (const n of scopedText) if (/\.(tex|cls|sty)$/i.test(n)) { const d = await readOrNull(join(this.root, n)); if (d) texSources.push(d.toString('utf8')); }
    const images = [...local.keys()].filter(core.isImage);
    const refs = core.referencedImages(texSources, images);
    const names = new Set([...known, ...scopedText, ...refs]);
    const ignored = new Set(this.state.ignoredRemote || []);
    for (const n of [...remote.keys()]) {
      if (!core.safePath(n) || names.has(n) || ignored.has(n)) continue;
      if (core.isImage(n) || core.textInScope(n, this.config)) names.add(n);
    }
    const counts = {}, log = [];
    const add = (k, name, note) => { counts[k] = (counts[k] || 0) + 1; if (k !== 'same') log.push(`${k}: ${name}${note ? '（' + note + '）' : ''}`); };
    const list = [...names].filter(core.safePath).sort();
    // Inspect docs and images with limited parallelism.
    const items = [];
    let i = 0, done = 0;
    const worker = async () => {
      while (i < list.length) {
        const name = list[i++];
        try { items.push(await this.inspect(name, local.get(name), remote.get(name))); }
        catch (e) { add('error', name, e.message || String(e)); }
        if (progress) progress.report({ message: `检查 ${++done}/${list.length}` });
      }
    };
    await Promise.all(Array.from({ length: 4 }, worker));
    items.sort((a, b) => (a.name < b.name ? -1 : 1));
    const firstRun = known.size === 0;
    let bulk = null; // answer for remote-only files on the first run
    const remoteOnly = items.filter(x => x.action === 'pull-new');
    if (mode === 'sync' && firstRun && remoteOnly.length) {
      const c = await vscode.window.showWarningMessage(`远端有 ${remoteOnly.length} 个文件是本地没有的。`,
        { modal: true, detail: remoteOnly.slice(0, 20).map(x => x.name).join('\n') + (remoteOnly.length > 20 ? '\n…' : '') + '\n\n“忽略”会保留远端文件，以后也不再提示。' }, '全部下载到本地', '忽略这些文件');
      bulk = c === '全部下载到本地' ? 'pull' : c === '忽略这些文件' ? 'ignore' : 'skip';
    }
    for (const item of items) {
      const { name, action } = item;
      if (progress) progress.report({ message: name });
      try {
        if (mode === 'check') { add(action, name); continue; }
        const auto = mode === 'auto';
        if (auto && firstRun) { add('skipped', name); continue; }
        if (auto && this.isDirty(name)) { if (action !== 'same') add('dirty', name); continue; }
        // Remote changes to latexmkrc run as code locally, so only an explicit choice applies them.
        if (core.needsConsent(name) && ['pull', 'pull-new', 'both-changed', 'unbased'].includes(action)) { add(await this.chooseWhole(item, !auto, '该文件会在本地编译时执行'), name); continue; }
        switch (action) {
          case 'same': await this.acceptSame(item); add('same', name); break;
          case 'gone': if (known.has(name)) await this.forget(name); break;
          case 'pull': await this.pull(item); add('pull', name); break;
          case 'pull-new':
            if (bulk === 'ignore') { this.state.ignoredRemote = [...(this.state.ignoredRemote || []), name]; await this.saveState(); add('ignored', name); }
            else if (bulk === 'skip') add('skipped', name);
            else { await this.pull(item); add('pull', name); }
            break;
          case 'both-changed':
            add(item.kind === 'doc' ? await this.mergeDoc(item, !auto) : await this.chooseWhole(item, !auto, '两边都改了，且不能按行合并'), name); break;
          case 'unbased': add(await this.chooseWhole(item, !auto, '首次纳入管理，没有共同基准'), name); break;
          case 'push': if (auto) add('pending', name); else { await (item.kind === 'doc' ? this.pushDoc(item) : this.pushFile(item)); add('push', name); } break;
          case 'push-new': if (auto) add('pending', name); else { await this.pushFile(item); add('push', name); } break;
          default: add(await this.handleDelete(item, auto), name);
        }
        // A merge leaves local ahead of the new base. Upload it in the same manual run.
        if (mode === 'sync' && counts.merged && log[log.length - 1] === `merged: ${name}`) {
          const again = await this.inspect(name, await this.localInfo(name), this.remoteTree().get(name));
          if (again.action === 'push') { await this.pushDoc(again); add('push', name, '合并后上传'); }
        }
      } catch (e) { add('error', name, e.message || String(e)); }
    }
    if (mode !== 'check' && !(mode === 'auto' && firstRun)) { await this.saveState(); await this.pruneBackups(); }
    return { counts, log, total: list.length };
  }
  async localInfo(name) { const st = await wfs().stat(join(this.root, name)); return { mtime: st.mtime, size: st.size }; }
  async handleDelete(item, auto) {
    if (auto) return 'delete-pending';
    const { name, action } = item;
    if (action === 'local-deleted' || action === 'local-deleted-remote-changed') {
      const changed = action.endsWith('changed');
      const c = await vscode.window.showWarningMessage(`本地已删除 ${name}${changed ? '，但远端有新改动' : ''}。`, { modal: true, detail: '取消则保持现状，下次再问。' }, '恢复到本地', '同时删除远端');
      if (c === '恢复到本地') { await this.pull(item); return 'pull'; }
      if (c === '同时删除远端') { await this.deleteRemote(item); return 'deleted-remote'; }
    } else {
      const changed = action.endsWith('changed');
      const c = await vscode.window.showWarningMessage(`远端已删除 ${name}${changed ? '，但本地有新改动' : ''}。`, { modal: true, detail: '删除本地前会备份，并移入回收站。取消则保持现状，下次再问。' }, '重新上传', '同时删除本地');
      if (c === '重新上传') { await this.pushFile(item); return 'push'; }
      if (c === '同时删除本地') { await this.deleteLocal(item); return 'deleted-local'; }
    }
    return 'delete-pending';
  }
}
exports.Session = Session;

const LABELS = { same: '一致', pull: '拉取', push: '上传', merged: '自动合并', manual: '待手动处理冲突', conflict: '冲突未处理', pending: '本地待上传', dirty: '有未保存编辑', error: '错误', ignored: '已忽略', skipped: '跳过', 'delete-pending': '删除待确认', 'deleted-remote': '已删远端', 'deleted-local': '已删本地', 'pull-new': '远端新增', 'push-new': '本地新增', 'both-changed': '两边都改', unbased: '首次差异', 'local-deleted': '本地已删除', 'remote-deleted': '远端已删除', 'local-deleted-remote-changed': '本地已删/远端有改', 'remote-deleted-local-changed': '远端已删/本地有改' };
const summarize = r => `共 ${r.total} 个文件；` + Object.entries(r.counts).map(([k, v]) => `${LABELS[k] || k} ${v}`).join('；') + '。';

let busy = false;
// Runs a manual command. Resolves after the pass ends.
exports.runManual = async (root, dryRun, output) => {
  if (busy) return vscode.window.showInformationMessage('同步正在进行，请稍候。');
  busy = true;
  try {
    const s = new Session(root, output);
    await s.open();
    if (!dryRun) {
      if (vscode.workspace.textDocuments.some(d => d.isDirty && d.uri.scheme === 'file' && d.uri.path.startsWith(root.path + '/'))) throw Error('请先保存项目中尚未保存的编辑。');
      takeControl(s.vfs, root);
    }
    const started = Date.now();
    const r = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: dryRun ? 'Overleaf 只读检查' : 'Overleaf 双向同步' }, p => s.run(dryRun ? 'check' : 'sync', p));
    output.appendLine(`\n[${new Date().toLocaleString()}] ${dryRun ? '只读检查' : '双向同步'} ${s.meta.serverName} / ${s.meta.projectName}，用时 ${((Date.now() - started) / 1000).toFixed(1)} 秒`);
    r.log.forEach(l => output.appendLine(l));
    const text = summarize(r);
    output.appendLine(text);
    if (['error', 'conflict', 'manual', 'delete-pending'].some(k => r.counts[k])) { output.show(true); vscode.window.showWarningMessage(text); }
    else vscode.window.showInformationMessage(text);
    return r;
  } catch (e) { output.appendLine(e.stack || String(e)); output.show(true); vscode.window.showErrorMessage('Overleaf 同步: ' + e.message); }
  finally { busy = false; }
};

// Pulls remote edits while VS Code is open. Never uploads and never deletes.
exports.startAuto = async (root, output, context) => {
  const s = new Session(root, output);
  await s.open();
  if (s.config.autoPull === false) return;
  let timer, queued = false, stopped = false, notified = '';
  const pass = async () => {
    if (stopped) return;
    if (busy) { queued = true; return schedule(5000); }
    busy = true;
    try {
      await s.vfs.init();
      s.state = (await readJson(join(root, STATE))) || s.state;
      s.backupDir = undefined;
      if (Object.keys(s.state.files).length === 0) return; // the first run must be manual
      takeControl(s.vfs, root);
      const r = await s.run('auto');
      const moved = (r.counts.pull || 0) + (r.counts.merged || 0);
      const trouble = ['conflict', 'delete-pending', 'error', 'dirty'].filter(k => r.counts[k]).map(k => `${LABELS[k]} ${r.counts[k]}`).join('；');
      if (moved || trouble !== notified) { r.log.filter(l => !l.startsWith('pending')).forEach(l => output.appendLine('[自动] ' + l)); }
      if (moved) vscode.window.setStatusBarMessage(`Overleaf：已拉取 ${moved} 个文件的远端改动`, 8000);
      if (trouble && trouble !== notified) vscode.window.showInformationMessage('Overleaf 自动拉取：' + trouble + '。运行“Overleaf: 同步”处理。');
      notified = trouble;
    } catch (e) { output.appendLine('[自动] ' + (e.stack || e)); }
    finally { busy = false; if (queued) { queued = false; schedule(1000); } }
  };
  const schedule = ms => { clearTimeout(timer); timer = setTimeout(pass, ms); };
  const bump = () => schedule(4000);
  // updateEventHandlers survives reconnects because Workshop re-registers its handler list.
  s.vfs.socket.updateEventHandlers({ onFileChanged: () => bump(), onFileCreated: () => bump(), onFileRemoved: () => bump(), onFileRenamed: () => bump(), onFileMoved: () => bump(), onConnectionAccepted: () => schedule(8000) });
  const interval = setInterval(() => schedule(0), Math.max(60, s.config.pollSeconds || 600) * 1000);
  context.subscriptions.push({ dispose() { stopped = true; clearInterval(interval); clearTimeout(timer); } });
  schedule(3000);
};
