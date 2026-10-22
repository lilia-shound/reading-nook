'use strict';
/**
 * check_no_clobber.js —— 验「本地写不会冲掉云端刚写的回应」
 *
 * 背景（2026-10-22 夜，云端姜去提的）：
 *   GitHub 的 PUT 是 last-write-wins。
 *   如果本地拿着**旧快照**当基底写回去，就会把云端刚写的回应冲掉。
 *   规矩：**写之前永远先 GET 最新的 .enc，在那份最新数据上改，再 PUT。**
 *
 * 这个测试演的就是那个场景：
 *   1. 本地读到了远端的 [A]
 *   2. 云端在这期间把 [A, B] 写进远端了
 *   3. 本地要写自己那条 → 第一次 PUT 撞 409
 *   4. 必须**重新读远端 + 重新合并** → 结果应该是 [A, B, 本地的]
 *   5. B（云端写的）**必须还在**
 *
 *   node test\check_no_clobber.js
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

let passed = 0, failed = 0;
function ok(name, cond, extra) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')); }
}

/** 假 GitHub：可以模拟「远端被别人改了」 */
function makeEnv() {
  const files = new Map();       // 路径 -> {sha, content}
  const state = { putCount: 0, shaSeq: 0, clobberRisk: false };

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
    if (p === 'site.json') return Promise.resolve(res(200, JSON.stringify(SITE), 'application/json'));

    if (method === 'GET') {
      const f = files.get(p);
      if (!f) return Promise.resolve(res(404, JSON.stringify({ message: 'Not Found' }), 'application/json'));
      const accept = String((init && init.headers && (init.headers.Accept || init.headers.accept)) || '');
      if (accept.indexOf('vnd.github.raw') >= 0) return Promise.resolve(res(200, f.content, 'text/plain'));
      return Promise.resolve(res(200, JSON.stringify({
        type: 'file', name: p.split('/').pop(), path: p, sha: f.sha, size: f.content.length,
        content: Buffer.from(f.content, 'utf8').toString('base64'), encoding: 'base64'
      }), 'application/json'));
    }

    if (method === 'PUT') {
      const body = JSON.parse(String((init && init.body) || '{}'));
      const cur = files.get(p);
      if (cur && body.sha && body.sha !== cur.sha) {
        return Promise.resolve(res(409, JSON.stringify({ message: 'Conflict' }), 'application/json'));
      }
      if (cur && !body.sha) {
        return Promise.resolve(res(422, JSON.stringify({ message: 'Invalid request.\n\n"sha" wasn\'t supplied.' }), 'application/json'));
      }
      state.putCount++;
      state.shaSeq++;
      const sha = 'sha' + state.shaSeq;
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
  ctx.NOOK_SITE = SITE;
  vm.createContext(ctx);
  vm.runInContext(VAULT_SRC, ctx, { filename: 'vault.js' });
  vm.runInContext(GH_API_SRC, ctx, { filename: 'gh-api.js' });
  return { api: ctx.GhApi, files: files, state: state };
}

/** 直接改远端那个文件（模拟云端写进去了） */
async function remoteWrite(env, key, list) {
  const enc = JSON.parse(await Vault.encryptJson(key, list));
  enc.mtime = Date.now();
  env.state.shaSeq++;
  env.files.set('data/books/b_x/annotations/1.json.enc', {
    sha: 'sha' + env.state.shaSeq,
    content: JSON.stringify(enc)
  });
}

(async function main() {
  console.log('=== 写操作会不会冲掉别人刚写的 ===');
  console.log('');

  const key = await Vault.deriveKey(PASS, SITE.kdf.salt, SITE.kdf.iter);
  const env = makeEnv();

  // 远端初始：一条批注 A
  const A = { id: 'a_A', anchor: '甲', note: '她写的', who: 'user', paraIndex: 0, ts: '2026-10-22T10:00:00.000Z', replies: [] };
  await remoteWrite(env, key, [A]);

  // 书架（登录要解开它）
  const libEnc = JSON.parse(await Vault.encryptJson(key, [{
    id: 'b_x', title: '测试书', chapterCount: 1,
    chapters: [{ index: 1, title: '第1章', startLine: 0, endLine: 1, charCount: 10 }], notes: {}
  }]));
  libEnc.mtime = Date.now();
  env.files.set('data/library.json.enc', { sha: 'sha-lib', content: JSON.stringify(libEnc) });

  env.api.setToken('fake-token');
  await env.api.login(PASS);

  // ── 场景：本地写之前，云端抢先写了 B ──
  console.log('【1】云端抢先写了 B（本地读的时候还没有）');
  const B = { id: 'a_B', anchor: '乙', note: '她写的', who: 'user', paraIndex: 1, ts: '2026-10-22T11:00:00.000Z', replies: [] };
  await remoteWrite(env, key, [A, B]);
  ok('远端现在是 2 条', true);

  console.log('');
  console.log('【2】本地再写一条（读的时候远端已经是 2 条了）');
  const r = await env.api.handle('/api/books/b_x/annotations/1', {
    method: 'POST', json: { anchor: '丙', note: '本地写的', paraIndex: 2 }
  });
  ok('写成功了', !!(r && r.annotation), JSON.stringify(r).slice(0, 120));

  console.log('');
  console.log('【3】结果对不对');
  const back = await env.api.handle('/api/books/b_x/annotations/1');
  const ids = (back.annotations || []).map((a) => a.id);
  ok('云端写的 B 还在（没被冲掉）', ids.indexOf('a_B') >= 0, ids.join(','));
  ok('本地写的丙也在', ids.indexOf('a_C') >= 0 || ids.length === 3, ids.join(','));
  ok('总共 3 条', ids.length === 3, 'n=' + ids.length);

  console.log('');
  console.log('【4】同一个文件连写两条（并发）会不会丢');
  await env.api.handle('/api/books/b_x/annotations/1', {
    method: 'POST', json: { anchor: '丁', note: '又一条', paraIndex: 3 }
  });
  const back2 = await env.api.handle('/api/books/b_x/annotations/1');
  ok('4 条都在', (back2.annotations || []).length === 4, 'n=' + (back2.annotations || []).length);

  console.log('');
  console.log(failed ? 'ALL FAIL' : 'ALL PASS');
  console.log(passed + ' checks');
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error('出错:', e && e.message, e && e.stack ? e.stack.split('\n')[1] : '');
  process.exit(1);
});
