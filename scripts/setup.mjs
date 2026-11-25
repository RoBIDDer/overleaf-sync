#!/usr/bin/env node
// Creates .overleaf/{settings,bisync}.json and .gitignore in a local LaTeX folder. Never overwrites and never asks for credentials.
// Usage: node setup.mjs --folder <path> --url <https://server/project/ID> [--name <label>] [--text-dirs ",chapters,reference"]
import fs from 'node:fs';
import path from 'node:path';
const arg = n => { const i = process.argv.indexOf('--' + n); return i < 0 ? undefined : process.argv[i + 1]; };
const fail = m => { console.error(m); process.exit(1); };
const folder = arg('folder'), raw = arg('url');
if (!folder || !raw) fail('用法: node setup.mjs --folder <LaTeX 文件夹> --url <Overleaf 项目网址> [--name <名称>] [--text-dirs ",chapters"]');
if (!fs.existsSync(folder) || !fs.statSync(folder).isDirectory()) fail('文件夹不存在: ' + folder);
let u; try { u = new URL(raw); } catch { fail('网址无效: ' + raw); }
const id = (/^\/project\/([0-9a-f]{24})\/?$/.exec(u.pathname) || [])[1];
if (!['http:', 'https:'].includes(u.protocol) || !id) fail('需要形如 https://服务器/project/24位ID 的网址。');
const name = (arg('name') || 'Paper').replace(/[/?#\\]/g, ' ').trim() || 'Paper';
const dir = path.join(folder, '.overleaf');
if (fs.existsSync(path.join(dir, 'settings.json')) || fs.existsSync(path.join(dir, 'bisync.json'))) fail('已存在 .overleaf 配置，未做任何修改: ' + dir);
fs.mkdirSync(dir, { recursive: true });
const put = (f, s) => fs.writeFileSync(path.join(dir, f), s, { flag: 'wx' });
const config = { autoPull: true, pollSeconds: 600 };
if (arg('text-dirs') !== undefined) config.textDirs = arg('text-dirs').split(',').map(s => s.trim());
put('settings.json', JSON.stringify({ uri: `overleaf-workshop://${u.host}/${encodeURIComponent(name)}?user=&project=${id}`, serverName: u.host, enableCompileNPreview: false, projectName: name }, null, 2) + '\n');
put('bisync.json', JSON.stringify(config, null, 2) + '\n');
if (!fs.existsSync(path.join(dir, '.gitignore'))) put('.gitignore', '*\n');
console.log('已创建: ' + dir);
