'use strict';
/**
 * setup-local.js —— 把这台电脑切到「仓库当数据源」模式
 *
 * 做三件事：
 *   1. 建 data/.local.json（**本地专用，永远不推仓库**）
 *        backend  = github   ← 数据落到 GitHub 仓库，不再是本地 data/
 *        passcode = 密码（用来派生加密密钥）
 *        ghToken  = GitHub token（写仓库用）
 *        secrets  = 仓库里不放的密钥（DeepSeek key 等）
 *   2. 把 data/config.json 里的密钥搬进 secrets（仓库那份是去掉的版本）
 *   3. 打印怎么切回去
 *
 *   $env:GH_TOKEN='ghp_xxx'
 *   node tools\setup-local.js
 *
 * 想切回本地磁盘：把 data/.local.json 里的 backend 改成 fs，或者删掉这个文件。
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DATA = path.join(ROOT, 'data');
const LOCAL = path.join(DATA, '.local.json');
const CONFIG = path.join(DATA, 'config.json');

const token = (process.env.GH_TOKEN || '').trim();
if (!token) {
  console.error('缺少 GH_TOKEN 环境变量 —— 没有它就写不了仓库。');
  process.exit(2);
}

let cfg = {};
try {
  cfg = JSON.parse(fs.readFileSync(CONFIG, 'utf8').replace(/^\uFEFF/, ''));
} catch (e) {
  console.error('读不到 data/config.json：' + e.message);
  process.exit(2);
}

const local = {
  backend: 'github',
  passcode: String(cfg.passcode || ''),
  ghToken: token,
  secrets: {
    passcode: cfg.passcode || '',
    deepseek_api_key: cfg.deepseek_api_key || '',
    ai_api_key: cfg.ai_api_key || ''
  }
};

fs.writeFileSync(LOCAL, JSON.stringify(local, null, 2) + '\n', 'utf8');
// 这个文件不进仓库，但顺手挡一下手滑
const gitignore = path.join(ROOT, '.gitignore');
let gi = '';
try { gi = fs.readFileSync(gitignore, 'utf8'); } catch (e) { /* ignore */ }
if (gi.indexOf('data/.local.json') < 0) {
  fs.writeFileSync(gitignore, (gi ? gi.replace(/\s*$/, '\n') : '') + 'data/.local.json\n', 'utf8');
}

console.log('已写 data/.local.json');
console.log('  后端     : github（数据在 GitHub 仓库里，仓库里是密文）');
console.log('  密码     : ' + (local.passcode ? '有（' + local.passcode.length + ' 位）' : '没有'));
console.log('  token    : 有（' + token.slice(0, 4) + '…）');
console.log('  搬走的密钥: ' + Object.keys(local.secrets).filter((k) => local.secrets[k]).join('、'));
console.log('');
console.log('下一步：重启服务（node server.js），它就会用仓库当数据源。');
console.log('想切回本地磁盘：把 data/.local.json 里的 backend 改成 fs，或删掉这个文件。');
