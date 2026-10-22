'use strict';
/**
 * check_tunnel_fallback.js —— 验「写不进去 → 改走家里电脑代写」这条路
 *
 * 背景：姜来在 5G 上划线报「读仓库失败（0）」——
 *       raw 通（能读正文）但 api.github.com 不通（写之前要拿 sha，必须走 API）。
 *       写仓库**必须**经过一台能连上 api.github.com 的机器 = 她自己的电脑。
 *
 * 这个测试用**一个本地 mock 当「家里电脑」**（比真隧道可控，也不会受 DNS 影响）：
 *   1. 仓库里得有隧道地址（data/tunnel.json.enc，加密的）
 *   2. 模拟「GitHub 所有写都失败」→ 静态版自动改走「家里电脑」
 *   3. 那个 mock 真的收到了请求，载荷也对
 *
 *   $env:GH_TOKEN='ghp_xxx'
 *   node test/check_tunnel_fallback.js
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const http = require('http');
const crypto = require('crypto');
const Vault = require('../public/vault.js');

const ROOT = path.resolve(__dirname, '..');
const GH_API_SRC = fs.readFileSync(path.join(ROOT, 'public', 'gh-api.js'), 'utf8');
const VAULT_SRC = fs.readFileSync(path.join(ROOT, 'public', 'vault.js'), 'utf8');
const SITE = JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'site.json'), 'utf8'));
const TOKEN = (process.env.GH_TOKEN || '').trim();
const PASSCODE = (process.env.NOOK_PASSCODE || '').trim() || '06090823';

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')); }
}

// ------------------------------------------------------- mock「家里电脑」

function startMockPC() {
  const got = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      got.push({ method: req.method, url: req.url, cookie: req.headers.cookie || '', body: body });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ annotation: { id: 'a_mock123', who: 'user' } }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server: server, got: got, port: server.address().port });
    });
  });
}

// ------------------------------------------------------------- 假 GitHub

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

  async function fetchFake(url, init) {
    const method = String((init && init.method) || 'GET').toUpperCase();
    const u = new URL(String(url), 'https://x.test/');
    const p = decodeURIComponent(u.pathname.replace(/^\/repos\/[^/]+\/[^/]+\/contents\//, '')).replace(/^\//, '');
    calls.push(method + ' ' + u.href);

    // 不是 GitHub 的请求（= 走「家里电脑」那条路）→ 放行
    if (u.hostname.indexOf('github.com') < 0 && u.hostname.indexOf('githubusercontent.com') < 0) {
      return fetch(url, init);
    }
    if (p === 'site.json') return res(200, JSON.stringify(SITE), 'application/json');

    if (method === 'GET') {
      const f = files.get(p);
      if (!f) return res(404, JSON.stringify({ message: 'Not Found' }), 'application/json');
      const accept = String((init && init.headers && (init.headers.Accept || init.headers.accept)) || '');
      if (accept.indexOf('vnd.github.raw') >= 0) return res(200, f.content, 'text/plain');
      return res(200, JSON.stringify({
        type: 'file', name: p.split('/').pop(), path: p, sha: f.sha, size: f.content.length,
        content: Buffer.from(f.content, 'utf8').toString('base64'), encoding: 'base64'
      }), 'application/json');
    }

    if (method === 'PUT') {
      if (opts.allWritesFail) return res(0, '', 'text/plain');   // 网络层失败
      const body = JSON.parse(String((init && init.body) || '{}'));
      const cur = files.get(p);
      if (cur && !body.sha) return res(422, JSON.stringify({ message: 'Invalid request.\n\n"sha" wasn\'t supplied.' }), 'application/json');
      const sha = 'sha' + (files.size + 1);
      files.set(p, { sha: sha, content: Buffer.from(body.content || '', 'base64').toString('utf8') });
      return res(cur ? 200 : 201, JSON.stringify({ content: { sha: sha, path: p } }), 'application/json');
    }
    return res(404, JSON.stringify({ message: 'Not Found' }), 'application/json');
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
  // 真实站点有 site-inline.js（内联配置，启动不用发请求）→ 这里照做
  ctx.NOOK_SITE = SITE;
  vm.createContext(ctx);
  vm.runInContext(VAULT_SRC, ctx, { filename: 'vault.js' });
  vm.runInContext(GH_API_SRC, ctx, { filename: 'gh-api.js' });
  return { api: ctx.GhApi, files: files, calls: calls };
}

(async function main() {
  console.log('=== 写不进去时的第三条路（改走家里电脑）===');
  console.log('');

  const pc = await startMockPC();
  const pcUrl = 'http://127.0.0.1:' + pc.port;
  console.log('  mock「家里电脑」在 ' + pcUrl);
  console.log('');

  console.log('【1】仓库里得有隧道地址（加密的）');
  {
    const env = makeEnv();
    const key = await Vault.deriveKey(PASSCODE, SITE.kdf.salt, SITE.kdf.iter);
    const enc = JSON.stringify({ v: 1, alg: 'AES-GCM', iv: 'x', ct: 'x' });
    // 用真的加密写一份
    const real = await Vault.encryptText(key, JSON.stringify({ url: pcUrl, ts: Date.now() }));
    const o = JSON.parse(real);
    o.mtime = Date.now();
    env.files.set('data/tunnel.json.enc', { sha: 'sha-t', content: JSON.stringify(o) });
    ok('仓库里有 data/tunnel.json.enc', env.files.has('data/tunnel.json.enc'));
    const t = JSON.parse(await Vault.decryptText(key, env.files.get('data/tunnel.json.enc').content));
    ok('能解开（是密文）', !!(t && t.url), t && t.url);
    ok('里面是地址', t.url === pcUrl, t.url);
  }

  console.log('');
  console.log('【2】GitHub 写不通 → 自动改走「家里电脑」');
  {
    const env = makeEnv({ allWritesFail: true });
    const key = await Vault.deriveKey(PASSCODE, SITE.kdf.salt, SITE.kdf.iter);
    const real = await Vault.encryptText(key, JSON.stringify({ url: pcUrl, ts: Date.now() }));
    const o = JSON.parse(real);
    o.mtime = Date.now();
    env.files.set('data/tunnel.json.enc', { sha: 'sha-t', content: JSON.stringify(o) });

    // 书架也得有（登录要解开它才认密码）
    const libEnc = JSON.parse(await Vault.encryptJson(key, [{
      id: 'b_mock', title: '测试书', chapterCount: 1,
      chapters: [{ index: 1, title: '第1章', startLine: 0, endLine: 1, charCount: 10 }], notes: {}
    }]));
    libEnc.mtime = Date.now();
    env.files.set('data/library.json.enc', { sha: 'sha-lib', content: JSON.stringify(libEnc) });

    env.api.setToken(TOKEN);
    await env.api.login(PASSCODE);

    let r = null;
    let err = null;
    try {
      r = await env.api.handle('/api/books/b_mock/annotations/1', {
        method: 'POST', json: { anchor: '兜底路的自检', note: '走家里电脑代写', paraIndex: 0 }
      });
    } catch (e) { err = e; }
    ok('写成功了（走的是家里电脑）', !!(r && r.annotation), err ? ('错误：' + err.message) : '');
    ok('确实请求过「家里电脑」', env.calls.some((c) => c.indexOf('127.0.0.1:' + pc.port) >= 0),
      env.calls.filter((c) => c.indexOf('127.0.0.1') >= 0).join(' | '));

    console.log('');
    console.log('【3】它收到的请求对不对');
    ok('收到了 1 个请求', pc.got.length === 1, 'n=' + pc.got.length);
    if (pc.got.length) {
      const g = pc.got[0];
      ok('是 POST', g.method === 'POST', g.method);
      ok('路径对（/api/books/:id/annotations/:ch）', /\/api\/books\/[^/]+\/annotations\/\d+$/.test(g.url), g.url);
      ok('带上了 cookie（= 密码）', g.cookie.indexOf('rk=') === 0, g.cookie);
      let payload = null;
      try { payload = JSON.parse(g.body); } catch (e) { /* ignore */ }
      ok('载荷是划线内容', !!(payload && payload.anchor === '兜底路的自检'), g.body.slice(0, 80));
    }
  }

  pc.server.close();
  console.log('');
  console.log(fail ? 'ALL FAIL' : 'ALL PASS');
  console.log(pass + ' checks');
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('出错:', e && e.message, e && e.stack ? e.stack.split('\n')[1] : '');
  process.exit(1);
});
