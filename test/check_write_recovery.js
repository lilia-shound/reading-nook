'use strict';
/**
 * check_write_recovery.js —— 验写路径的三道保险
 *
 * 背景：2026-10-22 下午，姜来在公网上划线，报
 *   「没存上：写不进去：Invalid request. "sha" wasn't supplied.」
 *
 * GitHub 的规矩：新建文件**不能**带 sha，更新文件**必须**带 sha。
 * 那个错的意思是「文件其实存在，但你没给我 sha」。
 * 我们读（readMeta）那一刻恰好抖了一下返回了 404 → 以为文件不存在 → 写的时候没带 sha。
 *
 * 这里用假服务器把这几种坏情况都演一遍，验每一道保险都能兜住：
 *   1. 新建 → 更新（正常）
 *   2. 第一次读 404 但文件其实在（她的那次）→ 422 要被兜住
 *   3. 写的时候撞 409（有人同时改）→ 重试要成功
 *
 *   node test\check_write_recovery.js
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');
const Vault = require('../public/vault.js');

const ROOT = path.resolve(__dirname, '..');
const GH_API_SRC = fs.readFileSync(path.join(ROOT, 'public', 'gh-api.js'), 'utf8');
const VAULT_SRC = fs.readFileSync(path.join(ROOT, 'public', 'vault.js'), 'utf8');

const SITE = {
  mode: 'static',
  owner: 'lilia-shound',
  repo: 'reading-nook',
  branch: 'main',
  kdf: { algo: 'PBKDF2-SHA256', iter: 1000, salt: 'AAAAAAAAAAAAAAAAAAAAAA==' },
  names: { user: '姜来', ai: '姜去' },
  subtitle: '姜来 & 姜去',
  login_hint: '两个人的生日相加'
};
const PASS = 'test-pass-8888';
const BOOK = 'b_test1';
const LIB = 'data/library.json.enc';
const REL = 'data/books/' + BOOK + '/annotations/1.json.enc';

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')); }
}

// ----------------------------------------------------------------- 假服务器

function makeEnv(opts) {
  opts = opts || {};
  const files = new Map();
  const calls = [];

  function res(status, body, type) {
    const text = body == null ? '' : String(body);
    return {
      status,
      ok: status >= 200 && status < 300,
      headers: { get: () => (type || '') },
      text: () => Promise.resolve(text),
      json: () => Promise.resolve(text ? JSON.parse(text) : null)
    };
  }

  function fetchFake(url, init) {
    const method = String((init && init.method) || 'GET').toUpperCase();
    const u = new URL(String(url), 'https://x.test/');
    const p = decodeURIComponent(u.pathname.replace(/^\/repos\/[^/]+\/[^/]+\/contents\//, '')).replace(/^\//, '');
    calls.push(method + ' ' + p);

    if (method === 'GET') {
      if (p === 'site.json') return Promise.resolve(res(200, JSON.stringify(SITE), 'application/json'));
      const f = files.get(p);
      // **第一次读这个路径时假装 404**（哪怕文件真的在）—— 这就是姜来踩的那次
      if (opts.failPathOnce === p && !opts.failedOnce) {
        opts.failedOnce = true;
        return Promise.resolve(res(404, JSON.stringify({ message: 'Not Found' }), 'application/json'));
      }
      if (!f) return Promise.resolve(res(404, JSON.stringify({ message: 'Not Found' }), 'application/json'));
      // GitHub 认 Accept: application/vnd.github.raw → 直接返回文件原文（不是 JSON 包装）
      const accept = String((init && init.headers && (init.headers.Accept || init.headers.accept)) || '');
      if (accept.indexOf('vnd.github.raw') >= 0) {
        return Promise.resolve(res(200, f.content, 'text/plain'));
      }
      return Promise.resolve(res(200, JSON.stringify({
        type: 'file', name: p.split('/').pop(), path: p, sha: f.sha, size: f.content.length,
        content: Buffer.from(f.content, 'utf8').toString('base64'), encoding: 'base64'
      }), 'application/json'));
    }

    if (method === 'PUT') {
      const body = JSON.parse(String((init && init.body) || '{}'));
      const cur = files.get(p);
      if (opts.conflictOnce && !opts.conflictDone) {
        opts.conflictDone = true;
        return Promise.resolve(res(409, JSON.stringify({ message: 'Conflict' }), 'application/json'));
      }
      if (cur && !body.sha) {
        // GitHub 的原话
        return Promise.resolve(res(422, JSON.stringify({
          message: 'Invalid request.\n\n"sha" wasn\'t supplied.'
        }), 'application/json'));
      }
      if (cur && body.sha && body.sha !== cur.sha) {
        return Promise.resolve(res(409, JSON.stringify({ message: 'Conflict' }), 'application/json'));
      }
      const sha = 'sha' + (files.size + 1);
      files.set(p, { sha: sha, content: Buffer.from(body.content || '', 'base64').toString('utf8') });
      return Promise.resolve(res(cur ? 200 : 201, JSON.stringify({ content: { sha: sha, path: p } }), 'application/json'));
    }
    return Promise.resolve(res(404, JSON.stringify({ message: 'Not Found' }), 'application/json'));
  }

  const store = new Map();
  const ctx = {
    console, TextEncoder, TextDecoder,
    crypto: crypto.webcrypto,
    btoa: (s) => Buffer.from(String(s), 'binary').toString('base64'),
    atob: (s) => Buffer.from(String(s), 'base64').toString('binary'),
    fetch: fetchFake,
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => { store.set(k, String(v)); },
      removeItem: (k) => { store.delete(k); }
    },
    setTimeout, clearTimeout, setInterval, clearInterval, URL, URLSearchParams
  };
  ctx.window = ctx;
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(VAULT_SRC, ctx, { filename: 'vault.js' });
  vm.runInContext(GH_API_SRC, ctx, { filename: 'gh-api.js' });
  return { api: ctx.GhApi, files: files, calls: calls, opts: opts };
}

/** 登录要先能解开书架文件（那是「密码对不对」的判据）→ 先造一份 */
async function seedLibrary(env) {
  const key = await Vault.deriveKey(PASS, SITE.kdf.salt, SITE.kdf.iter);
  const lib = [{
    id: BOOK,
    title: '测试书',
    chapterCount: 2,
    chapters: [
      { index: 1, title: '第1章', startLine: 0, endLine: 1, charCount: 10 },
      { index: 2, title: '第2章', startLine: 2, endLine: 3, charCount: 10 }
    ],
    notes: {}
  }];
  const o = JSON.parse(await Vault.encryptJson(key, lib));
  o.mtime = Date.now();
  env.files.set(LIB, { sha: 'sha-lib', content: JSON.stringify(o) });
}

async function login(env) {
  env.api.setToken('fake-token');
  await seedLibrary(env);
  await env.api.login(PASS);
}

// ------------------------------------------------------------------ 主流程

(async function main() {
  console.log('=== 写路径的三道保险 ===');
  console.log('');

  console.log('【1】正常路径：新建 → 更新');
  {
    const env = makeEnv();
    await login(env);
    const a = await env.api.handle('/api/books/' + BOOK + '/annotations/1', {
      method: 'POST', json: { anchor: '一', note: '一', paraIndex: 0 }
    });
    ok('第一次写成功（新建）', !!(a && a.annotation), JSON.stringify(a));
    const b = await env.api.handle('/api/books/' + BOOK + '/annotations/1', {
      method: 'POST', json: { anchor: '二', note: '二', paraIndex: 1 }
    });
    ok('第二次写成功（更新）', !!(b && b.annotation));
    const got = await env.api.handle('/api/books/' + BOOK + '/annotations/1');
    ok('两条都在', (got.annotations || []).length === 2, 'n=' + (got.annotations || []).length);
  }

  console.log('');
  console.log('【2】读岔了：第一次 GET 返回 404，但文件其实在（姜来踩的那次）');
  {
    const env = makeEnv();
    await login(env);
    await env.api.handle('/api/books/' + BOOK + '/annotations/1', {
      method: 'POST', json: { anchor: '一', note: '一', paraIndex: 0 }
    });
    ok('文件已经存在了', env.files.has(REL));

    // 造一个「第一次读这个文件会 404」的假环境
    const env2 = makeEnv({ failPathOnce: REL, failedOnce: false });
    await login(env2);
    env2.files.set(REL, env.files.get(REL));   // 搬过去（含正确的 sha）

    let err = null;
    let r = null;
    try {
      r = await env2.api.handle('/api/books/' + BOOK + '/annotations/1', {
        method: 'POST', json: { anchor: '二', note: '二', paraIndex: 1 }
      });
    } catch (e) { err = e; }
    ok('读岔了也能写成功（422 被兜住了）', !!(r && r.annotation), err ? ('错误：' + err.message) : '');
    ok('确实发生过 404（模拟成立）', env2.opts.failedOnce === true);
    const got = await env2.api.handle('/api/books/' + BOOK + '/annotations/1');
    ok('两条都在（没丢原来那条）', (got.annotations || []).length === 2, 'n=' + (got.annotations || []).length);
  }

  console.log('');
  console.log('【3】写的时候撞 409（有人同时改）→ 要重试并成功');
  {
    const env = makeEnv({ conflictOnce: true, conflictDone: false });
    await login(env);
    const a = await env.api.handle('/api/books/' + BOOK + '/annotations/1', {
      method: 'POST', json: { anchor: '一', note: '一', paraIndex: 0 }
    });
    ok('撞了 409 之后仍然写成功了', !!(a && a.annotation), JSON.stringify(a));
    const got = await env.api.handle('/api/books/' + BOOK + '/annotations/1');
    ok('内容在', (got.annotations || []).length === 1, 'n=' + (got.annotations || []).length);
  }

  console.log('');
  console.log(fail ? 'ALL FAIL' : 'ALL PASS');
  console.log(pass + ' checks');
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('出错:', e && e.message, e && e.stack ? e.stack.split('\n')[1] : '');
  process.exit(1);
});
