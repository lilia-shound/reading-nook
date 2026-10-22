'use strict';
/**
 * check_ghapi.js —— 浏览器端 GitHub 存储适配器自检
 *
 * 做法：把 public/gh-api.js 读进来，在一个假的环境里跑
 *       （假 window / localStorage / fetch / btoa），背后挂一个内存版的 GitHub
 *       （路径 → {sha, content}），连加密都用真的 public/vault.js。
 *
 * 验这些：
 *   1. 密码不对 → 抛错；密码对 → 拿到 books
 *   2. /api/library 的 books 形状跟 server.js 一致
 *   3. 章节切段跟 server.js 的 splitParagraphs 逐字相同
 *   4. 写一条批注 → 仓库里多出正确的密文 → 换个环境还能读回来
 *   5. 409 冲突能重试成功（不写重、不丢数据）
 *   6. /api/ping 在 commit sha 不变时只发 1 个请求
 *   7. 没 token 时写操作抛出「还没连上 GitHub」
 *
 *   node test\check_ghapi.js
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const GH_API_SRC = fs.readFileSync(path.join(ROOT, 'public', 'gh-api.js'), 'utf8');
const VAULT_SRC = fs.readFileSync(path.join(ROOT, 'public', 'vault.js'), 'utf8');
const serverSplit = require(path.join(ROOT, 'server.js')).splitParagraphs;

// ----------------------------------------------------------------- 假配置

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

// 测试专用的假密码 —— 真密码不写进仓库（仓库里只该有密文）
const PASSCODE = 'test-pass-8888';
const BOOK_ID = 'b_test0000000001';

// ----------------------------------------------------------------- 假数据

const LONG_LINE = '这是一个很长的句子，用来触发切段规则。'.repeat(30);

const TEXT_LINES = [
  '第1章  铁轨上的清晨',
  '雾从江面上浮起来，站台灯还亮着。',
  '这是第一段。',
  '',
  LONG_LINE,
  '结尾有空格   ',
  '结尾有全角空格　',
  '连续标点。。后面还有字。',
  '第2章  停靠港的第七夜',
  '海风把纸吹得哗哗响。'
];
const TEXT = TEXT_LINES.join('\n');

const BOOK = {
  id: BOOK_ID,
  title: '测试书·铁轨',
  filename: '测试书.txt',
  addedAt: '2026-10-22T02:00:00.000Z',
  encoding: 'utf-8',
  encodingConfidence: 0.99,
  chapterCount: 2,
  pattern: 'cn-chapter',
  hitCount: 2,
  chapters: [
    { index: 1, title: '第1章  铁轨上的清晨', startLine: 0, endLine: 7, charCount: LONG_LINE.length + 60 },
    { index: 2, title: '第2章  停靠港的第七夜', startLine: 8, endLine: 9, charCount: 12 }
  ],
  notes: {
    '1': { title: '第1章  铁轨上的清晨', chars: 12, ts: '2026-10-22T02:10:00.000Z' }
  }
};

const ANNOS_1 = [
  {
    id: 'a_seed1',
    anchor: '雾从江面',
    note: '开局',
    who: 'user',
    paraIndex: 0,
    ts: '2026-10-22T02:20:00.000Z',
    replies: [{ who: 'ai', text: '早', ts: '2026-10-22T02:21:00.000Z' }]
  }
];

const ANNOS_2 = [
  {
    id: 'a_seed2',
    anchor: '海风',
    note: '等回复',
    who: 'user',
    paraIndex: 0,
    ts: '2026-10-22T02:22:00.000Z',
    replies: []
  }
];

const PROGRESS = { chapter: 1, paraIndex: 0, ratio: 0.25, updatedAt: '2026-10-22T02:15:00.000Z' };

const NOTE_MD = '# 第1章  铁轨上的清晨\n\n开篇的剧情笔记：雾、站台灯、江面。\n';

const DOC_MD = [
  '---',
  'title: 古道全书脉络',
  'summary: 一句话说清全书',
  'tags: [古道, 脉络]',
  '---',
  '',
  '## 开头',
  '',
  '正文第一段。',
  ''
].join('\n');

// ----------------------------------------------------------------- 假 GitHub

function createRepo() {
  const files = new Map();          // 仓库相对路径 -> {sha, content}
  const repo = {
    files,
    requests: [],                   // 每发一个请求记一笔（用来数「一轮轮询几个请求」）
    conflictNextPut: false,         // 让下一次 PUT 返回 409
    putCount: 0,                    // 写成功了几次
    putAttempts: 0,                 // 试了几次（撞墙的也算）
    commitSeq: 0,
    commitSha: 'c0',
    commitDate: '2026-10-22T00:00:00.000Z'
  };

  function nextSha() {
    repo.commitSeq += 1;
    return 'blob' + repo.commitSeq;
  }

  function bumpCommit() {
    repo.commitSeq += 1;
    repo.commitSha = 'c' + repo.commitSeq;
    repo.commitDate = new Date(Date.parse('2026-10-22T00:00:00.000Z') + repo.commitSeq * 60000).toISOString();
  }

  repo.write = function (rel, content) {
    files.set(rel, { sha: nextSha(), content: String(content) });
    bumpCommit();
  };

  repo.isDir = function (rel) {
    const prefix = rel.endsWith('/') ? rel : rel + '/';
    for (const k of files.keys()) if (k.startsWith(prefix)) return true;
    return false;
  };

  repo.list = function (rel) {
    const prefix = rel.endsWith('/') ? rel : rel + '/';
    const out = new Map();
    for (const [k, v] of files) {
      if (!k.startsWith(prefix)) continue;
      const rest = k.slice(prefix.length);
      const slash = rest.indexOf('/');
      if (slash < 0) out.set(rest, { name: rest, type: 'file', size: v.content.length, sha: v.sha });
      else {
        const name = rest.slice(0, slash);
        if (!out.has(name)) out.set(name, { name, type: 'dir', size: 0, sha: null });
      }
    }
    return Array.from(out.values());
  };

  function res(status, body, contentType) {
    const text = body == null ? '' : String(body);
    return {
      status,
      ok: status >= 200 && status < 300,
      headers: {
        get(n) {
          return String(n).toLowerCase() === 'content-type' ? (contentType || '') : null;
        }
      },
      text() { return Promise.resolve(text); },
      json() { return Promise.resolve(text ? JSON.parse(text) : null); }
    };
  }

  function contentsGet(rel, headers) {
    if (repo.isDir(rel)) return res(200, JSON.stringify(repo.list(rel)), 'application/json');
    const f = files.get(rel);
    if (!f) return res(404, JSON.stringify({ message: 'Not Found' }), 'application/json');
    const accept = String(headers['Accept'] || headers['accept'] || '');
    if (accept.indexOf('vnd.github.raw') >= 0) return res(200, f.content, 'text/plain');
    return res(200, JSON.stringify({
      type: 'file',
      name: rel.split('/').pop(),
      path: rel,
      sha: f.sha,
      size: f.content.length,
      content: Buffer.from(f.content, 'utf8').toString('base64'),
      encoding: 'base64'
    }), 'application/json');
  }

  function contentsPut(rel, init) {
    let body = {};
    try { body = JSON.parse(String((init && init.body) || '{}')); }
    catch (e) { return res(400, JSON.stringify({ message: 'bad json' }), 'application/json'); }

    repo.putAttempts += 1;
    if (repo.conflictNextPut) {
      repo.conflictNextPut = false;
      return res(409, JSON.stringify({ message: 'Conflict' }), 'application/json');
    }
    const cur = files.get(rel);
    if (cur && body.sha && body.sha !== cur.sha) {
      return res(409, JSON.stringify({ message: 'Conflict' }), 'application/json');
    }
    if (cur && !body.sha) {
      return res(422, JSON.stringify({ message: 'sha is required' }), 'application/json');
    }
    const content = Buffer.from(String(body.content || ''), 'base64').toString('utf8');
    const sha = nextSha();
    files.set(rel, { sha, content });
    repo.putCount += 1;
    bumpCommit();
    return res(cur ? 200 : 201, JSON.stringify({ content: { path: rel, sha } }), 'application/json');
  }

  function contentsDelete(rel) {
    if (repo.isDir(rel) || !files.has(rel)) {
      return res(404, JSON.stringify({ message: 'Not Found' }), 'application/json');
    }
    files.delete(rel);
    return res(204, '', 'application/json');
  }

  repo.fetch = function (url, init) {
    const method = String((init && init.method) || 'GET').toUpperCase();
    const headers = (init && init.headers) || {};
    repo.requests.push({
      method,
      url: String(url),
      auth: headers['Authorization'] || headers['authorization'] || null
    });

    const u = new URL(String(url), 'https://nook.local/');
    const pathname = u.pathname;

    // site.json（相对路径）
    if (pathname === '/site.json') return res(200, JSON.stringify(SITE), 'application/json');

    if (u.hostname === 'raw.githubusercontent.com') {
      const parts = pathname.replace(/^\//, '').split('/');
      const rel = parts.slice(3).join('/');
      const f = files.get(rel);
      if (!f) return res(404, JSON.stringify({ message: 'Not Found' }), 'application/json');
      return res(200, f.content, 'text/plain');
    }

    if (u.hostname === 'api.github.com') {
      const parts = pathname.replace(/^\//, '').split('/');   // repos / owner / repo / kind / ...
      const kind = parts[3];
      if (kind === 'contents') {
        const rel = parts.slice(4).join('/');
        if (method === 'GET') return contentsGet(rel, headers);
        if (method === 'PUT') return contentsPut(rel, init);
        if (method === 'DELETE') return contentsDelete(rel);
      }
      if (kind === 'commits') {
        const p = u.searchParams.get('path');
        if (p && !files.has(p)) return res(200, '[]', 'application/json');
        return res(200, JSON.stringify([{
          sha: repo.commitSha,
          commit: { author: { date: repo.commitDate }, committer: { date: repo.commitDate } }
        }]), 'application/json');
      }
    }

    return res(404, JSON.stringify({ message: 'Not Found' }), 'application/json');
  };

  return repo;
}

// ----------------------------------------------------------------- 假浏览器

function makeEnv(repo) {
  const store = new Map();
  const ctx = {
    console,
    TextEncoder,
    TextDecoder,
    crypto: crypto.webcrypto,
    btoa: (s) => Buffer.from(String(s), 'binary').toString('base64'),
    atob: (s) => Buffer.from(String(s), 'base64').toString('binary'),
    // 真 fetch 返回 Promise，假的也得返回 Promise
    fetch: (url, init) => Promise.resolve(repo.fetch(url, init)),
    localStorage: {
      getItem(k) { return store.has(k) ? store.get(k) : null; },
      setItem(k, v) { store.set(k, String(v)); },
      removeItem(k) { store.delete(k); }
    },
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(VAULT_SRC, ctx, { filename: 'vault.js' });
  vm.runInContext(GH_API_SRC, ctx, { filename: 'gh-api.js' });
  return { ctx, store, api: ctx.GhApi };
}

// ----------------------------------------------------------------- 断言

let passed = 0;
let failed = 0;

function ok(name, cond, extra) {
  if (cond) {
    passed++;
    console.log('  ✓ ' + name);
  } else {
    failed++;
    console.log('  ✗ ' + name + (extra ? '  → ' + extra : ''));
  }
}

function eq(name, actual, expect) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expect);
  ok(name, a === b, a === b ? '' : '实际 ' + a + ' ≠ 期望 ' + b);
}

async function throwsOk(name, fn, re) {
  try {
    await fn();
    ok(name, false, '没有抛错');
  } catch (e) {
    const matched = re.test(String(e && e.message));
    ok(name, matched, 'message=' + (e && e.message) + (e && e.status !== undefined ? ' status=' + e.status : ''));
  }
}

// ----------------------------------------------------------------- 主流程

(async function main() {
  console.log('共读小屋 · 浏览器端 GitHub 适配器自检');
  console.log('');

  const repo = createRepo();
  const env = makeEnv(repo);
  const api = env.api;

  // 用真的 vault.js 加密假数据
  const key = await env.ctx.Vault.deriveKey(PASSCODE, SITE.kdf.salt, SITE.kdf.iter);
  const encJson = (v) => env.ctx.Vault.encryptJson(key, v);
  const encText = (s) => env.ctx.Vault.encryptText(key, s);

  repo.write('data/library.json.enc', await encJson([BOOK]));
  repo.write('data/books/' + BOOK_ID + '/text.txt.enc', await encText(TEXT));
  repo.write('data/books/' + BOOK_ID + '/annotations/1.json.enc', await encJson(ANNOS_1));
  repo.write('data/books/' + BOOK_ID + '/annotations/2.json.enc', await encJson(ANNOS_2));
  repo.write('data/books/' + BOOK_ID + '/notes/1.md.enc', await encText(NOTE_MD));
  repo.write('data/books/' + BOOK_ID + '/progress.json.enc', await encJson(PROGRESS));
  repo.write('data/docs/gudao-outline.md.enc', await encText(DOC_MD));

  // ---------------------------------------------------------- [1] 登录

  console.log('[1] 登录');
  await throwsOk('密码不对 → 抛错', () =>
    api.handle('/api/login', { method: 'POST', json: { passcode: '99999999' } }), /密码不对/);

  const login = await api.handle('/api/login', { method: 'POST', json: { passcode: PASSCODE } });
  eq('登录返回字段', Object.keys(login).sort(),
    ['ai_name', 'login_hint', 'ok', 'subtitle', 'user_name']);
  eq('登录 ok', login.ok, true);
  eq('登录 user_name', login.user_name, '姜来');
  eq('登录 ai_name', login.ai_name, '姜去');
  eq('登录 subtitle', login.subtitle, '姜来 & 姜去');

  // ---------------------------------------------------------- [2] 书架形状

  console.log('');
  console.log('[2] /api/library 形状');
  const lib = await api.handle('/api/library');
  eq('library 顶层字段', Object.keys(lib).sort(), ['ai_name', 'books', 'user_name']);
  eq('library.user_name', lib.user_name, '姜来');
  ok('library.books 是数组', Array.isArray(lib.books) && lib.books.length === 1);

  const b = lib.books[0];
  eq('book 字段', Object.keys(b).sort(), [
    'addedAt', 'chapterCount', 'encoding', 'filename', 'hasNotes', 'id', 'noteCount',
    'noteEstimate', 'pattern', 'pendingNotes', 'progress', 'skippedNotes', 'title'
  ]);
  eq('book.id', b.id, BOOK_ID);
  eq('book.title', b.title, BOOK.title);
  eq('book.filename', b.filename, BOOK.filename);
  eq('book.addedAt', b.addedAt, BOOK.addedAt);
  eq('book.encoding', b.encoding, 'utf-8');
  eq('book.chapterCount', b.chapterCount, 2);
  eq('book.pattern', b.pattern, 'cn-chapter');
  eq('book.hasNotes', b.hasNotes, true);
  eq('book.noteCount', b.noteCount, 1);
  eq('book.pendingNotes', b.pendingNotes, 1);
  eq('book.skippedNotes', b.skippedNotes, 0);
  eq('book.noteEstimate（静态版填 0）', b.noteEstimate, { chapters: 0, cost: 0, peak: false });
  eq('book.progress', b.progress, { chapter: 1, ratio: 0.25, updatedAt: PROGRESS.updatedAt });

  const one = await api.handle('/api/books/' + BOOK_ID);
  eq('/api/books/:id 字段', Object.keys(one).sort(), ['book']);
  eq('/api/books/:id 的标题', one.book.title, BOOK.title);

  // ---------------------------------------------------------- [3] 切段

  console.log('');
  console.log('[3] 章节切段（跟 server.js 逐字比对）');
  const ch = await api.handle('/api/books/' + BOOK_ID + '/chapter/1');
  eq('chapter 字段', Object.keys(ch).sort(), ['index', 'paragraphs', 'title', 'totalChapters']);
  eq('chapter.index', ch.index, 1);
  eq('chapter.title', ch.title, BOOK.chapters[0].title);
  eq('chapter.totalChapters', ch.totalChapters, 2);
  eq('第 1 章切段跟 server.js 一致', ch.paragraphs, serverSplit(TEXT_LINES.slice(0, 8).join('\n')));

  const ch2 = await api.handle('/api/books/' + BOOK_ID + '/chapter/2');
  eq('第 2 章切段跟 server.js 一致', ch2.paragraphs, serverSplit(TEXT_LINES.slice(8).join('\n')));

  const TRICKY = [
    '',
    '   ',
    '\n\n\n',
    'a'.repeat(600),
    'a'.repeat(600) + '。',
    '句子。'.repeat(200),
    '甲。乙。丙',
    '甲。。乙',
    '尾随空格   \t　',
    '第一行\r\n第二行\r\n',
    '。',
    '。。。',
    '句子。'.repeat(120) + '尾巴',
    '！'.repeat(80) + '尾',
    '；'.repeat(120),
    '…'.repeat(300),
    TEXT
  ];
  let same = true;
  let diff = '';
  for (const t of TRICKY) {
    const a = JSON.stringify(serverSplit(t));
    const c = JSON.stringify(api.splitParagraphs(t));
    if (a !== c) {
      same = false;
      diff = '输入=' + JSON.stringify(String(t).slice(0, 24)) + ' server=' + a.slice(0, 120) + ' gh=' + c.slice(0, 120);
      break;
    }
  }
  ok('各种边界输入切段都跟 server.js 逐字相同（' + TRICKY.length + ' 组）', same, diff);

  // ---------------------------------------------------------- [4] 写批注

  console.log('');
  console.log('[4] 写批注 → 仓库里多出正确的密文');
  api.setToken('ghp_faketoken');
  const annoPath = 'data/books/' + BOOK_ID + '/annotations/2.json.enc';
  const before = repo.files.get(annoPath).content;

  const posted = await api.handle('/api/books/' + BOOK_ID + '/annotations/2', {
    method: 'POST', json: { anchor: '海风', note: '这句真好', paraIndex: 3 }
  });
  eq('POST 返回字段', Object.keys(posted).sort(), ['annotation']);
  eq('批注字段', Object.keys(posted.annotation).sort(),
    ['anchor', 'id', 'note', 'paraIndex', 'replies', 'ts', 'who']);
  ok('批注 id 跟本地版一个格式（a_ + base36）', /^a_[0-9a-z]+$/.test(posted.annotation.id), posted.annotation.id);
  eq('批注 who', posted.annotation.who, 'user');
  eq('批注 anchor', posted.annotation.anchor, '海风');
  eq('批注 paraIndex', posted.annotation.paraIndex, 3);
  eq('批注 replies', posted.annotation.replies, []);

  const after = repo.files.get(annoPath).content;
  ok('仓库里的密文确实变了', before !== after);
  const inRepo = JSON.parse(await env.ctx.Vault.decryptText(key, after));
  eq('仓库里存的是 2 条批注', inRepo.length, 2);
  eq('新批注真的进了仓库', inRepo[1].anchor, '海风');
  eq('仓库里的批注字段跟返回的一样', Object.keys(inRepo[1]).sort(),
    ['anchor', 'id', 'note', 'paraIndex', 'replies', 'ts', 'who']);

  // 信封格式要跟 Node 端（lib/ghbackend.js / tools/push-repo.js）一样
  const envelope = JSON.parse(after);
  eq('信封字段', Object.keys(envelope).sort(), ['alg', 'ct', 'iv', 'mtime', 'v']);
  eq('信封 v', envelope.v, 1);
  eq('信封 alg', envelope.alg, 'AES-GCM');
  ok('信封有 mtime（毫秒）', typeof envelope.mtime === 'number' && envelope.mtime > 0);
  ok('信封 mtime 大概是现在', Math.abs(Date.now() - envelope.mtime) < 60000, String(envelope.mtime));

  const got = await api.handle('/api/books/' + BOOK_ID + '/annotations/2');
  eq('马上读回来能看到自己划的线', got.annotations.length, 2);
  eq('读回来的最后一条就是刚写的', got.annotations[1].anchor, '海风');

  // 换个环境（相当于刷新页面 / 另一台设备）→ 从仓库读，不是从内存缓存读
  const env2 = makeEnv(repo);
  await env2.api.handle('/api/login', { method: 'POST', json: { passcode: PASSCODE } });
  const got2 = await env2.api.handle('/api/books/' + BOOK_ID + '/annotations/2');
  eq('新环境从仓库读到 2 条批注', got2.annotations.length, 2);
  eq('新环境读到的就是刚写的那条', got2.annotations[1].anchor, '海风');

  // ---------------------------------------------------------- [5] 409 重试

  console.log('');
  console.log('[5] 409 冲突 → 重读、重合并、再写');
  repo.conflictNextPut = true;
  const putsBefore = repo.putAttempts;
  const posted2 = await api.handle('/api/books/' + BOOK_ID + '/annotations/2', {
    method: 'POST', json: { anchor: '再来一条', note: '', paraIndex: 1 }
  });
  ok('409 之后重试写成功了', !!(posted2 && posted2.annotation));
  eq('冲突后试了两次（一次撞墙 + 一次成功）', repo.putAttempts - putsBefore, 2);
  const dec2 = JSON.parse(await env.ctx.Vault.decryptText(key, repo.files.get(annoPath).content));
  eq('重试后仓库里有 3 条批注（没写重、没丢）', dec2.length, 3);
  eq('重试后新批注在最后', dec2[2].anchor, '再来一条');
  eq('重试没有把老批注弄丢', dec2[0].id, 'a_seed2');

  // ---------------------------------------------------------- [6] ping 省钱

  console.log('');
  console.log('[6] /api/ping —— 一轮轮询只发 1 个请求');
  const beforeFirst = repo.requests.length;
  const ping1 = await api.handle('/api/ping');
  const firstCount = repo.requests.length - beforeFirst;
  const beforeSecond = repo.requests.length;
  const ping2 = await api.handle('/api/ping');
  const secondCount = repo.requests.length - beforeSecond;
  ok('第一次 ping 会去算待回（请求不止 1 个）', firstCount > 1, 'first=' + firstCount);
  eq('sha 没变时第二次 ping 只发 1 个请求', secondCount, 1);
  eq('ping 字段', Object.keys(ping1).sort(), ['pending', 'ts']);
  eq('两次 ping 的 ts 一样', ping2.ts, ping1.ts);
  ok('ping.ts 是毫秒时间戳', ping1.ts > 1600000000000, String(ping1.ts));
  eq('ping.pending 是待回条数', ping1.pending, 3);

  const pend = await api.handle('/api/pending');
  eq('pending 顶层字段', Object.keys(pend).sort(), ['items']);
  ok('pending.items 是数组', Array.isArray(pend.items));
  eq('pending item 字段', Object.keys(pend.items[0]).sort(),
    ['anchor', 'annotationId', 'bookId', 'bookTitle', 'chapter', 'chapterTitle', 'note', 'ts']);
  const seed = pend.items.filter((x) => x.annotationId === 'a_seed2')[0];
  ok('待回里有那条没被回的批注', !!seed);
  if (seed) {
    eq('待回 bookId', seed.bookId, BOOK_ID);
    eq('待回 bookTitle', seed.bookTitle, BOOK.title);
    eq('待回 chapter', seed.chapter, 2);
    eq('待回 chapterTitle', seed.chapterTitle, BOOK.chapters[1].title);
    eq('待回 anchor', seed.anchor, '海风');
    eq('待回 note', seed.note, '等回复');
    eq('待回 ts', seed.ts, ANNOS_2[0].ts);
  }
  eq('有回应的批注不算待回', pend.items.filter((x) => x.annotationId === 'a_seed1').length, 0);

  // ---------------------------------------------------------- [7] 没 token

  console.log('');
  console.log('[7] 没 token 的时候');
  const env3 = makeEnv(repo);
  await env3.api.handle('/api/login', { method: 'POST', json: { passcode: PASSCODE } });
  await throwsOk('写批注 → 提示还没连上 GitHub', () =>
    env3.api.handle('/api/books/' + BOOK_ID + '/annotations/1', {
      method: 'POST', json: { anchor: 'x', note: 'y' }
    }), /还没连上 GitHub/);
  await throwsOk('写进度 → 提示还没连上 GitHub', () =>
    env3.api.handle('/api/books/' + BOOK_ID + '/progress', {
      method: 'POST', json: { chapter: 2 }
    }), /还没连上 GitHub/);
  const env3lib = await env3.api.handle('/api/library');
  ok('没 token 也能读（读是免 token 的）', env3lib.books.length === 1);
  ok('hasToken 是 false', env3.api.hasToken() === false);
  env3.api.setToken('ghp_abc');
  ok('setToken 之后 hasToken 是 true', env3.api.hasToken() === true);
  ok('token 只进 localStorage', env3.store.get('nook.gh.token') === 'ghp_abc');

  // ---------------------------------------------------------- [8] 其它接口

  console.log('');
  console.log('[8] 其它接口');
  const health = await api.handle('/api/health');
  eq('health 字段', Object.keys(health).sort(), ['login_hint', 'ok', 'time']);
  eq('health.ok', health.ok, true);
  eq('health.login_hint', health.login_hint, SITE.login_hint);

  const fmts = await api.handle('/api/formats');
  ok('formats 是数组', Array.isArray(fmts.formats) && fmts.formats.length === 6);
  eq('formats 里的字段', Object.keys(fmts.formats[0]).sort(), ['ext', 'label', 'note', 'ok']);

  eq('GET settings 返回 {}', await api.handle('/api/settings'), {});
  eq('POST settings 返回 {}', await api.handle('/api/settings', { method: 'POST', json: { passcode: 'x' } }), {});

  const prog = await api.handle('/api/books/' + BOOK_ID + '/progress');
  eq('progress 字段', Object.keys(prog).sort(), ['progress']);
  eq('progress 内容', prog.progress, PROGRESS);
  const np = await api.handle('/api/books/' + BOOK_ID + '/progress', {
    method: 'POST', json: { chapter: 2, paraIndex: 1, ratio: 0.5 }
  });
  eq('写进度是合并的（chapter 改了）', np.progress.chapter, 2);
  eq('写进度 ratio 也改了', np.progress.ratio, 0.5);
  ok('写进度带 updatedAt', typeof np.progress.updatedAt === 'string' && np.progress.updatedAt.length > 0);

  const notes = await api.handle('/api/books/' + BOOK_ID + '/notes/1');
  eq('notes 字段', Object.keys(notes).sort(), ['chapter', 'text', 'title']);
  eq('notes.chapter', notes.chapter, 1);
  eq('notes.title', notes.title, BOOK.chapters[0].title);
  eq('notes.text（去掉标题行）', notes.text, '开篇的剧情笔记：雾、站台灯、江面。');

  const docs = await api.handle('/api/docs');
  eq('docs 顶层字段', Object.keys(docs).sort(), ['docs']);
  eq('doc 字段', Object.keys(docs.docs[0]).sort(),
    ['chars', 'file', 'id', 'summary', 'tags', 'title', 'updatedAt']);
  eq('doc.id', docs.docs[0].id, 'gudao-outline');
  eq('doc.file', docs.docs[0].file, 'gudao-outline.md');
  eq('doc.title', docs.docs[0].title, '古道全书脉络');
  eq('doc.summary', docs.docs[0].summary, '一句话说清全书');
  eq('doc.tags', docs.docs[0].tags, ['古道', '脉络']);
  ok('doc.updatedAt 有值', !!docs.docs[0].updatedAt);
  const doc = await api.handle('/api/docs/gudao-outline');
  eq('doc 字段', Object.keys(doc).sort(), ['body', 'chars', 'id', 'summary', 'tags', 'text', 'title']);
  ok('doc 正文有内容', doc.body.indexOf('正文第一段。') >= 0);

  // ---------------------------------------------------------- [9] 不支持的

  console.log('');
  console.log('[9] 静态版不支持的接口要说人话');
  await throwsOk('上传图书', () =>
    api.handle('/api/books', { method: 'POST', raw: 'x', filename: 'a.txt' }), /静态版不能上传图书/);
  await throwsOk('工作台', () => api.handle('/api/workbench'), /静态版没有工作台/);
  await throwsOk('生成剧情笔记', () =>
    api.handle('/api/tasks/notes', { method: 'POST', json: { bookId: BOOK_ID } }), /静态版不能生成剧情笔记/);
  await throwsOk('AI 自动回', () =>
    api.handle('/api/ai/auto', { method: 'POST', json: { bookId: BOOK_ID, chapter: 1 } }), /静态版不能自动回批注/);
  await throwsOk('AI 回信', () =>
    api.handle('/api/ai/reply', { method: 'POST', json: { bookId: BOOK_ID, chapter: 1, text: 'x' } }), /静态版不能在这里回批注/);
  await throwsOk('不认识的接口', () => api.handle('/api/nope'), /no such api/);

  // ---------------------------------------------------------- [10] 读/写走哪条路

  console.log('');
  console.log('[10] 读走 raw（免 token），写走 api（要 token）');
  const env5 = makeEnv(repo);
  env5.api.setToken('ghp_faketoken');
  await env5.api.handle('/api/login', { method: 'POST', json: { passcode: PASSCODE } });

  repo.requests.length = 0;
  await env5.api.handle('/api/library');
  const readReqs = repo.requests.slice();
  ok('普通读走 raw.githubusercontent.com', readReqs.some((r) => r.url.indexOf('raw.githubusercontent.com') >= 0));
  ok('普通读不带 Authorization（token 不外泄）',
    readReqs.filter((r) => r.url.indexOf('raw.githubusercontent.com') >= 0).every((r) => !r.auth));

  repo.requests.length = 0;
  await env5.api.handle('/api/books/' + BOOK_ID + '/annotations/1', {
    method: 'POST', json: { anchor: '路由检查', note: '', paraIndex: 0 }
  });
  const writeReqs = repo.requests.slice();
  ok('写走 api.github.com 的 contents 接口',
    writeReqs.some((r) => r.method === 'PUT' && r.url.indexOf('api.github.com/repos/') >= 0 && r.url.indexOf('/contents/') >= 0));
  ok('写的时候带上了 token',
    writeReqs.filter((r) => r.method === 'PUT').every((r) => r.auth === 'Bearer ghp_faketoken'));
  ok('token 从来不发去 raw.githubusercontent.com',
    writeReqs.filter((r) => r.url.indexOf('raw.githubusercontent.com') >= 0).every((r) => !r.auth));
  ok('写之前先读一次拿 sha（读改写）',
    writeReqs.some((r) => r.method === 'GET' && r.url.indexOf('/contents/') >= 0));

  // ---------------------------------------------------------- [11] 删书

  console.log('');
  console.log('[11] 删书');
  const env4 = makeEnv(repo);
  env4.api.setToken('ghp_faketoken');
  await env4.api.handle('/api/login', { method: 'POST', json: { passcode: PASSCODE } });
  const del = await env4.api.handle('/api/books/' + BOOK_ID, { method: 'DELETE' });
  eq('删书返回 {ok:true}', del, { ok: true });
  const libAfter = JSON.parse(await env.ctx.Vault.decryptText(key, repo.files.get('data/library.json.enc').content));
  eq('书架里没了这本书', libAfter.length, 0);
  ok('书的文件也被删了', !repo.files.has('data/books/' + BOOK_ID + '/text.txt.enc'));
  ok('批注文件也被删了', !repo.files.has(annoPath));

  // ---------------------------------------------------------- 收尾

  console.log('');
  console.log('----------------------------------------');
  console.log('通过 ' + passed + ' 项，失败 ' + failed + ' 项');
  if (failed) {
    console.log('');
    console.log('有失败项，不算通过。');
    process.exitCode = 1;
  } else {
    console.log('全绿。');
  }
})().catch(function (e) {
  console.error('');
  console.error('自检脚本自己炸了：', (e && e.stack) || e);
  process.exitCode = 1;
});
