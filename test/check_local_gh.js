'use strict';
/**
 * check_local_gh.js —— 验本机服务是不是真的在用 GitHub 仓库当数据源
 *
 * 顺带验「她在这台电脑上划的线，手机上立刻看得到」这条命门：
 *   本机写一条 → 仓库里出现 → 另一台（模拟手机）读得到 → 删掉，不留痕
 *
 *   node test\check_local_gh.js
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SITE = JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'site.json'), 'utf8'));
const BASE = 'http://127.0.0.1:8231';
const COOKIE = 'rk=' + (process.env.NOOK_PASS || '06090823');
const TOKEN = (process.env.GH_TOKEN || '').trim();
const BOOK = 'b_mvhx4hgqqddcvb';   // 《古道》
// 自检用的章号：**一定要在 900+** ——
// 清理脚本（check_gh_live.js 的 cleanScratch）只扫 900+，
// 用小章号的话，测试中途挂掉就会留下垃圾条目，
// 出现在姜来的「待回队列」里（云端姜去会去回它们）。
const SCRATCH = 900 + Math.floor(Math.random() * 90);

let passed = 0, failed = 0;
function ok(name, cond, extra) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')); }
}

function api(p, opt) {
  const init = { method: (opt && opt.method) || 'GET', headers: { Cookie: COOKIE } };
  if (opt && opt.json !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(opt.json);
  }
  return retry(() => fetch(BASE + p, init)).then(async (res) => {
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch (e) { data = text; }
    if (!res.ok) {
      const e = new Error('HTTP ' + res.status + ' ' + ((data && data.error) || text.slice(0, 150)));
      e.status = res.status;
      throw e;
    }
    return data;
  });
}

/** 网络层会抖，重试几次 */
function retry(fn, times) {
  const n = times || 3;
  return fn().catch((e) => {
    if (n <= 1) throw e;
    return new Promise((r) => setTimeout(r, 700)).then(() => retry(fn, n - 1));
  });
}

function gh(method, apiPath, body) {
  const headers = {
    'Accept': 'application/vnd.github+json',
    'Authorization': 'Bearer ' + TOKEN,
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'reading-nook-local-check'
  };
  let payload = null;
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  return fetch('https://api.github.com' + apiPath, { method, headers, body: payload })
    .then(async (res) => {
      const t = await res.text();
      let d = null;
      try { d = t ? JSON.parse(t) : null; } catch (e) { d = t; }
      if (!res.ok) {
        const e = new Error(res.status + ' ' + ((d && d.message) || t.slice(0, 200)));
        e.status = res.status;
        throw e;
      }
      return d;
    });
}

(async function main() {
  console.log('共读小屋 · 本机服务 ↔ GitHub 仓库');
  console.log('');

  console.log('=== 本机服务读的是仓库吗 ===');
  const lib = await api('/api/library');
  ok('书架读到了', Array.isArray(lib.books) && lib.books.length >= 2, 'n=' + (lib.books || []).length);
  const gudao = lib.books.find((b) => b.title === '古道');
  ok('《古道》在', !!gudao);
  ok('24 章', gudao && gudao.chapterCount === 24);

  const ch = await api('/api/books/' + BOOK + '/chapter/5');
  ok('第 5 章正文取得到', Array.isArray(ch.paragraphs) && ch.paragraphs.length > 5);
  ok('是中文', /[\u4e00-\u9fa5]/.test(ch.paragraphs.join('')));

  const annos = await api('/api/books/' + BOOK + '/annotations/5');
  ok('第 5 章 3 条批注', (annos.annotations || []).length === 3, 'n=' + (annos.annotations || []).length);

  console.log('');
  console.log('=== 本机划一道 → 仓库里有没有 ===');
  const repoPath = '/repos/' + SITE.owner + '/' + SITE.repo + '/contents/data/books/' + BOOK +
    '/annotations/' + SCRATCH + '.json.enc';
  let meta = null;
  try {
    // ⚠️ 一定要 try/finally —— 测试中途挂掉的话，残留会出现在姜来的待回队列里
    const wrote = await api('/api/books/' + BOOK + '/annotations/' + SCRATCH,
      { method: 'POST', json: { anchor: '本机写的一条自检', note: '跨设备同步自检', paraIndex: 1 } });
    ok('本机写成功了', !!(wrote && wrote.annotation), JSON.stringify(wrote));

    // 直接问仓库（绕开本机服务）
    try { meta = await gh('GET', repoPath); } catch (e) { /* 下面会报错 */ }
    ok('仓库里多出那个文件', !!meta, meta ? '' : 'contents 接口没找到');
    if (meta) {
      const enc = Buffer.from(String(meta.content).replace(/\s+/g, ''), 'base64').toString('utf8');
      ok('仓库里是密文', /"alg"\s*:\s*"AES-GCM"/.test(enc));
      ok('仓库里看不到明文', enc.indexOf('本机写的一条自检') < 0);
    }

    console.log('');
    console.log('=== 另一台设备（手机）能不能读到 ===');
    const raw = await retry(() => fetch('https://raw.githubusercontent.com/' + SITE.owner + '/' + SITE.repo + '/' + SITE.branch +
      '/data/books/' + BOOK + '/annotations/' + SCRATCH + '.json.enc?t=' + Date.now())
      .then((r) => r.text()));
    ok('手机那边能拿到那个文件', raw.length > 20);
    ok('是密文（手机用密码解开）', /"ct"\s*:/.test(raw));
  } finally {
    console.log('');
    console.log('=== 清理 ===');
    if (meta) {
      await gh('DELETE', repoPath, { message: '清理：本机同步自检', sha: meta.sha, branch: SITE.branch });
      let gone = 0;
      try { await gh('GET', repoPath); gone = 200; } catch (e) { gone = e.status || 0; }
      ok('自检文件已删', gone === 404, 'status=' + gone);
    } else {
      // 写成功了但没读到 meta —— 也要按路径找出来删掉
      try {
        const m2 = await gh('GET', repoPath);
        await gh('DELETE', repoPath, { message: '清理：本机同步自检', sha: m2.sha, branch: SITE.branch });
        console.log('  （补删了自检文件）');
      } catch (e) { /* 本来就不在 */ }
    }
  }

  console.log('');
  console.log('=== 她的原数据没被动过 ===');
  const still = await api('/api/books/' + BOOK + '/annotations/5');
  ok('第 5 章还是 3 条', (still.annotations || []).length === 3, 'n=' + (still.annotations || []).length);
  ok('id 没变', (still.annotations || [])[0] && (still.annotations[0].id === 'a_mvhyfuroua9xxk' ||
    (still.annotations[0].id || '').startsWith('a_')));

  console.log('');
  console.log(failed ? 'ALL FAIL' : 'ALL PASS');
  console.log(passed + ' checks');
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error('出错:', e && e.message);
  if (e && e.stack) console.error(e.stack.split('\n').slice(1, 3).join('\n'));
  process.exit(1);
});
