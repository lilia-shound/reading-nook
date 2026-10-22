#!/usr/bin/env node
'use strict';
/**
 * 共读小屋 - 命令行
 *
 * 伴读 AI（姜去）用这个命令读批注、写回应。
 * 全程走伴读 AI 自己的订阅额度，外部 API 一分钱不花。
 *
 *   node nook.js books                       列出所有书
 *   node nook.js pending                     列出所有待回批注（带上下文）
 *   node nook.js docs                       列出资料库文档（全书脉络之类）
 *   node nook.js doc <id>                   读一篇资料库文档
 *   node nook.js chapter <bookId> <ch>       读某章原文
 *   node nook.js note <bookId> <ch>          读某章的剧情笔记
 *   node nook.js note-gen <bookId> --budget 5  生成剧情笔记（带预算上限）
 *   node nook.js reply <bookId> <ch> --text "..."     回一条批注
 *   node nook.js reply <bookId> <ch> --stdin           从标准输入读回应
 *   node nook.js ping                      验证 DeepSeek key + 查余额对账
 *   node nook.js serve                      启动网页服务
 */

const fs = require('fs');
const path = require('path');
const store = require('./lib/store');

function arg(flag, def) {
  const i = process.argv.indexOf(flag);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  return def;
}

function has(flag) {
  return process.argv.indexOf(flag) >= 0;
}

function readStdin() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) {
      resolve('');
      return;
    }
    let buf = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (d) => { buf += d; });
    process.stdin.on('end', () => resolve(buf));
  });
}

function chapterText(book, chapter) {
  const file = store.bookDir(book.id) + '/text.txt';
  const raw = require('./lib/vfs').readFileSync(file);
  const lines = raw.split(/\r?\n/);
  const meta = (book.chapters || []).find((c) => c.index === chapter);
  if (!meta) return null;
  return lines.slice(meta.startLine, meta.endLine + 1).join('\n');
}

function cmdBooks() {
  const books = store.listBooks();
  if (!books.length) {
    console.log('(no books yet)');
    return;
  }
  books.forEach((b) => {
    const p = store.getProgress(b.id);
    console.log(
      b.id + '  ' + b.title + '  [' + b.chapterCount + ' ch, ' + b.encoding + ']' +
      (p ? '  progress: ch' + p.chapter : '')
    );
  });
}

function cmdPending() {
  const items = store.pendingItems();
  if (!items.length) {
    console.log('(no pending annotations)');
    return;
  }
  if (has('--json')) {
    console.log(JSON.stringify(items, null, 2));
    return;
  }
  items.forEach((it, i) => {
    const book = store.getBook(it.bookId);
    const meta = book ? (book.chapters || []).find((c) => c.index === it.chapter) : null;
    console.log('');
    console.log('[' + (i + 1) + '] ' + it.bookTitle + ' / ' + it.chapterTitle + ' (ch' + it.chapter + ')');
    console.log('  bookId : ' + it.bookId);
    console.log('  annoId : ' + it.annotationId);
    console.log('  quoted : ' + it.anchor);
    console.log('  my note: ' + (it.note || '(just a highlight)'));
    if (meta) {
      const body = chapterText(book, it.chapter) || '';
      const pos = body.indexOf(it.anchor);
      if (pos >= 0) {
        const from = Math.max(0, pos - 400);
        const to = Math.min(body.length, pos + it.anchor.length + 400);
        console.log('  context: ...' + body.slice(from, to).replace(/\n+/g, ' ') + '...');
      }
    }
    const note = store.getNote(it.bookId, it.chapter);
    if (note) console.log('  plot note: ' + note.replace(/\n+/g, ' ').slice(0, 400));
  });
  console.log('');
  console.log('--- reply with ---');
  console.log('node nook.js reply <bookId> <chapter> --text "你的回应"');
}

// 资料库：不属于任何一本书的那些文档（全书脉络、设计说明、约定）
function cmdDocs(id) {
  const docs = require('./lib/docs');
  if (id) {
    const d = docs.readDoc(id);
    if (!d) { console.error('doc not found: ' + id); process.exit(1); }
    console.log(d.body);
    return;
  }
  const list = docs.listDocs();
  if (!list.length) { console.log('资料库是空的'); return; }
  console.log('=== 资料库（' + list.length + ' 篇）===');
  list.forEach((d) => {
    console.log('');
    console.log('  ' + d.id);
    console.log('    ' + d.title + '  (' + d.chars + ' 字)');
    if (d.summary) console.log('    ' + d.summary);
  });
  console.log('');
  console.log('--- read with ---');
  console.log('node nook.js doc <id>');
}

function cmdChapter(bookId, ch) {
  const book = store.getBook(bookId);
  if (!book) {
    console.error('book not found: ' + bookId);
    process.exit(1);
  }
  const text = chapterText(book, Number(ch));
  if (text === null) {
    console.error('chapter not found: ' + ch);
    process.exit(1);
  }
  process.stdout.write(text + '\n');
}

function cmdNote(bookId, ch) {
  const note = store.getNote(bookId, Number(ch));
  if (!note) {
    console.error('no note for chapter ' + ch);
    process.exit(1);
  }
  console.log(note);
}

async function cmdReply(bookId, ch) {
  const chapter = Number(ch);
  let text = arg('--text', '');
  if (!text && has('--stdin')) text = (await readStdin()).trim();
  if (!text && has('--file')) {
    text = fs.readFileSync(arg('--file', ''), 'utf8').trim();
  }
  if (!text) {
    console.error('need --text "..." or --stdin or --file <path>');
    process.exit(1);
  }
  const list = store.getAnnotations(bookId, chapter);
  if (!list.length) {
    console.error('no annotations in this chapter');
    process.exit(1);
  }
  const anchorId = arg('--anno', null);
  const saved = store.addReply(bookId, chapter, text, anchorId);
  console.log('reply saved -> book ' + bookId + ' ch' + chapter + ' anno ' + saved.annotationId);
}

/**
 * ping：验证 DeepSeek key 通不通，并跟账户余额对账。
 *   node nook.js ping
 * 会真调一次最小请求（几厘钱），然后打印账本那一笔和当前余额。
 */
async function cmdPing() {
  const ds = require('./lib/deepseek');
  const config = store.readConfig();
  const key = (config.deepseek_api_key || '').trim();

  if (!key) {
    console.error('no deepseek key in data/config.json (deepseek_api_key)');
    console.error('把 key 填进去，或者在网页「设置」里粘贴，然后重跑本命令。');
    process.exit(2);
  }
  console.log('key: ' + key.slice(0, 6) + '...' + key.slice(-4) + '  model: ' + config.deepseek_model);
  console.log('');

  const res = await ds.chat({
    prompt: '只回答两个字：收到',
    system: '你只输出答案本身，不要解释。',
    task: 'ping',
    maxTokens: 32,
    temperature: 0
  });

  if (!res.ok) {
    console.error('call failed: ' + res.error);
    const l = res.log || {};
    console.error('账本已记：ok=' + l.ok + ' error=' + l.error);
    process.exit(1);
  }

  const u = res.usage || {};
  const period = res.log && res.log.period === 'peak' ? '高峰档' : '低谷档';
  console.log('reply      : ' + JSON.stringify(res.text));
  console.log('prompt tok : ' + (u.prompt_tokens || 0) + '  (命中 ' + (res.log.cacheHitTokens || 0) +
    ' / 未命中 ' + (res.log.cacheMissTokens || 0) + ')');
  console.log('output tok : ' + (u.completion_tokens || 0));
  console.log('档位 / 费率: ' + period + '  ' + JSON.stringify(res.log.rate));
  console.log('本次估价   : ¥' + res.cost.toFixed(6) + '   耗时 ' + res.durationMs + 'ms');
  console.log('思考模式   : ' + (res.log.thinking ? '开' : '关') + '（脏活默认关，省输出 token）');
  console.log('');

  const bal = await ds.getBalance(config);
  if (bal.ok) {
    bal.balances.forEach((b) => {
      console.log('余额 ' + b.currency + ': 总 ' + b.total.toFixed(2) +
        '（充值 ' + b.toppedUp.toFixed(2) + ' + 赠送 ' + b.granted.toFixed(2) + '）');
    });
    console.log('');
    console.log('注意：DeepSeek 的余额是**延迟结算**的（实测刚花掉 ¥0.05，60 秒后余额都没动），');
    console.log('而且只保留 2 位小数 —— 所以余额跟本地账本**当场对不上是正常的**，不是账本算错了。');
    console.log('要精确对账，去 platform.deepseek.com 后台看「用量明细」；本地账本的单价是官方价，算术无误。');
  } else {
    console.log('余额查询失败: ' + bal.error);
  }
}

/**
 * note-gen：给某本书生成剧情笔记，带预算上限。
 *   node nook.js note-gen <bookId> --budget 5
 *   node nook.js note-gen <bookId> --from 1 --to 20 --budget 1
 */
async function cmdNoteGen(bookId) {
  const ds = require('./lib/deepseek');
  const config = store.readConfig();
  const book = store.getBook(bookId);
  if (!book) {
    console.error('book not found: ' + bookId);
    process.exit(1);
  }
  if (!(config.deepseek_api_key || '').trim()) {
    console.error('no deepseek key in data/config.json');
    process.exit(2);
  }
  const from = Number(arg('--from', 1));
  const to = Number(arg('--to', book.chapterCount));
  const budget = Number(arg('--budget', 0)) || null;

  const pending = (book.chapters || []).filter((m) =>
    m.index >= from && m.index <= to &&
    !(book.notes && book.notes[String(m.index)]) &&
    (config.skip_non_narrative === false || ds.isNarrativeChapter(m.title)));
  const skippedByKind = (book.chapters || []).filter((m) =>
    m.index >= from && m.index <= to &&
    !(book.notes && book.notes[String(m.index)]) &&
    !ds.isNarrativeChapter(m.title)).length;

  const planned = [];
  let estimated = 0;
  for (const m of pending) {
    const e = ds.estimateNotesCost(book, [m], config);
    if (budget && estimated + e.cost > budget) break;
    estimated += e.cost;
    planned.push(m);
  }

  console.log('待生成 ' + pending.length + ' 章，本次排 ' + planned.length + ' 章，预计 ¥' + estimated.toFixed(4));
  if (skippedByKind) console.log('（自动跳过 ' + skippedByKind + ' 个附录类章节：版权/致谢/索引这类没有剧情）');
  if (budget) console.log('预算上限 ¥' + budget + (pending.length > planned.length ? '（其余 ' + (pending.length - planned.length) + ' 章超预算，没排）' : ''));
  console.log('');

  let spent = 0;
  for (const m of planned) {
    if (budget && spent >= budget) { console.log('预算用完，停。'); break; }
    const text = chapterText(book, m.index) || '';
    const r = await ds.writePlotNote(book, m, text, config);
    if (r.ok) {
      store.setNote(book.id, m.index, { title: m.title, text: r.text });
      spent += r.cost;
      console.log('  第' + m.index + '章  ¥' + r.cost.toFixed(6) + '  累计 ¥' + spent.toFixed(4));
    } else {
      console.log('  第' + m.index + '章  失败: ' + r.error);
    }
  }
  console.log('');
  console.log('实际花费 ¥' + spent.toFixed(4));
}

async function main() {
  store.ensureDirs();
  const cmd = process.argv[2] || 'help';
  switch (cmd) {
    case 'books': cmdBooks(); break;
    case 'pending': cmdPending(); break;
    case 'docs': cmdDocs(); break;
    case 'doc': cmdDocs(process.argv[3]); break;
    case 'chapter': cmdChapter(process.argv[3], process.argv[4]); break;
    case 'note': cmdNote(process.argv[3], process.argv[4]); break;
    case 'reply': await cmdReply(process.argv[3], process.argv[4]); break;
    case 'note-gen': await cmdNoteGen(process.argv[3]); break;
    case 'ping': await cmdPing(); break;
    case 'serve': require('./server').start(); break;
    default:
      console.log(require('fs').readFileSync(__filename, 'utf8').split('*/')[0].split('/**')[1].replace(/^\n/, ''));
  }
}

main().catch((e) => {
  console.error(e && e.stack ? e.stack : e);
  process.exit(1);
});
