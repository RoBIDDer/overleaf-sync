'use strict';
// Pure logic for two-way sync. No vscode dependency, so it can be tested with plain node.
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

exports.sha256 = data => crypto.createHash('sha256').update(data).digest('hex');
exports.gitBlobSha1 = data => crypto.createHash('sha1').update(`blob ${data.length}\0`).update(data).digest('hex');

// Overleaf stores documents as LF. Compare and merge on this normal form only.
exports.normalize = text => text.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
exports.decodeUtf8 = bytes => {
  try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { throw Error('文件不是有效的 UTF-8 文本，已跳过。'); }
};
exports.eolOf = text => {
  const crlf = (text.match(/\r\n/g) || []).length;
  const lf = (text.match(/\n/g) || []).length;
  return crlf * 2 > lf ? '\r\n' : '\n';
};
exports.withEol = (text, eol) => (eol === '\r\n' ? text.replace(/\n/g, '\r\n') : text);

const IMAGE_EXT = new Set(['pdf', 'png', 'jpg', 'jpeg', 'eps']);
const TEXT_EXT = new Set(['tex', 'bib', 'cls', 'sty', 'bst']);
const ext = name => (/\.([^./]+)$/.exec(name) || [, ''])[1].toLowerCase();
exports.isImage = name => IMAGE_EXT.has(ext(name));
exports.isText = name => TEXT_EXT.has(ext(name)) || name === 'latexmkrc';
// latexmkrc is Perl that the local build runs, so remote edits to it are never applied without asking.
exports.needsConsent = name => name === 'latexmkrc';

// Guards every path before it is read or written locally. Rejects hidden folders and unsafe names.
exports.safePath = name => {
  const parts = name.split('/');
  return parts.every(p => p && p !== '.' && p !== '..' && !p.startsWith('.') && p !== '__pycache__' && p !== 'node_modules'
    && !/[<>:"|?*\\\x00-\x1f]/.test(p) && !/[. ]$/.test(p) && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i.test(p));
};
exports.textInScope = (name, config) => {
  if (!exports.isText(name)) return false;
  if (!config.textDirs) return true; // all folders by default; list them in bisync.json to narrow the scope
  const top = name.includes('/') ? name.split('/')[0] : '';
  return config.textDirs.includes(top);
};

const stripComments = tex => tex.split('\n').map(line => line.replace(/(^|[^\\])((?:\\\\)*)%.*$/, '$1$2')).join('\n');
// Images whose path, with or without extension, appears in a non-comment part of the given tex sources.
exports.referencedImages = (texts, images) => {
  const tex = texts.map(t => stripComments(exports.normalize(t))).join('\n');
  const prefixes = [''];
  for (const m of tex.matchAll(/\\graphicspath\s*\{((?:\s*\{[^}]*\})+)\s*\}/g))
    for (const d of m[1].matchAll(/\{([^}]*)\}/g)) prefixes.push(d[1].trim().replace(/^\.\//, '').replace(/\/?$/, '/'));
  const mentioned = new Set();
  for (const m of tex.matchAll(/\{([^{}]+)\}/g)) mentioned.add(m[1].trim().replace(/\\/g, '/').replace(/^\.\//, ''));
  const out = new Set();
  for (const image of images) {
    const stem = image.replace(/\.[^./]+$/, '');
    for (const p of prefixes) {
      if (!image.startsWith(p)) continue;
      if (mentioned.has(image.slice(p.length)) || mentioned.has(stem.slice(p.length))) { out.add(image); break; }
    }
  }
  return out;
};

// base/local/remote are content ids or null when absent. base is undefined when never synced.
exports.decide = (base, local, remote) => {
  if (local === null && remote === null) return 'gone';
  if (base === undefined || base === null) {
    if (local === null) return 'pull-new';
    if (remote === null) return 'push-new';
    return local === remote ? 'same' : 'unbased';
  }
  if (local === null) return remote === base ? 'local-deleted' : 'local-deleted-remote-changed';
  if (remote === null) return local === base ? 'remote-deleted' : 'remote-deleted-local-changed';
  if (local === remote) return 'same';
  if (local === base) return 'pull';
  if (remote === base) return 'push';
  return 'both-changed';
};

const MARK = 37;
const LABEL_LOCAL = '本地', LABEL_REMOTE = '远端';
// Returns { clean: true, text } or { clean: false, parts } where parts are strings or {local, remote}.
exports.merge3 = async (base, local, remote) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ol-merge-'));
  try {
    const f = n => path.join(dir, n);
    fs.writeFileSync(f('local'), local); fs.writeFileSync(f('base'), base); fs.writeFileSync(f('remote'), remote);
    const { code, stdout } = await new Promise((resolve, reject) => execFile('git',
      ['merge-file', '-p', '--marker-size=' + MARK, '-L', LABEL_LOCAL, '-L', 'base', '-L', LABEL_REMOTE, f('local'), f('base'), f('remote')],
      { cwd: dir, maxBuffer: 1 << 27, timeout: 30000, windowsHide: true, encoding: 'utf8' },
      (error, out) => {
        if (error && typeof error.code !== 'number') reject(Error('无法运行 git merge-file：' + (error.code || error.message)));
        else resolve({ code: error ? error.code : 0, stdout: out });
      }));
    if (code === 0) return { clean: true, text: stdout };
    if (code < 0 || code > 127) throw Error('git merge-file 失败（代码 ' + code + '）。');
    const open = '<'.repeat(MARK) + ' ' + LABEL_LOCAL, mid = '='.repeat(MARK), close = '>'.repeat(MARK) + ' ' + LABEL_REMOTE;
    const parts = []; let plain = [], cur = null;
    const lines = stdout.match(/[^\n]*\n|[^\n]+$/g) || [];
    for (const line of lines) {
      const bare = line.replace(/\n$/, '');
      if (!cur && bare === open) { parts.push(plain.join('')); plain = []; cur = { local: '', remote: '', side: 'local' }; }
      else if (cur && cur.side === 'local' && bare === mid) cur.side = 'remote';
      else if (cur && cur.side === 'remote' && bare === close) { parts.push({ local: cur.local, remote: cur.remote }); cur = null; }
      else if (cur) cur[cur.side] += line;
      else plain.push(line);
    }
    if (cur) throw Error('无法解析合并结果。');
    parts.push(plain.join(''));
    return { clean: false, parts };
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
};
const endNl = s => (s && !s.endsWith('\n') ? s + '\n' : s);
exports.markConflict = c => `<<<<<<< ${LABEL_LOCAL}\n${endNl(c.local)}=======\n${endNl(c.remote)}>>>>>>> ${LABEL_REMOTE}\n`;
exports.hasMarkers = text => /^<<<<<<< 本地$/m.test(text) || /^>>>>>>> 远端$/m.test(text);
