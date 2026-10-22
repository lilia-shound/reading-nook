'use strict';
/**
 * 共读小屋 · 给云端姜去用的命令行工具
 *
 * 她 clone 仓库就能用，零依赖：
 *
 *   node tools/gh-store.js list  --pass 06090823
 *   node tools/gh-store.js read  --book <bookId> --chapter <n> --pass 06090823
 *   node tools/gh-store.js notes --book <bookId> --chapter <n> --pass 06090823
 *   node tools/gh-store.js reply --book <bookId> --chapter <n> --anno <annoId> --file reply.txt --pass 06090823
 *   node tools/gh-store.js docs --pass 06090823
 *
 * 规矩：
 *   · token **只从 GH_TOKEN 环境变量读**。命令行里写 token 是错的做法，这里直接拒。
 *   · 密码用 --pass 给（或者 NOOK_PASSCODE 环境变量），只用来派生密钥，不落盘。
 *   · 回应用 --file 指一个本地文件（中文和引号在 PowerShell 里会被搞坏，
 *     所以正文一律走文件，不要在命令行拼字符串）。
 *   · reply 传了 --anno 就**精确挂到那一条**下；找不到就报错。
 *     （本地版 addReply 传错 id 会静默回错地方，这个坑不踩。）
 */

const fs = require('fs');
const path = require('path');

// ------------------------------------------------------------ 小工具

/** 极简 front-matter 解析（跟 lib/docs.js 一个口径）：只认 key: value 和 key: [a, b] */
function parseFrontMatter(text) {
  const meta = {};
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!m) return { meta: meta, body: text };
  m[1].split(/\r?\n/).forEach((line) => {
    const kv = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line.trim());
    if (!kv) return;
    let v = kv[2].trim();
    if (v.startsWith('[') && v.endsWith(']')) {
      v = v.slice(1, -1).split(',').map((x) => x.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
    } else {
      v = v.replace(/^["']|["']$/g, '');
    }
    meta[kv[1]] = v;
  });
  return { meta: meta, body: text.slice(m[0].length) };
}

/** 切段：跟 server.js 的 splitParagraphs 一个口径（批注的段号要对得上） */
function splitParagraphs(text) {
  const lines = String(text || '').split(/\r?\n/);
  const paras = [];
  for (let line of lines) {
    line = line.replace(/[ \t　]+$/g, '').trim();
    if (!line) continue;
    if (line.length > 500) {
      const pieces = line.split(/(?<=[。！？…；])/);
      let buf = '';
      for (const p of pieces) {
        if ((buf + p).length > 320 && buf) {
          paras.push(buf);
          buf = '';
        }
        buf += p;
      }
      if (buf) paras.push(buf);
    } else {
      paras.push(line);
    }
  }
  return paras;
}

function out(text) {
  process.stdout.write(String(text));
}

function outLine(text) {
  process.stdout.write(String(text) + '\n');
}

function fail(message, code) {
  process.stderr.write('失败：' + message + '\n');
  process.exitCode = code || 1;
  throw new ExitSignal();
}

class ExitSignal extends Error {}

// ------------------------------------------------------------ 核心

/**
 * 所有命令都挂在 store 上，backend 可以换（测试里换成假的）。
 * 默认 backend 就是 lib/ghbackend —— 底下是 GitHub 仓库，读到的是明文。
 */
function createStore(backend) {
  const be = backend || require('../lib/ghbackend');

  /**
   * 读一个 JSON 文件。
   *   · 文件不在 → 用 fallback（跟 fs 一个脾气）
   *   · 文件坏得不是 JSON → 也用 fallback（跟本地版 lib/store.js 一个脾气，不因为一个坏文件就全瘫）
   *   · 别的错（密码不对、连不上 GitHub）→ 往外冒，闷掉的话就变成「啥也没有」，最难查
   */
  function readJson(rel, fallback) {
    let raw;
    try {
      raw = be.readFileSync(rel).replace(/^\uFEFF/, '');
    } catch (e) {
      if (e && e.code === 'ENOENT') return fallback;
      throw e;
    }
    if (!raw.trim()) return fallback;
    try {
      return JSON.parse(raw);
    } catch (e) {
      return fallback;
    }
  }

  function annoRel(bookId, chapter) {
    return 'books/' + bookId + '/annotations/' + String(chapter) + '.json';
  }

  function noteRel(bookId, chapter) {
    return 'books/' + bookId + '/notes/' + String(chapter) + '.md';
  }

  /** 书架 */
  function listBooks() {
    const lib = readJson('library.json', []);
    return Array.isArray(lib) ? lib : [];
  }

  /** 我划了线、还没人回的批注（姜去干活儿的入口） */
  function listPending() {
    const items = [];
    for (const book of listBooks()) {
      // 目录不存在就是没有批注（readdirSync 自己返回 []）
      // 但密码不对、网络不通这种错要往外冒 —— 闷掉的话就变成「啥也没有」，最难查
      const files = be.readdirSync('books/' + book.id + '/annotations');
      for (const f of files) {
        if (!f.endsWith('.json')) continue;
        const chapter = Number(f.replace(/\.json$/, ''));
        if (Number.isNaN(chapter)) continue;
        const list = readJson('books/' + book.id + '/annotations/' + f, []);
        if (!Array.isArray(list)) continue;
        for (const a of list) {
          if (a.who !== 'user') continue;
          if (a.replies && a.replies.length) continue;
          items.push({
            bookId: book.id,
            bookTitle: book.title,
            chapter: chapter,
            annotationId: a.id,
            anchor: a.anchor || '',
            note: a.note || '',
            ts: a.ts || ''
          });
        }
      }
    }
    items.sort((x, y) => String(x.ts).localeCompare(String(y.ts)));
    return items;
  }

  /** 某一章的正文（按段编号，跟她划线时的段号一致） */
  function readChapter(bookId, chapter) {
    const book = readJson('books/' + bookId + '/book.json', null);
    if (!book) throw new Error('找不到这本书：' + bookId);
    const meta = (book.chapters || []).find((c) => Number(c.index) === Number(chapter));
    if (!meta) throw new Error('这本书里没有第 ' + chapter + ' 章');

    const raw = be.readFileSync('books/' + bookId + '/text.txt');
    const lines = raw.split(/\r?\n/);
    const text = lines.slice(meta.startLine, meta.endLine + 1).join('\n');
    return {
      index: Number(meta.index),
      title: meta.title || ('第 ' + chapter + ' 章'),
      totalChapters: book.chapterCount || (book.chapters || []).length,
      paragraphs: splitParagraphs(text)
    };
  }

  /** 某一章的剧情笔记 */
  function readNotes(bookId, chapter) {
    const raw = be.readFileSync(noteRel(bookId, chapter));
    return raw.replace(/^# .*\n+/, '').trim();
  }

  /**
   * 挂一条回应。
   *
   * 和 lib/store.js 的 addReply 同一个形状（{who:'ai', text, ts}），
   * 但**传错 annoId 会报错**，不会静默挂到别的地方去。
   */
  function reply(bookId, chapter, annoId, text) {
    const rel = annoRel(bookId, chapter);
    let list;
    try {
      list = readJson(rel, null);
    } catch (e) {
      if (e && e.code === 'ENOENT') throw new Error('这一章还没有批注（' + rel + ' 不存在）');
      throw e;
    }
    if (!Array.isArray(list) || !list.length) {
      throw new Error('这一章还没有批注，回不了（' + rel + ' 不存在，或者是空的）');
    }

    let target = null;
    if (annoId) {
      target = list.find((a) => a && a.id === annoId);
      if (!target) {
        throw new Error('找不到这条批注：' + annoId
          + '（这一章有 ' + list.length + ' 条批注，id 是：'
          + list.map((a) => a && a.id).filter(Boolean).join('、')
          + '）—— 没有挂到任何地方');
      }
    } else {
      target = list.find((a) => a && (!a.replies || !a.replies.length));
      if (!target) target = list[list.length - 1];
    }

    if (!target) throw new Error('这一章还没有批注，回不了');
    if (!target.replies) target.replies = [];
    const item = {
      who: 'ai',
      text: String(text == null ? '' : text).replace(/\r?\n$/, ''),
      ts: new Date().toISOString()
    };
    target.replies.push(item);

    be.writeFileSync(rel, JSON.stringify(list, null, 2));
    return { annotationId: target.id, reply: item };
  }

  /** 资料库 */
  function listDocs() {
    const files = be.readdirSync('docs');
    const outDocs = [];
    for (const f of files) {
      if (!f.endsWith('.md')) continue;
      const raw = be.readFileSync('docs/' + f); // 解不开就让错冒出来，别闷成「0 篇」
      const parsed = parseFrontMatter(raw);
      const meta = parsed.meta;
      outDocs.push({
        id: f.replace(/\.md$/, ''),
        file: f,
        title: meta.title || f.replace(/\.md$/, ''),
        summary: meta.summary || '',
        tags: Array.isArray(meta.tags) ? meta.tags : (meta.tags ? [meta.tags] : []),
        chars: parsed.body.length
      });
    }
    outDocs.sort((a, b) => a.title.localeCompare(b.title, 'zh'));
    return outDocs;
  }

  /** 读一篇资料库文档的正文 */
  function readDoc(id) {
    const safe = String(id).replace(/[^A-Za-z0-9._-]/g, '');
    if (!safe) throw new Error('文档 id 不对：' + id);
    const raw = be.readFileSync('docs/' + safe + '.md');
    const parsed = parseFrontMatter(raw);
    return {
      id: safe,
      title: parsed.meta.title || safe,
      summary: parsed.meta.summary || '',
      tags: Array.isArray(parsed.meta.tags) ? parsed.meta.tags : (parsed.meta.tags ? [parsed.meta.tags] : []),
      body: parsed.body.trim()
    };
  }

  return {
    backend: be,
    listBooks: listBooks,
    listPending: listPending,
    readChapter: readChapter,
    readNotes: readNotes,
    reply: reply,
    listDocs: listDocs,
    readDoc: readDoc
  };
}

// ------------------------------------------------------------ 命令行

function parseArgs(argv) {
  const args = argv.slice();
  const cmd = args.shift();
  const flags = {};
  const rest = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) {
      const k = args[i].slice(2);
      if (i + 1 < args.length && !args[i + 1].startsWith('--')) flags[k] = args[++i];
      else flags[k] = true;
    } else {
      rest.push(args[i]);
    }
  }
  return { cmd: cmd, flags: flags, rest: rest };
}

const HELP = [
  '共读小屋 · 仓库存取工具（云端姜去用）',
  '',
  '  list  --pass <密码>',
  '  read  --book <bookId> --chapter <n> --pass <密码>',
  '  notes --book <bookId> --chapter <n> --pass <密码>',
  '  reply --book <bookId> --chapter <n> --anno <annoId> --file <正文文件> --pass <密码>',
  '  docs --pass <密码>',
  '',
  'token 只从环境变量 GH_TOKEN 读，不要写在命令行里。',
  '正文走 --file 文件（中文和引号在 PowerShell 里会被搞坏）。'
].join('\n');

/** Windows 旧终端（PowerShell 5.1 + 936 之类的代码页）会把 UTF-8 中文显示成乱码，提醒一句 */
function warnCodePage() {
  if (process.platform !== 'win32') return;
  if (!process.stdout.isTTY) return;
  try {
    const { spawnSync } = require('child_process');
    const r = spawnSync('chcp', [], { encoding: 'utf8' });
    const m = /(\d{3,5})/.exec(String((r && r.stdout) || ''));
    const cp = m ? Number(m[1]) : null;
    if (cp && cp !== 65001) {
      process.stderr.write('tip: chcp 65001   # 让中文正常显示\n');
    }
  } catch (e) {
    /* 不影响正事 */
  }
}

function main(argv) {
  const parsed = parseArgs(argv || process.argv.slice(2));
  const cmd = parsed.cmd;
  const flags = parsed.flags;

  if (flags.token) {
    fail('token 不能写在命令行里（会留在命令历史里）。请用环境变量：set GH_TOKEN=xxx', 2);
  }
  if (flags.pass) {
    // 只用来派生密钥，进程结束就没了，不落盘
    process.env.NOOK_PASSCODE = String(flags.pass);
  }
  if (!process.env.NOOK_PASSCODE && !process.env.GH_TOKEN) {
    // 两个都可能来自 data/.local.json，不急着报错
  }

  const store = createStore();
  warnCodePage();

  if (!cmd || cmd === 'help' || flags.help) {
    outLine(HELP);
    return;
  }

  if (cmd === 'list') {
    const books = store.listBooks();
    const pending = store.listPending();
    outLine('书架（' + books.length + ' 本）');
    outLine('');
    for (const b of books) {
      outLine('《' + (b.title || b.id) + '》  ' + b.id + '  ' + (b.chapterCount || 0) + ' 章');
    }
    outLine('');
    outLine('等我回的地方（' + pending.length + ' 条）');
    for (const p of pending) {
      outLine('  · 《' + p.bookTitle + '》 第' + p.chapter + '章  ' + p.annotationId);
      if (p.anchor) outLine('      划线：' + p.anchor);
      if (p.note) outLine('      她说：' + p.note);
    }
    return;
  }

  if (cmd === 'read') {
    const bookId = String(flags.book || '');
    const chapter = Number(flags.chapter);
    if (!bookId || !Number.isFinite(chapter)) fail('用法: read --book <bookId> --chapter <n>', 2);
    const ch = store.readChapter(bookId, chapter);
    outLine(ch.title + '（第 ' + ch.index + ' / ' + ch.totalChapters + ' 章）');
    outLine('');
    ch.paragraphs.forEach((p, i) => {
      outLine('[' + (i + 1) + '] ' + p);
    });
    return;
  }

  if (cmd === 'notes') {
    const bookId = String(flags.book || '');
    const chapter = Number(flags.chapter);
    if (!bookId || !Number.isFinite(chapter)) fail('用法: notes --book <bookId> --chapter <n>', 2);
    const text = store.readNotes(bookId, chapter);
    if (!text) {
      outLine('（这一章还没有剧情笔记）');
      return;
    }
    outLine(text);
    return;
  }

  if (cmd === 'reply') {
    const bookId = String(flags.book || '');
    const chapter = Number(flags.chapter);
    const annoId = String(flags.anno || '');
    const file = String(flags.file || '');
    if (!bookId || !Number.isFinite(chapter)) fail('用法: reply --book <bookId> --chapter <n> --anno <annoId> --file <文件>', 2);
    if (!annoId) fail('要写 --anno（挂到哪一条批注下面）。不写的话没法保证挂对地方。', 2);
    if (!file) fail('正文要放在文件里，用 --file 指出来（中文和引号在命令行里会被搞坏）。', 2);

    let text = '';
    try {
      text = fs.readFileSync(path.resolve(file), 'utf8');
    } catch (e) {
      fail('读不到正文文件 ' + file + '：' + e.message, 2);
    }
    if (!text.trim()) fail('正文文件是空的：' + file, 2);

    const res = store.reply(bookId, chapter, annoId, text);
    outLine('已挂在 ' + res.annotationId + ' 下面。');
    return;
  }

  if (cmd === 'docs') {
    const docs = store.listDocs();
    outLine('资料库（' + docs.length + ' 篇）');
    outLine('');
    for (const d of docs) {
      outLine('· ' + d.id + '  ' + d.title + (d.summary ? '  —— ' + d.summary : '') + '  (' + d.chars + ' 字)');
      if (d.tags.length) outLine('    标签：' + d.tags.join('、'));
    }
    return;
  }

  fail('不会的命令：' + cmd + '\n' + HELP, 2);
}

if (require.main === module) {
  try {
    main(process.argv.slice(2));
  } catch (e) {
    if (e instanceof ExitSignal) {
      process.exit(process.exitCode || 1);
    }
    process.stderr.write('失败：' + ((e && e.message) ? e.message : String(e)) + '\n');
    process.exit(1);
  }
}

module.exports = {
  createStore: createStore,
  main: main,
  parseArgs: parseArgs,
  splitParagraphs: splitParagraphs,
  parseFrontMatter: parseFrontMatter
};
