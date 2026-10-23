'use strict';
/**
 * push-repo.js —— 把共读小屋推上 GitHub 仓库（不用 git）
 *
 * 两件事，分开推：
 *   --data   把本地 data/ **加密**后推上去（仓库里只有密文）
 *   --site   把 public/ + .github/ + 文档推上去（明文，静态站点要读）
 *   --all    两个都推
 *
 * 一次推送 = **一个 commit**（走 Git Trees API，不是逐文件 PUT）。
 * 逐文件 PUT 的话迁移 30 多个文件就是 30 多个 commit，仓库历史会被撑爆。
 *
 * token 从环境变量 GH_TOKEN 读，**永远不落盘**。
 *
 *   $env:GH_TOKEN='ghp_xxx'
 *   node tools/push-repo.js --all
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const Vault = require('../public/vault.js');

const ROOT = path.resolve(__dirname, '..');
const TOKEN = (process.env.GH_TOKEN || '').trim();
if (!TOKEN) {
  console.error('缺少 GH_TOKEN 环境变量');
  process.exit(2);
}

const site = JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'site.json'), 'utf8'));
const REPO = site.owner + '/' + site.repo;
const BRANCH = site.branch;

// --------------------------------------------------------------- API

function req(method, apiPath, body) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body), 'utf8');
    const headers = {
      'Accept': 'application/vnd.github+json',
      'Authorization': 'Bearer ' + TOKEN,
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'reading-nook-push',
      'Content-Type': 'application/json'
    };
    if (payload) headers['Content-Length'] = payload.length;
    const u = new URL('https://api.github.com' + apiPath);
    const r = https.request(
      { method, hostname: u.hostname, path: u.pathname + u.search, headers },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          let data = null;
          try { data = raw ? JSON.parse(raw) : null; } catch (e) { data = raw; }
          if (res.statusCode >= 200 && res.statusCode < 300) resolve(data);
          else {
            const e = new Error(res.statusCode + ' ' + ((data && data.message) || raw.slice(0, 300)));
            e.status = res.statusCode;
            e.data = data;
            reject(e);
          }
        });
      }
    );
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}

// ------------------------------------------------------------- 收集文件

function walk(dir, base, out) {
  out = out || [];
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    return out;
  }
  for (const ent of entries) {
    const full = path.join(dir, ent.name);
    const rel = base ? base + '/' + ent.name : ent.name;
    if (ent.isDirectory()) walk(full, rel, out);
    else if (ent.isFile()) out.push({ full, rel });
  }
  return out;
}

// --------------------------------------------------------------- 密码

function getPasscode() {
  if (process.env.NOOK_PASSCODE) return process.env.NOOK_PASSCODE;
  try {
    const local = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', '.local.json'), 'utf8'));
    if (local.passcode) return local.passcode;
  } catch (e) { /* ignore */ }
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'config.json'), 'utf8'));
    if (cfg.passcode) return cfg.passcode;
  } catch (e) { /* ignore */ }
  return null;
}

// 仓库里绝对不能出现的字段
const SECRET_KEYS = ['passcode', 'deepseek_api_key', 'ai_api_key'];

// ---------------------------------------------------------- 组装 tree

/**
 * 收集要推的文件，做成 Git tree 条目。
 * kind: 'plain' 原样推 | 'enc' 加密后推
 */
async function collectData() {
  const passcode = getPasscode();
  if (!passcode) throw new Error('找不到密码：设 NOOK_PASSCODE 环境变量，或在 data/.local.json 里写 passcode');
  const key = await Vault.deriveKey(passcode, site.kdf.salt, site.kdf.iter);

  const SKIP_TOP = ['.local.json', 'tunnel.json'];
  // .mirror 是**本地镜像**（读缓存，里面是密文）—— 绝对不能推上去
  const SKIP_DIRS = ['logs', '.mirror'];

  const files = walk(path.join(ROOT, 'data'), '', []);
  const entries = [];
  for (const f of files) {
    const top = f.rel.split('/')[0];
    if (SKIP_DIRS.includes(top)) continue;
    if (SKIP_TOP.includes(f.rel)) continue;

    let text = fs.readFileSync(f.full, 'utf8');
    // config.json 里的密钥要摘掉 —— 仓库是公开的
    if (f.rel === 'config.json') {
      try {
        const cfg = JSON.parse(text);
        for (const k of SECRET_KEYS) delete cfg[k];
        text = JSON.stringify(cfg, null, 2);
      } catch (e) { /* ignore */ }
    }

    const blob = JSON.parse(await Vault.encryptText(key, text));
    blob.mtime = Date.now();
    // 仓库路径 = data/ + 逻辑路径，最后一段加 .enc
    const segs = f.rel.split('/');
    segs[segs.length - 1] = segs[segs.length - 1] + '.enc';
    entries.push({ path: 'data/' + segs.join('/'), content: JSON.stringify(blob) });
  }
  return entries;
}

async function collectSite() {
  const entries = [];
  const push = (rel, full) => {
    entries.push({ path: rel, content: fs.readFileSync(full, 'utf8') });
  };

  for (const f of walk(path.join(ROOT, 'public'), '', [])) {
    push('public/' + f.rel, f.full);
  }
  if (fs.existsSync(path.join(ROOT, '.github'))) {
    for (const f of walk(path.join(ROOT, '.github'), '', [])) {
      push('.github/' + f.rel, f.full);
    }
  }
  for (const name of ['README.md', '部署到公网.md', '静态版说明.md']) {
    const full = path.join(ROOT, name);
    if (fs.existsSync(full)) push(name, full);
  }
  const refDir = path.join(ROOT, '_reference');
  if (fs.existsSync(refDir)) {
    for (const f of walk(refDir, '', [])) {
      if (!/\.(md|txt)$/i.test(f.rel)) continue;
      push('_reference/' + f.rel, f.full);
    }
  }
  // 云端姜去要用的工具
  for (const name of ['tools/gh-store.js', 'tools/gh-admin.js', 'tools/push-repo.js', 'tools/gen-site.js',
    'tools/setup-local.js']) {
    const full = path.join(ROOT, name);
    if (fs.existsSync(full)) push(name, full);
  }
  // lib/vault-node.js 必须一起推 —— ghbackend.js 要 require 它，
  // 少推一个，云端姜去那台的 gh-store.js 就直接崩。
  for (const name of ['lib/ghbackend.js', 'lib/vfs.js', 'lib/store.js', 'lib/docs.js', 'lib/vault-node.js',
    'server.js', 'nook.js', 'package.json']) {
    const full = path.join(ROOT, name);
    if (fs.existsSync(full)) push(name, full);
  }
  // 自检脚本（cloud 那边也能自己跑）
  const testDir = path.join(ROOT, 'test');
  if (fs.existsSync(testDir)) {
    for (const f of walk(testDir, '', [])) {
      if (!/^(check_[a-z_]+|e2e)\.js$/i.test(f.rel)) continue;
      push('test/' + f.rel, f.full);
    }
  }
  return entries;
}

// -------------------------------------------------------------- 推

async function pushTree(entries, message) {
  if (!entries.length) {
    console.log('没有要推的文件。');
    return null;
  }
  console.log('准备推 ' + entries.length + ' 个文件…');

  // 1) 每个文件建一个 blob
  const tree = [];
  for (const e of entries) {
    const blob = await req('POST', '/repos/' + REPO + '/git/blobs', {
      content: Buffer.from(e.content, 'utf8').toString('base64'),
      encoding: 'base64'
    });
    tree.push({ path: e.path, mode: '100644', type: 'blob', sha: blob.sha });
  }

  // 2) 拿到当前 HEAD 和它的 tree
  const ref = await req('GET', '/repos/' + REPO + '/git/ref/heads/' + BRANCH);
  const headSha = ref.object.sha;
  const head = await req('GET', '/repos/' + REPO + '/git/commits/' + headSha);
  const baseTree = head.tree.sha;

  // 3) 建新 tree
  const newTree = await req('POST', '/repos/' + REPO + '/git/trees', {
    base_tree: baseTree,
    tree: tree
  });

  // 4) 提交
  const commit = await req('POST', '/repos/' + REPO + '/git/commits', {
    message: message,
    tree: newTree.sha,
    parents: [headSha]
  });

  // 5) 推分支
  await req('PATCH', '/repos/' + REPO + '/git/refs/heads/' + BRANCH, {
    sha: commit.sha,
    force: false
  });

  console.log('已提交: ' + commit.sha.slice(0, 10) + '  ' + message);
  console.log('  ' + entries.slice(0, 6).map((e) => e.path).join('\n  '));
  if (entries.length > 6) console.log('  …… 还有 ' + (entries.length - 6) + ' 个');
  return commit.sha;
}

async function main() {
  const args = process.argv.slice(2);
  const wantData = args.includes('--data') || args.includes('--all');
  const wantSite = args.includes('--site') || args.includes('--all');
  if (!wantData && !wantSite) {
    console.log('用法: node tools/push-repo.js --data | --site | --all');
    return;
  }
  console.log('仓库: ' + REPO + '@' + BRANCH);
  console.log('');

  if (wantSite) {
    console.log('== 静态站点 ==');
    await pushTree(await collectSite(), '部署：静态站点');
  }
  if (wantData) {
    console.log('');
    console.log('== 数据（加密后） ==');
    await pushTree(await collectData(), '同步：共读小屋数据（密文）');
  }
  console.log('');
  console.log('完事。Pages 地址：https://' + site.owner + '.github.io/' + site.repo + '/');
}

main().catch((e) => {
  console.error('失败:', e.message);
  if (e.data) console.error(JSON.stringify(e.data).slice(0, 600));
  process.exit(1);
});
