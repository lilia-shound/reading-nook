'use strict';
/**
 * check_gh_live.js —— 对着**真 GitHub 仓库**跑一遍浏览器端适配器
 *
 * check_ghapi.js 用的是内存假仓库；这个用真的：
 *   真的 public/gh-api.js + 真的 public/vault.js + 真的 fetch + 真的 token + 真的仓库。
 *   跑的是浏览器里跑的那条代码路径，只是把窗口换成了 Node。
 *
 * 验的：
 *   1. 密码对 → 解开书架；密码错 → 被挡住
 *   2. 书架、章节正文、批注、资料库 —— 形状和内容都对
 *   3. **目录修复**：`/api/books/:id` 要带 chapters（不带的话目录一直是空的）
 *   4. **划线能真的写回仓库**（PUT contents）→ 验完删掉，不留痕
 *   5. 一轮轮询只用 1 个请求（不能每 20 秒扫 24 个章）
 *   6. 没 token 时写操作给中文提示
 *
 *   $env:GH_TOKEN='ghp_xxx'
 *   node test\check_gh_live.js
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const GH_API_SRC = fs.readFileSync(path.join(ROOT, 'public', 'gh-api.js'), 'utf8');
const VAULT_SRC = fs.readFileSync(path.join(ROOT, 'public', 'vault.js'), 'utf8');
const SITE = JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'site.json'), 'utf8'));
const BASE = 'https://' + SITE.owner + '.github.io/' + SITE.repo + '/';

const TOKEN = (process.env.GH_TOKEN || '').trim();
const PASSCODE = (process.env.NOOK_PASSCODE || '').trim() || readLocalPasscode();

function readLocalPasscode() {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'config.json'), 'utf8'));
    return String(cfg.passcode || '');
  } catch (e) { return ''; }
}

let passed = 0, failed = 0;
function ok(name, cond, extra) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')); }
}
function eq(name, actual, expect) {
  const a = JSON.stringify(actual), b = JSON.stringify(expect);
  ok(name, a === b, a === b ? '' : '实际 ' + a + ' ≠ 期望 ' + b);
}

// ---------------------------------------------------------- 真浏览器环境

let requestCount = 0;
const requestLog = [];

function liveFetch(url, init) {
  let u = String(url);
  if (!/^https?:/i.test(u)) u = new URL(u, BASE).toString();
  requestCount++;
  requestLog.push(u);
  return retry(() => fetch(u, init)).catch((e) => {
    const cause = (e && e.cause) ? (e.cause.code || e.cause.message || String(e.cause)) : '';
    const err = new Error('拿不到 ' + u + '：' + ((e && e.message) || '未知') + (cause ? '（' + cause + '）' : ''));
    err.url = u;
    throw err;
  });
}

/** 网络层偶尔抽风（fetch failed），重试几次 */
function retry(fn, times) {
  const n = times || 3;
  return fn().catch((e) => {
    if (n <= 1) throw e;
    return new Promise((r) => setTimeout(r, 800)).then(() => retry(fn, n - 1));
  });
}

function makeEnv() {
  const store = new Map();
  const ctx = {
    console,
    TextEncoder,
    TextDecoder,
    crypto: crypto.webcrypto,
    btoa: (s) => Buffer.from(String(s), 'binary').toString('base64'),
    atob: (s) => Buffer.from(String(s), 'base64').toString('binary'),
    fetch: liveFetch,
    localStorage: {
      getItem(k) { return store.has(k) ? store.get(k) : null; },
      setItem(k, v) { store.set(k, String(v)); },
      removeItem(k) { store.delete(k); }
    },
    setTimeout, clearTimeout, setInterval, clearInterval,
    URL, URLSearchParams, Date, Math, JSON, Promise
  };
  ctx.window = ctx;
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(VAULT_SRC, ctx, { filename: 'vault.js' });
  vm.runInContext(GH_API_SRC, ctx, { filename: 'gh-api.js' });
  return { ctx, store, api: ctx.GhApi };
}

// ---------------------------------------------------------- 直接打仓库

function gh(method, apiPath, body) {
  const headers = {
    'Accept': 'application/vnd.github+json',
    'Authorization': 'Bearer ' + TOKEN,
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'reading-nook-live-check'
  };
  let payload = null;
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  return fetch('https://api.github.com' + apiPath, { method, headers, body: payload })
    .then(async (res) => {
      const text = await res.text();
      let data = null;
      try { data = text ? JSON.parse(text) : null; } catch (e) { data = text; }
      if (!res.ok) {
        const e = new Error(res.status + ' ' + ((data && data.message) || text.slice(0, 200)));
        e.status = res.status;
        throw e;
      }
      return data;
    });
}

// ------------------------------------------------------------------ 主流程

(async function main() {
  console.log('共读小屋 · 对着真仓库跑一遍');
  console.log('仓库:', SITE.owner + '/' + SITE.repo + '@' + SITE.branch);
  console.log('token:', TOKEN ? '有' : '没有（写操作会失败）');
  console.log('');

  const env = makeEnv();
  const api = env.api;

  console.log('=== 登录 ===');
  const h = await api.handle('/api/health');
  ok('health 通', h && h.ok === true);
  ok('health 带密码提示语', !!(h && h.login_hint), JSON.stringify(h && h.login_hint));

  // 错密码要被挡住
  let wrongMsg = '';
  try {
    await api.login('00000000');
  } catch (e) { wrongMsg = String((e && e.message) || ''); }
  ok('错密码进不去屋', /密码/.test(wrongMsg), 'message=' + wrongMsg);

  const login = await api.login(PASSCODE);
  ok('对密码进得去', login && login.ok === true);
  eq('进屋后知道我是谁', login.user_name, '姜来');
  eq('进屋后知道他是谁', login.ai_name, '姜去');

  console.log('');
  console.log('=== 书架 ===');
  const lib = await api.handle('/api/library');
  ok('书架有书', lib.books.length >= 2, 'n=' + lib.books.length);
  const gudao = lib.books.find((b) => b.title === '古道');
  ok('《古道》在书架上', !!gudao);
  eq('《古道》24 章', gudao.chapterCount, 24);
  eq('《古道》19 份剧情笔记', gudao.noteCount, 19);
  ok('书名是解出来的（不是密文）', gudao.title === '古道');

  console.log('');
  console.log('=== 目录修复（chapters 必须带回来） ===');
  const full = await api.handle('/api/books/' + encodeURIComponent(gudao.id));
  ok('完整书对象拿到了', !!(full && full.book));
  ok('带 chapters 数组', Array.isArray(full.book.chapters) && full.book.chapters.length === 24,
    'chapters=' + ((full.book.chapters || []).length));
  ok('章节标题有内容', !!(full.book.chapters[4] && full.book.chapters[4].title),
    JSON.stringify(full.book.chapters[4] && full.book.chapters[4].title));

  console.log('');
  console.log('=== 读正文 ===');
  const ch5 = await api.handle('/api/books/' + encodeURIComponent(gudao.id) + '/chapter/5');
  ok('第 5 章拿到了', !!ch5);
  ok('有段落', Array.isArray(ch5.paragraphs) && ch5.paragraphs.length > 5, 'n=' + (ch5.paragraphs || []).length);
  ok('是中文正文', /[\u4e00-\u9fa5]/.test(ch5.paragraphs.join('')));
  eq('总章数对', ch5.totalChapters, 24);

  console.log('');
  console.log('=== 姜去回过的话（蓝色气泡的数据） ===');
  const annos = await api.handle('/api/books/' + encodeURIComponent(gudao.id) + '/annotations/5');
  eq('第 5 章 3 条批注', (annos.annotations || []).length, 3);
  ok('每条都有姜去的回应', (annos.annotations || []).every((a) => a.replies && a.replies.length),
    JSON.stringify((annos.annotations || []).map((a) => (a.replies || []).length)));
  ok('回应是 ai 说的', (annos.annotations || []).some((a) => a.replies && a.replies.some((r) => r.who === 'ai')));
  const mountain = (annos.annotations || []).find((a) => (a.anchor || '').indexOf('山鹑') >= 0);
  ok('「山鹑」那条在', !!mountain, JSON.stringify((annos.annotations || []).map((a) => a.anchor)));

  console.log('');
  console.log('=== 待回队列 ===');
  const pending = await api.handle('/api/pending');
  ok('待回是数组', Array.isArray(pending.items));
  ok('她划的都已经被回过了（队列空）', pending.items.length === 0, 'n=' + pending.items.length);

  console.log('');
  console.log('=== 资料库 ===');
  const docs = await api.handle('/api/docs');
  ok('资料库有《古道》脉络', (docs.docs || []).some((d) => d.id === 'gudao-outline'),
    JSON.stringify((docs.docs || []).map((d) => d.id)));
  const doc = await api.handle('/api/docs/gudao-outline');
  ok('脉络能读到正文', !!(doc && doc.body && doc.body.length > 1000), 'chars=' + ((doc && doc.body) || '').length);

  console.log('');
  console.log('=== ping：一轮轮询只用 1 个请求 ===');
  const before = requestCount;
  const p1 = await api.handle('/api/ping');
  const used1 = requestCount - before;
  ok('ping 有时间戳', !!(p1 && p1.ts), JSON.stringify(p1));
  ok('ping 只花 1 个请求', used1 === 1, 'used=' + used1);
  const before2 = requestCount;
  const p2 = await api.handle('/api/ping');
  const used2 = requestCount - before2;
  eq('两次 ping 时间戳一样（没变化就不重算）', p2.ts, p1.ts);
  ok('第二次 ping 还是 1 个请求', used2 === 1, 'used=' + used2);

  console.log('');
  console.log('=== 没 token 时写不了 ===');
  api.setToken('');
  let noTokMsg = '';
  try {
    await api.handle('/api/books/' + encodeURIComponent(gudao.id) + '/annotations/99',
      { method: 'POST', json: { anchor: '测试', note: '测试' } });
  } catch (e) { noTokMsg = String((e && e.message) || ''); }
  ok('没 token 写不了', /token/i.test(noTokMsg), 'message=' + noTokMsg);

  console.log('');
  console.log('=== 划线真写回仓库 ===');
  api.setToken(TOKEN);
  const SCRATCH = 99;   // 用一个不存在的章号，建完就删，不碰她的数据
  const wrote = await api.handle('/api/books/' + encodeURIComponent(gudao.id) + '/annotations/' + SCRATCH,
    { method: 'POST', json: { anchor: '这一句我要记一辈子。', note: '端到端自检', paraIndex: 3 } });
  ok('写成功了', !!(wrote && wrote.annotation), JSON.stringify(wrote));
  ok('批注 id 是 a_ 开头的', !!(wrote.annotation && /^a_/.test(wrote.annotation.id)), wrote.annotation && wrote.annotation.id);
  eq('标记成她写的', wrote.annotation.who, 'user');
  ok('划的原文一字不差', wrote.annotation.anchor === '这一句我要记一辈子。');

  // 仓库里那个文件是真的密文
  const rawFile = await fetch('https://raw.githubusercontent.com/' + SITE.owner + '/' + SITE.repo + '/' + SITE.branch +
    '/data/books/' + gudao.id + '/annotations/' + SCRATCH + '.json.enc?t=' + Date.now())
    .then((r) => r.text());
  ok('仓库里那个文件是密文', /"alg"\s*:\s*"AES-GCM"/.test(rawFile) && /"ct"\s*:/.test(rawFile));
  ok('仓库里看不到明文', rawFile.indexOf('这一句我要记一辈子') < 0);
  ok('仓库里看不到她的批注', rawFile.indexOf('端到端自检') < 0);

  // 换个环境读回来（= 另一台设备）
  const env2 = makeEnv();
  await env2.api.login(PASSCODE);
  const back = await env2.api.handle('/api/books/' + encodeURIComponent(gudao.id) + '/annotations/' + SCRATCH);
  eq('另一台设备能读回来', (back.annotations || []).length, 1);
  eq('内容一字不差', back.annotations[0].note, '端到端自检');

  // 删掉，不留痕
  const delPath = '/repos/' + SITE.owner + '/' + SITE.repo + '/contents/data/books/' + gudao.id +
    '/annotations/' + SCRATCH + '.json.enc';
  const meta = await gh('GET', delPath);
  await gh('DELETE', delPath, { message: '清理：端到端自检留下的临时批注', sha: meta.sha, branch: SITE.branch });
  // 用 contents 接口确认（raw 走 CDN，删了之后还会缓存一会儿，别拿它当准）
  let gone = 0;
  try {
    await gh('GET', delPath);
    gone = 200;
  } catch (e) { gone = e.status || 0; }
  ok('自检的临时文件已删掉', gone === 404, 'status=' + gone);

  console.log('');
  console.log('=== 她的原数据没被动过 ===');
  const still = await api.handle('/api/books/' + encodeURIComponent(gudao.id) + '/annotations/5');
  eq('第 5 章还是 3 条', (still.annotations || []).length, 3);

  console.log('');
  console.log(failed ? 'ALL FAIL' : 'ALL PASS');
  console.log(passed + ' checks');
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error('出错:', e && e.message);
  if (e && e.stack) console.error(e.stack.split('\n').slice(1, 4).join('\n'));
  if (e && e.cause) console.error('原因:', e.cause.code || e.cause.message);
  process.exit(1);
});
