'use strict';
/* End-to-end test: login -> upload -> chapters -> annotate -> pending -> reply */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

/*
 * 这个测试**自己起一个隔离的服务**：临时数据目录 + 临时端口 + 本地磁盘后端。
 *
 * 为什么不能打正在跑的那个（8231）：
 *   现在那台的���据源是 GitHub 仓库（公开的）。测试会往书架里塞一本《测试小说》、
 *   划线、回话 —— 全都会变成公开仓库里的真实 commit，还可能在她书架上留残骸。
 *   测试归测试，别碰她的数据。
 */
const PORT = 8299 + (process.pid % 200);
const BASE = 'http://127.0.0.1:' + PORT;
const TMP_DIR = path.join(os.tmpdir(), 'nook-e2e-' + process.pid);
const PASS = process.env.NOOK_PASS || '06090823';

let child = null;

function startServer() {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(TMP_DIR, { recursive: true });
    child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
      cwd: path.join(__dirname, '..'),
      env: Object.assign({}, process.env, {
        PORT: String(PORT),
        NOOK_DATA_DIR: TMP_DIR,
        NOOK_BACKEND: 'fs'
      }),
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let err = '';
    child.stderr.on('data', (d) => { err += d.toString(); });
    let tries = 0;
    const tick = async () => {
      tries++;
      try {
        const r = await fetch(BASE + '/api/health');
        if (r.ok) return resolve();
      } catch (e) { /* 还没起来 */ }
      if (tries > 60) return reject(new Error('测试服务起不来：' + err.slice(0, 400)));
      setTimeout(tick, 250);
    };
    setTimeout(tick, 400);
  });
}

function stopServer() {
  try { if (child) child.kill(); } catch (e) { /* ignore */ }
  try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch (e) { /* ignore */ }
}

function makeBook() {
  const parts = [];
  for (let i = 1; i <= 5; i++) {
    parts.push('第' + '一二三四五'[i - 1] + '章  铁轨上的第' + i + '站');
    for (let j = 0; j < 12; j++) {
      parts.push('这是第' + i + '章的第' + (j + 1) + '段。车窗外的灯一盏盏往后退，' +
        '姜来把书页往下压了压，想起了那只在站台等她的黑猫。第' + i + '段的内容。');
    }
    parts.push('');
  }
  return parts.join('\n');
}

async function main() {
  const results = [];
  function check(name, ok, extra) {
    results.push({ name, ok, extra });
    console.log((ok ? '  PASS  ' : '  FAIL  ') + name + (extra ? '  -> ' + extra : ''));
  }

  await startServer();

  // login
  const lr = await fetch(BASE + '/api/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ passcode: PASS })
  });
  const cookie = (lr.headers.get('set-cookie') || '').split(';')[0];
  check('login returns cookie', lr.ok && !!cookie, 'status=' + lr.status);

  const H = { Cookie: cookie };

  // unauthorized check
  const unauth = await fetch(BASE + '/api/library');
  check('unauthorized blocked', unauth.status === 401, 'status=' + unauth.status);

  // upload
  const bookText = makeBook();
  const up = await fetch(BASE + '/api/books', {
    method: 'POST', headers: Object.assign({ 'X-Filename': encodeURIComponent('测试小说.txt') }, H),
    body: Buffer.from(bookText, 'utf8')
  });
  const upJson = await up.json();
  check('upload ok', up.ok && upJson.book, JSON.stringify(upJson).slice(0, 120));
  const bookId = upJson.book.id;

  // library
  const lib = await fetch(BASE + '/api/library', { headers: H });
  const libJson = await lib.json();
  check('library lists book', libJson.books.some((b) => b.id === bookId), 'books=' + libJson.books.length);

  // chapters
  const ch = await fetch(BASE + '/api/books/' + bookId + '/chapter/2', { headers: H });
  const chJson = await ch.json();
  check('chapter 2 loads', ch.ok && chJson.paragraphs.length > 0,
    'title=' + chJson.title + ' paras=' + (chJson.paragraphs || []).length);

  // annotate
  const anchor = chJson.paragraphs[0].slice(0, 12);
  const an = await fetch(BASE + '/api/books/' + bookId + '/annotations/2', {
    method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, H),
    body: JSON.stringify({ anchor, note: '这里我有个想法', paraIndex: 0 })
  });
  const anJson = await an.json();
  check('annotation saved', an.ok && anJson.annotation && anJson.annotation.paraIndex === 0,
    'paraIndex=' + (anJson.annotation && anJson.annotation.paraIndex));

  // pending
  //
  // 注意：只断言"我刚划的这条在队列里"，不能断言"队列里只有这一条" ——
  // 书架上可能还有姜来自己划的线（真实使用场景），那不是测试的问题。
  const myKey = bookId + '/ch2';
  const pend = await fetch(BASE + '/api/pending', { headers: H });
  const pendJson = await pend.json();
  const mine = pendJson.items.filter((i) => i.bookId + '/ch' + i.chapter === myKey);
  check('pending shows my annotation', mine.length >= 1,
    JSON.stringify(pendJson.items.map((i) => i.bookId + '/ch' + i.chapter)));

  // reply
  const rp = await fetch(BASE + '/api/ai/reply', {
    method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, H),
    body: JSON.stringify({ bookId, chapter: 2, text: '我觉得那只黑猫是伏笔。' })
  });
  const rpJson = await rp.json();
  check('reply saved', rp.ok && rpJson.ok, JSON.stringify(rpJson).slice(0, 100));

  // annotations now have reply
  const ag = await fetch(BASE + '/api/books/' + bookId + '/annotations/2', { headers: H });
  const agJson = await ag.json();
  // 按 anchor 找自己那条（同章可能还有别的批注，别拿 [0]）
  const item = (agJson.annotations || []).find((a) => a.anchor === anchor);
  check('reply attached to annotation', item && item.replies && item.replies.length === 1,
    item && item.replies ? item.replies[0].text : 'none');

  // pending: 我这条已经不在了（别的书/别的章可能有，不归这个测试管）
  const pend2 = await fetch(BASE + '/api/pending', { headers: H });
  const pend2Json = await pend2.json();
  const stillMine = pend2Json.items.filter((i) => i.bookId + '/ch' + i.chapter === myKey);
  check('pending cleared after reply', stillMine.length === 0,
    'items=' + pend2Json.items.length + ' mine=' + stillMine.length);

  // progress
  await fetch(BASE + '/api/books/' + bookId + '/progress', {
    method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, H),
    body: JSON.stringify({ chapter: 2, paraIndex: 3, ratio: 0.4 })
  });
  const pg = await fetch(BASE + '/api/books/' + bookId + '/progress', { headers: H });
  const pgJson = await pg.json();
  check('progress persisted', pgJson.progress && pgJson.progress.chapter === 2, JSON.stringify(pgJson.progress));

  // workbench
  const wb = await fetch(BASE + '/api/workbench', { headers: H });
  const wbJson = await wb.json();
  check('workbench stats present', wb.ok && wbJson.stats && typeof wbJson.stats.calls === 'number',
    'calls=' + (wbJson.stats && wbJson.stats.calls));

  // static
  const page = await fetch(BASE + '/');
  const pageText = await page.text();
  check('index.html served', page.ok && pageText.includes('共读小屋'), 'len=' + pageText.length);
  const css = await fetch(BASE + '/app.css');
  check('app.css served', css.ok, 'status=' + css.status);
  const js = await fetch(BASE + '/app.js');
  check('app.js served', js.ok, 'status=' + js.status);

  // cleanup
  await fetch(BASE + '/api/books/' + bookId, { method: 'DELETE', headers: H });

  const failed = results.filter((r) => !r.ok);
  console.log('');
  console.log(failed.length === 0 ? 'ALL PASS (' + results.length + ')' : failed.length + ' FAILED of ' + results.length);
  await shutdown(failed.length ? 1 : 0);
}

/**
 * 干净退出。
 * 全局 fetch（undici）默认带 keep-alive 连接池，直接 process.exit() 会在
 * Windows 上触发 libuv 断言 `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)`，
 * 断言全过也返回非 0 退出码，容易被误判成测试失败。
 * 所以退出前先把全局 dispatcher 的连接池关掉。
 */
async function shutdown(code) {
  stopServer();
  const d = globalThis[Symbol.for('undici.globalDispatcher.1')];
  if (d && typeof d.close === 'function') {
    try { await d.close(); } catch (e) { /* ignore */ }
  }
  process.exit(code);
}

main().catch((e) => {
  console.error('TEST ERROR', e);
  stopServer();
  process.exit(2);
});
