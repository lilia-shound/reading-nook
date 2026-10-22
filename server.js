'use strict';
/**
 * 共读小屋 - HTTP 服务
 * 零依赖，Node 标准库。
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');

const store = require('./lib/store');
const vfs = require('./lib/vfs');
const deepseek = require('./lib/deepseek');
const ai = require('./lib/ai');
const extract = require('./lib/extract');
const docs = require('./lib/docs');

let textMod = null;
try {
  textMod = require('./lib/text');
} catch (e) {
  console.error('[warn] lib/text.js not available, using built-in fallback splitter:', e.message);
}

const PUBLIC_DIR = path.join(__dirname, 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json'
};

// ------------------------------------------------------------ 登录限速

const attempts = new Map(); // ip -> { count, until }
const MAX_FAIL = 5;
const LOCK_MS = 30 * 60 * 1000;

function clientIp(req) {
  const raw = (req.socket && req.socket.remoteAddress) || 'unknown';
  return raw.replace(/^::ffff:/, '');
}

function isLocked(ip) {
  if (ip === '127.0.0.1' || ip === '::1') return false;
  const rec = attempts.get(ip);
  if (!rec) return false;
  if (rec.until && rec.until > Date.now()) return true;
  if (rec.until && rec.until <= Date.now()) attempts.delete(ip);
  return false;
}

function noteFail(ip) {
  if (ip === '127.0.0.1' || ip === '::1') return;
  const rec = attempts.get(ip) || { count: 0, until: 0 };
  rec.count += 1;
  if (rec.count >= MAX_FAIL) rec.until = Date.now() + LOCK_MS;
  attempts.set(ip, rec);
}

function clearFail(ip) {
  attempts.delete(ip);
}

// ------------------------------------------------------------ 工具函数

function sendJson(res, code, obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

function sendErr(res, code, message) {
  sendJson(res, code, { error: message });
}

function parseCookies(req) {
  const raw = req.headers.cookie || '';
  const out = {};
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

/**
 * 哪些章还没写剧情笔记、且值得写。
 * 默认跳过「版权 / 致谢 / 索引 / 译名对照表」这类没有剧情的章节 ——
 * 给它们写笔记既浪费钱（输入照样按整页算）又污染伴读 AI 的上下文。
 */
function pendingNoteMetas(book, config) {
  const skipNon = !config || config.skip_non_narrative !== false;
  const notes = book.notes || {};
  return (book.chapters || []).filter((m) =>
    !notes[String(m.index)] && (!skipNon || deepseek.isNarrativeChapter(m.title)));
}

function isAuthed(req, config) {
  const cookies = parseCookies(req);
  return cookies.rk === String(config.passcode);
}

function readBody(req, limitBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    const limit = limitBytes || 64 * 1024 * 1024;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('body-too-large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function readJsonBody(req) {
  return readBody(req, 8 * 1024 * 1024).then((buf) => {
    const raw = buf.toString('utf8').replace(/^\uFEFF/, '');
    if (!raw.trim()) return {};
    return JSON.parse(raw);
  });
}

function splitParagraphs(text) {
  const lines = String(text || '').split(/\r?\n/);
  const paras = [];
  for (let line of lines) {
    line = line.replace(/[ \t　]+$/g, '').trim();
    if (!line) continue;
    if (line.length > 500) {
      // 超长行按句末标点切，避免一页塞爆
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

function builtinSplit(text) {
  const lines = String(text || '').split(/\r?\n/);
  const re = /^\s*(第[0-9一二三四五六七八九十百千零〇两]+[章节回卷篇].{0,40})\s*$/;
  const idx = [];
  lines.forEach((l, i) => {
    if (re.test(l) && l.trim().length <= 60) idx.push(i);
  });
  if (idx.length < 3) {
    return {
      chapters: [{ index: 1, title: '全文', startLine: 0, endLine: lines.length - 1, charCount: String(text).length }],
      pattern: 'fallback-by-length',
      hitCount: 0
    };
  }
  const chapters = [];
  for (let i = 0; i < idx.length; i++) {
    const s = idx[i];
    const e = i + 1 < idx.length ? idx[i + 1] - 1 : lines.length - 1;
    chapters.push({
      index: i + 1,
      title: lines[s].trim(),
      startLine: s,
      endLine: e,
      charCount: lines.slice(s + 1, e + 1).join('\n').length
    });
  }
  return { chapters, pattern: 'builtin-cn-chapter', hitCount: idx.length };
}

function splitText(text) {
  if (textMod && typeof textMod.splitChapters === 'function') {
    try {
      return textMod.splitChapters(text);
    } catch (e) {
      console.error('[split] text.js failed, fallback:', e.message);
    }
  }
  return builtinSplit(text);
}

function chapterTextOf(book, chapterMeta) {
  const file = store.bookDir(book.id) + '/text.txt';
  let raw = '';
  try {
    raw = vfs.readFileSync(file);
  } catch (e) {
    return '';
  }
  const lines = raw.split(/\r?\n/);
  return lines.slice(chapterMeta.startLine, chapterMeta.endLine + 1).join('\n');
}

// ------------------------------------------------------------ 静态资源

function serveStatic(req, res, pathname) {
  let rel = pathname === '/' ? '/index.html' : pathname;
  rel = rel.replace(/\?.*$/, '');
  // site.json 决定前端走「本地 API」还是「GitHub 静态模式」。
  // 磁盘上那份写的是 static（那是 Pages 构建用的），本地跑的时候必须强制 local ——
  // 不然本机也会跑去读 GitHub 仓库。
  if (rel === '/site.json') {
    const body = Buffer.from(JSON.stringify({ mode: 'local' }), 'utf8');
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store'
    });
    res.end(body);
    return;
  }
  const file = path.join(PUBLIC_DIR, path.normalize(rel).replace(/^([/\\])+/, ''));
  if (!file.startsWith(PUBLIC_DIR)) return sendErr(res, 403, 'forbidden');
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('not found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache'
    });
    res.end(data);
  });
}

// ------------------------------------------------------------ 路由处理

async function handleApi(req, res, pathname, query) {
  const config = store.readConfig();
  const ip = clientIp(req);

  if (pathname === '/api/health') {
    return sendJson(res, 200, { ok: true, time: new Date().toISOString(), login_hint: config.login_hint });
  }

  if (pathname === '/api/login' && req.method === 'POST') {
    if (isLocked(ip)) return sendErr(res, 429, '尝试次数过多，请 30 分钟后再试');
    let body = {};
    try {
      body = await readJsonBody(req);
    } catch (e) {
      return sendErr(res, 400, 'bad body');
    }
    if (String(body.passcode) === String(config.passcode)) {
      clearFail(ip);
      res.setHeader(
        'Set-Cookie',
        'rk=' + encodeURIComponent(String(config.passcode)) + '; Path=/; Max-Age=31536000; HttpOnly; SameSite=Lax'
      );
      return sendJson(res, 200, {
        ok: true,
        user_name: config.user_name,
        ai_name: config.ai_name,
        subtitle: config.subtitle,
        login_hint: config.login_hint
      });
    }
    noteFail(ip);
    return sendErr(res, 401, '密码不对');
  }

  if (!isAuthed(req, config)) return sendErr(res, 401, 'unauthorized');

  // ---------------------------------------------------------- 书架

  if (pathname === '/api/library' && req.method === 'GET') {
    const books = store.listBooks().map((b) => {
      const p = store.getProgress(b.id);
      // 全书剩余章节生成剧情笔记的预估花费 —— 让她上传完就能看到"这本书要花多少"
      const pendingMetas = pendingNoteMetas(b, config);
      const allPending = (b.chapters || []).filter((m) => !(b.notes && b.notes[String(m.index)]));
      const est = deepseek.estimateNotesCost(b, pendingMetas, config);
      return {
        id: b.id,
        title: b.title,
        filename: b.filename,
        addedAt: b.addedAt,
        encoding: b.encoding,
        chapterCount: b.chapterCount,
        pattern: b.pattern,
        hasNotes: !!(b.notes && Object.keys(b.notes).length),
        noteCount: b.notes ? Object.keys(b.notes).length : 0,
        pendingNotes: pendingMetas.length,
        skippedNotes: allPending.length - pendingMetas.length,
        noteEstimate: {
          chapters: est.chapters,
          cost: Math.round(est.cost * 10000) / 10000,
          peak: est.peak
        },
        progress: p ? { chapter: p.chapter, ratio: p.ratio || 0, updatedAt: p.updatedAt } : null
      };
    });
    return sendJson(res, 200, { books, user_name: config.user_name, ai_name: config.ai_name });
  }

  if (pathname === '/api/books' && req.method === 'POST') {
    let buf;
    try {
      buf = await readBody(req, 256 * 1024 * 1024);
    } catch (e) {
      return sendErr(res, 413, '文件太大');
    }
    const rawName = req.headers['x-filename'] || 'book.txt';
    let filename = 'book.txt';
    try {
      filename = decodeURIComponent(String(rawName));
    } catch (e) {
      filename = String(rawName);
    }
    filename = path.basename(filename).replace(/[\\/:*?"<>|]/g, '_').slice(0, 120);

    // 统一入口：txt / epub / docx / fb2 都走这里
    const ex = extract.extractBook(buf, filename);
    if (!ex.ok) return sendErr(res, 400, ex.error || '这个文件读不了');

    const text = ex.text;
    if (!text || !text.trim()) return sendErr(res, 400, '文件是空的');

    const split = {
      chapters: ex.chapters,
      pattern: ex.pattern,
      hitCount: ex.hitCount
    };
    const id = store.id('b');
    vfs.writeFileSync(store.bookDir(id) + '/text.txt', text);

    const book = {
      id,
      title: ex.title || filename.replace(/\.[^.]+$/, ''),
      filename,
      addedAt: new Date().toISOString(),
      format: ex.format,
      encoding: ex.encoding,
      encodingConfidence: ex.confidence,
      chapterCount: split.chapters.length,
      pattern: split.pattern,
      hitCount: split.hitCount,
      chapters: split.chapters,
      notes: {}
    };
    store.saveBook(book);
    return sendJson(res, 200, { book: { id: book.id, title: book.title, chapterCount: book.chapterCount, format: book.format } });
  }

  const bookMatch = pathname.match(/^\/api\/books\/([^/]+)$/);
  if (bookMatch) {
    const book = store.getBook(decodeURIComponent(bookMatch[1]));
    if (!book) return sendErr(res, 404, 'book not found');
    if (req.method === 'GET') {
      return sendJson(res, 200, { book });
    }
    if (req.method === 'DELETE') {
      store.deleteBook(book.id);
      return sendJson(res, 200, { ok: true });
    }
  }

  const chMatch = pathname.match(/^\/api\/books\/([^/]+)\/chapter\/(\d+)$/);
  if (chMatch && req.method === 'GET') {
    const book = store.getBook(decodeURIComponent(chMatch[1]));
    if (!book) return sendErr(res, 404, 'book not found');
    const chapter = Number(chMatch[2]);
    const meta = (book.chapters || []).find((c) => c.index === chapter);
    if (!meta) return sendErr(res, 404, 'chapter not found');
    const text = chapterTextOf(book, meta);
    return sendJson(res, 200, {
      index: chapter,
      title: meta.title,
      paragraphs: splitParagraphs(text),
      totalChapters: book.chapterCount
    });
  }

  const noteMatch = pathname.match(/^\/api\/books\/([^/]+)\/notes\/(\d+)$/);
  if (noteMatch && req.method === 'GET') {
    const book = store.getBook(decodeURIComponent(noteMatch[1]));
    if (!book) return sendErr(res, 404, 'book not found');
    const chapter = Number(noteMatch[2]);
    const meta = (book.chapters || []).find((c) => c.index === chapter);
    const text = store.getNote(book.id, chapter);
    if (!text) return sendErr(res, 404, 'note not found');
    return sendJson(res, 200, { chapter, title: meta ? meta.title : '', text });
  }

  const annoMatch = pathname.match(/^\/api\/books\/([^/]+)\/annotations\/(\d+)$/);
  if (annoMatch) {
    const book = store.getBook(decodeURIComponent(annoMatch[1]));
    if (!book) return sendErr(res, 404, 'book not found');
    const chapter = Number(annoMatch[2]);
    if (req.method === 'GET') {
      return sendJson(res, 200, { annotations: store.getAnnotations(book.id, chapter) });
    }
    if (req.method === 'POST') {
      let body = {};
      try {
        body = await readJsonBody(req);
      } catch (e) {
        return sendErr(res, 400, 'bad body');
      }
      if (!body.anchor && !body.note) return sendErr(res, 400, 'nothing to save');
      const item = store.addAnnotation(book.id, chapter, body);
      return sendJson(res, 200, { annotation: item });
    }
  }

  const progMatch = pathname.match(/^\/api\/books\/([^/]+)\/progress$/);
  if (progMatch) {
    const book = store.getBook(decodeURIComponent(progMatch[1]));
    if (!book) return sendErr(res, 404, 'book not found');
    if (req.method === 'GET') {
      return sendJson(res, 200, { progress: store.getProgress(book.id) });
    }
    if (req.method === 'POST') {
      let body = {};
      try {
        body = await readJsonBody(req);
      } catch (e) {
        return sendErr(res, 400, 'bad body');
      }
      return sendJson(res, 200, { progress: store.setProgress(book.id, body) });
    }
  }

  const reSplitMatch = pathname.match(/^\/api\/books\/([^/]+)\/resplit$/);
  if (reSplitMatch && req.method === 'POST') {
    const book = store.getBook(decodeURIComponent(reSplitMatch[1]));
    if (!book) return sendErr(res, 404, 'book not found');
    if (!(config.deepseek_api_key || '').trim()) {
      return sendJson(res, 200, { ok: false, error: 'no-deepseek-key', tried: 0 });
    }
    const file = store.bookDir(book.id) + '/text.txt';
    const text = vfs.readFileSync(file);
    const suspect = textMod && textMod.findSuspectHeadings ? textMod.findSuspectHeadings(text) : [];
    const res = await deepseek.splitChaptersWithAI(text, suspect, config);
    if (!res.ok) {
      return sendJson(res, 200, { ok: false, error: res.error, tried: suspect.length });
    }
    const lines = text.split(/\r?\n/);
    const chapters = res.chapters.map((ln, i) => {
      const start = ln;
      const end = i + 1 < res.chapters.length ? res.chapters[i + 1] - 1 : lines.length - 1;
      return {
        index: i + 1,
        title: lines[start] ? lines[start].trim() : '第 ' + (i + 1) + ' 章',
        startLine: start,
        endLine: end,
        charCount: lines.slice(start + 1, end + 1).join('\n').length
      };
    });
    book.chapters = chapters;
    book.chapterCount = chapters.length;
    book.pattern = 'ai-split';
    store.saveBook(book);
    return sendJson(res, 200, { ok: true, chapterCount: chapters.length });
  }

  // ---------------------------------------------------------- 资料库
  // 伴读 AI 可读的文档（不属于任何一本书的那些：全书脉络、设计说明、约定）
  if (pathname === '/api/docs' && req.method === 'GET') {
    return sendJson(res, 200, { docs: docs.listDocs() });
  }

  if (pathname.startsWith('/api/docs/') && req.method === 'GET') {
    const id = decodeURIComponent(pathname.slice('/api/docs/'.length));
    const d = docs.readDoc(id);
    if (!d) return sendErr(res, 404, 'doc not found: ' + id);
    return sendJson(res, 200, d);
  }

  // ---------------------------------------------------------- 批注 / AI

  if (pathname === '/api/pending' && req.method === 'GET') {
    // 给伴读 AI 补上两样东西：
    //   context  —— 她划的那句**前后 400 字**（光有 anchor 看不见上下文）
    //   plotNote —— 这一章的剧情笔记（能一眼想起这一章发生了什么）
    // （CLI 的 `nook.js pending` 一直有这两样，HTTP 这边以前漏了）
    const items = store.pendingItems().map((it) => {
      const out = Object.assign({}, it);
      const book = store.getBook(it.bookId);
      if (!book) return out;
      const meta = (book.chapters || []).find((c) => c.index === it.chapter);
      if (meta && it.anchor) {
        const body = chapterTextOf(book, meta) || '';
        const pos = body.indexOf(it.anchor);
        if (pos >= 0) {
          const from = Math.max(0, pos - 400);
          const to = Math.min(body.length, pos + it.anchor.length + 400);
          out.context = body.slice(from, to).replace(/\n+/g, ' ');
        }
      }
      const note = store.getNote(it.bookId, it.chapter);
      if (note) out.plotNote = note;
      return out;
    });
    return sendJson(res, 200, { items: items });
  }

  // 「有没有新动静」—— 页面靠它知道姜去已经回过批注了，于是自动刷新出蓝色气泡
  if (pathname === '/api/ping' && req.method === 'GET') {
    return sendJson(res, 200, { ts: store.readActivity(), pending: store.pendingItems().length });
  }

  if (pathname === '/api/ai/reply' && req.method === 'POST') {
    let body = {};
    try {
      body = await readJsonBody(req);
    } catch (e) {
      return sendErr(res, 400, 'bad body');
    }
    if (!body.bookId || !body.chapter || !body.text) return sendErr(res, 400, 'bookId/chapter/text required');
    const saved = store.addReply(body.bookId, Number(body.chapter), body.text, body.anchorId);
    if (!saved) return sendErr(res, 404, 'annotation not found');
    return sendJson(res, 200, { ok: true, saved });
  }

  if (pathname === '/api/ai/auto' && req.method === 'POST') {
    let body = {};
    try {
      body = await readJsonBody(req);
    } catch (e) {
      return sendErr(res, 400, 'bad body');
    }
    if (!body.bookId || !body.chapter) return sendErr(res, 400, 'bookId/chapter required');
    const r = await ai.autoReply({ bookId: body.bookId, chapter: Number(body.chapter), annotationId: body.annotationId });
    if (!r.ok) return sendJson(res, 200, { ok: false, error: r.error, hint: r.hint });
    return sendJson(res, 200, { ok: true, text: r.text });
  }

  if (pathname === '/api/ai/endpoint' && req.method === 'GET') {
    const ep = ai.resolveEndpoint(config);
    return sendJson(res, 200, {
      mode: config.ai_mode || 'manual',
      hasBase: !!ep.base,
      hasKey: !!ep.key,
      model: ep.model,
      base: ep.base
    });
  }

  // ---------------------------------------------------------- 工作台

  if (pathname === '/api/workbench' && req.method === 'GET') {
    const wb = store.workbenchStats();
    return sendJson(res, 200, {
      stats: wb.stats,
      logs: wb.logs,
      pricing: {
        model: config.deepseek_model,
        table: deepseek.pricingTable(config),
        nowIsPeak: deepseek.isPeakTime(new Date())
      },
      books: store.listBooks().map((b) => {
        const pendingMetas = pendingNoteMetas(b, config);
        const allPending = (b.chapters || []).filter((m) => !(b.notes && b.notes[String(m.index)]));
        const est = deepseek.estimateNotesCost(b, pendingMetas, config);
        return {
          id: b.id,
          title: b.title,
          chapterCount: b.chapterCount,
          noteCount: b.notes ? Object.keys(b.notes).length : 0,
          pendingNotes: pendingMetas.length,
          skippedNotes: allPending.length - pendingMetas.length,
          noteEstimate: {
            chapters: est.chapters,
            cost: Math.round(est.cost * 10000) / 10000,
            peak: est.peak
          }
        };
      })
    });
  }

  if (pathname === '/api/tasks/notes' && req.method === 'POST') {
    let body = {};
    try {
      body = await readJsonBody(req);
    } catch (e) {
      return sendErr(res, 400, 'bad body');
    }
    const book = store.getBook(body.bookId);
    if (!book) return sendErr(res, 404, 'book not found');
    if (!(config.deepseek_api_key || '').trim()) {
      return sendJson(res, 200, { ok: false, error: 'no-deepseek-key' });
    }
    const startCh = Number(body.fromChapter || 1);
    const endCh = Number(body.toChapter || book.chapterCount);
    // 预算上限（元）。给了就当硬闸门：预估超了就少排几章，跑到额度用完就停。
    const maxCost = body.maxCost != null && Number(body.maxCost) > 0 ? Number(body.maxCost) : null;

    const pending = pendingNoteMetas(book, config).filter((m) => m.index >= startCh && m.index <= endCh);
    const allInRange = (book.chapters || []).filter((m) =>
      m.index >= startCh && m.index <= endCh && !(book.notes && book.notes[String(m.index)]));
    const skippedByKind = allInRange.length - pending.length;

    // 按章节顺序逐章预估，累计到超预算就停 —— 保证「花不完就停」，而不是先花超了再说
    const planned = [];
    let estimated = 0;
    for (const m of pending) {
      const e = deepseek.estimateNotesCost(book, [m], config);
      if (maxCost != null && estimated + e.cost > maxCost) break;
      estimated += e.cost;
      planned.push(m);
    }
    const skipped = pending.length - planned.length;

    // 后台跑，立刻返回
    (async () => {
      let spent = 0;
      for (const meta of planned) {
        if (maxCost != null && spent >= maxCost) break;
        const text = chapterTextOf(book, meta);
        const r = await deepseek.writePlotNote(book, meta, text, config);
        if (r.ok) {
          store.setNote(book.id, meta.index, { title: meta.title, text: r.text });
          spent += r.cost;
        }
      }
    })();
    return sendJson(res, 200, {
      ok: true,
      started: true,
      planned: planned.length,
      skipped: skipped,
      skippedByKind: skippedByKind,
      estimated: Math.round(estimated * 10000) / 10000,
      maxCost: maxCost,
      pendingTotal: pending.length
    });
  }

  if (pathname === '/api/formats' && req.method === 'GET') {
    return sendJson(res, 200, { formats: extract.SUPPORTED_FORMATS });
  }

  if (pathname === '/api/settings' && req.method === 'GET') {
    return sendJson(res, 200, {
      passcode: config.passcode,
      port: config.port,
      subtitle: config.subtitle,
      login_hint: config.login_hint,
      user_name: config.user_name,
      ai_name: config.ai_name,
      ai_mode: config.ai_mode,
      deepseek_model: config.deepseek_model || 'deepseek-flash',
      hasDeepseekKey: !!(config.deepseek_api_key || '').trim()
    });
  }

  if (pathname === '/api/settings' && req.method === 'POST') {
    let body = {};
    try {
      body = await readJsonBody(req);
    } catch (e) {
      return sendErr(res, 400, 'bad body');
    }
    const allowed = ['passcode', 'port', 'subtitle', 'login_hint', 'user_name', 'ai_name', 'ai_mode', 'deepseek_api_key', 'deepseek_model', 'deepseek_pricing', 'ai_base_url', 'ai_api_key', 'ai_model'];
    const patch = {};
    for (const k of allowed) if (body[k] !== undefined) patch[k] = body[k];
    const next = store.writeConfig(patch);
    return sendJson(res, 200, { ok: true, settings: { passcode: next.passcode, subtitle: next.subtitle } });
  }

  return sendErr(res, 404, 'no such api');
}

// ------------------------------------------------------------ 启动

function createServer() {
  return http.createServer(async (req, res) => {
    const parsed = url.parse(req.url, true);
    const pathname = decodeURIComponent(parsed.pathname);
    try {
      if (pathname.startsWith('/api/')) {
        await handleApi(req, res, pathname, parsed.query);
      } else {
        serveStatic(req, res, pathname);
      }
    } catch (e) {
      console.error('[error]', req.method, pathname, e);
      if (!res.headersSent) sendErr(res, 500, String((e && e.message) || e));
      else res.end();
    }
  });
}

function start() {
  store.ensureDirs();
  const config = store.readConfig();
  const port = Number(process.env.PORT || config.port || 8123);
  const server = createServer();
  server.listen(port, '0.0.0.0', () => {
    const nets = require('os').networkInterfaces();
    const lan = [];
    for (const name of Object.keys(nets)) {
      for (const n of nets[name] || []) {
        if (n.family === 'IPv4' && !n.internal) lan.push(n.address);
      }
    }
    console.log('');
    console.log('  📖  共读小屋已启动');
    console.log('  ─────────────────────────────────');
    console.log('  本机:   http://127.0.0.1:' + port);
    for (const ip of lan) console.log('  局域网: http://' + ip + ':' + port + '   ← iPad / 手机用这个');
    console.log('  密码:   ' + config.passcode + '  (' + config.login_hint + ')');
    console.log('  模式:   ' + (config.ai_mode || 'manual'));
    console.log('  ─────────────────────────────────');
    console.log('');
  });
  return server;
}

if (require.main === module) start();

module.exports = { createServer, start, splitParagraphs, splitText };
