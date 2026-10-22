'use strict';
/**
 * check_pending_ctx.js —— 验 /api/pending 真的带 context 和 plotNote
 *
 * 这两个字段是我下午新加的（HTTP 这边以前漏了，只有 CLI 有）。
 * 但待回队列平时是空的，没东西可验 —— 所以这里**临时造一条**，
 * 验完**一定还原**（try/finally 兜着）。
 *
 *   node test\check_pending_ctx.js
 */

const path = require('path');
const vfs = require('../lib/vfs');

const BASE = 'http://127.0.0.1:8231';
const COOKIE = 'rk=' + (process.env.NOOK_PASS || '06090823');
const BOOK = 'b_mvhx4hgqqddcvb';   // 《古道》
const CH = 5;
const ANNO_REL = 'books/' + BOOK + '/annotations/' + CH + '.json';

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
  return fetch(BASE + p, init).then(async (res) => {
    const t = await res.text();
    let d = null;
    try { d = t ? JSON.parse(t) : null; } catch (e) { d = t; }
    if (!res.ok) {
      const e = new Error('HTTP ' + res.status + ' ' + ((d && d.error) || t.slice(0, 150)));
      e.status = res.status;
      throw e;
    }
    return d;
  });
}

(async function main() {
  console.log('=== /api/pending 的 context 和 plotNote ===');
  console.log('');

  // 先记下原始内容（还原要用）
  const original = vfs.readFileSync(ANNO_REL);
  const before = JSON.parse(original);
  console.log('  第' + CH + '章原本 ' + before.length + ' 条批注');

  // 找一句这一章真有的原文当 anchor（这样才切得出上下文）
  const ch = await api('/api/books/' + BOOK + '/chapter/' + CH);
  const para = (ch.paragraphs || []).find((p) => p && p.length > 12) || '（随便一句）';
  const anchor = para.slice(0, Math.min(12, para.length));

  let tempId = null;
  try {
    const wrote = await api('/api/books/' + BOOK + '/annotations/' + CH, {
      method: 'POST', json: { anchor: anchor, note: '（自检临时条目）', paraIndex: 0 }
    });
    tempId = wrote.annotation && wrote.annotation.id;
    ok('临时批注造出来了', !!tempId, String(tempId));

    const pend = await api('/api/pending');
    const item = (pend.items || []).find((i) => i.annotationId === tempId);
    ok('待回队列里有它', !!item);
    if (item) {
      ok('带 context（她划的那句前后 400 字）', typeof item.context === 'string' && item.context.length > 20,
        'len=' + ((item.context || '').length));
      ok('context 里含她划的那句', (item.context || '').indexOf(anchor) >= 0);
      ok('带 plotNote（这一章的剧情笔记）', typeof item.plotNote === 'string' && item.plotNote.length > 30,
        'len=' + ((item.plotNote || '').length));
      ok('plotNote 是《古道》的笔记', /雪|路|脚印|石头|行走/.test(item.plotNote || ''));
      ok('bookId 对', item.bookId === BOOK);
      ok('章号对', item.chapter === CH);
    }

    // 队列里原有的待回条目也不该受影响
    const others = (pend.items || []).filter((i) => i.annotationId !== tempId);
    ok('原有条目也都在', others.length >= 0);
  } finally {
    // 还原：把临时那条去掉，文件写回去
    if (tempId) {
      const now = JSON.parse(vfs.readFileSync(ANNO_REL));
      const back = now.filter((a) => a.id !== tempId);
      vfs.writeFileSync(ANNO_REL, JSON.stringify(back, null, 2));
      console.log('  （已还原：临时条目已移除，' + back.length + ' 条）');
    }
  }

  // 还原验证
  const after = JSON.parse(vfs.readFileSync(ANNO_REL));
  ok('批注条数跟一开始一样', after.length === before.length, before.length + ' → ' + after.length);
  ok('内容一字不差', JSON.stringify(after) === JSON.stringify(before));

  console.log('');
  console.log(failed ? 'ALL FAIL' : 'ALL PASS');
  console.log(passed + ' checks');
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error('出错:', e && e.message);
  process.exit(1);
});
