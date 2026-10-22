'use strict';
/**
 * 共读小屋 - 数据层
 * 纯 Node 标准库，零依赖。所有数据以 JSON 文件存放在 data/ 下。
 *
 * 【2026-10-22】数据层改成走 vfs：
 *   以前是直接摸 fs，路径是绝对路径。
 *   现在一律用**相对 data/ 的 POSIX 路径**（正斜杠），由 vfs 决定落到磁盘还是 GitHub 仓库。
 *   两个原因：
 *     1. Windows 的 path.join 会翻成反斜杠，GitHub API 不认；
 *     2. 仓库要当唯一事实来源（手机/电脑/云端姜去看的必须是同一份），
 *        换后端时同一个 rel 得能指向另一个地方。
 */

const path = require('path');
const vfs = require('./vfs');

const ROOT = path.resolve(__dirname, '..');
const DATA = path.join(ROOT, 'data');

// 相对 data/ 的 POSIX 路径。不用 path.join —— 会翻成反斜杠。
const BOOKS = 'books';
const LOGS = 'logs';
const CONFIG_FILE = 'config.json';
const LIBRARY_FILE = 'library.json';
const DEEPSEEK_LOG = 'logs/deepseek.json';
const ACTIVITY_FILE = 'activity.json';

const DEFAULT_CONFIG = {
  passcode: '06090823',
  port: 8231,
  subtitle: '姜来 & 姜去',
  login_hint: '两个人的生日相加',
  user_name: '姜来',
  ai_name: '姜去',
  deepseek_api_key: '',
  ai_mode: 'manual',
  ai_base_url: '',
  ai_api_key: '',
  ai_model: '',
  deepseek_model: 'deepseek-flash',
  // 剧情笔记发给帮工的正文上限（字符）。成本大头在输入，调小就省钱，
  // 代价是超长章节后半段会丢。0 表示用内置默认 12000。
  deepseek_note_max_chars: 12000,
  // 跳过「版权 / 致谢 / 索引 / 译名对照表」这类没有剧情的章节，不给它们写剧情笔记。
  skip_non_narrative: true,
  // DeepSeek 计价：单位 元/百万token，峰谷两档 × 缓存命中/未命中。
  // 官方价会变，改这里即可对账（工作台显示的是按这套价算出来的估算）。
  deepseek_pricing: {}
};

function ensureDirs() {
  for (const d of ['.', BOOKS, LOGS]) {
    try {
      vfs.mkdirSync(d);
    } catch (e) { /* ignore */ }
  }
}

function readJson(rel, fallback) {
  try {
    const raw = vfs.readFileSync(rel).replace(/^\uFEFF/, '');
    if (!raw.trim()) return fallback;
    return JSON.parse(raw);
  } catch (e) {
    return fallback;
  }
}

function writeJson(rel, value) {
  ensureDirs();
  vfs.writeFileSync(rel, JSON.stringify(value, null, 2));
}

// 仓库是公开的 —— 这些字段永远不能进仓库
const SECRET_KEYS = ['passcode', 'deepseek_api_key', 'ai_api_key'];

function readConfig() {
  ensureDirs();
  const cfg = readJson(CONFIG_FILE, null);
  if (!cfg) {
    writeJson(CONFIG_FILE, DEFAULT_CONFIG);
    return Object.assign({}, DEFAULT_CONFIG);
  }
  const merged = Object.assign({}, DEFAULT_CONFIG, cfg);
  // GitHub 后端下，仓库里的 config.json 是**去掉密钥的版本**。
  // 真密钥只留在本机的 data/.local.json（那个文件永远不推仓库）。
  const local = vfs.readLocalConfig();
  if (local && local.secrets) {
    for (const k of Object.keys(local.secrets)) merged[k] = local.secrets[k];
  }
  return merged;
}

function writeConfig(patch) {
  const cur = readConfig();
  const next = Object.assign({}, cur, patch || {});
  // 往 GitHub 仓库写配置时，密钥要摘掉。
  const out = Object.assign({}, next);
  if (vfs.name === 'github') {
    for (const k of SECRET_KEYS) delete out[k];
  }
  writeJson(CONFIG_FILE, out);
  return next;
}

function id(prefix) {
  return prefix + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function bookDir(bookId) {
  return BOOKS + '/' + bookId;
}
function annoDir(bookId) {
  return bookDir(bookId) + '/annotations';
}
function notesDir(bookId) {
  return bookDir(bookId) + '/notes';
}

// ---------------------------------------------------------------- books

function listBooks() {
  ensureDirs();
  const lib = readJson(LIBRARY_FILE, []);
  return Array.isArray(lib) ? lib : [];
}

function saveLibrary(list) {
  writeJson(LIBRARY_FILE, list);
}

function getBook(bookId) {
  const list = listBooks();
  return list.find((b) => b.id === bookId) || null;
}

function saveBook(book) {
  const list = listBooks();
  const i = list.findIndex((b) => b.id === book.id);
  if (i >= 0) list[i] = book;
  else list.push(book);
  saveLibrary(list);
  writeJson(bookDir(book.id) + '/book.json', book);
  return book;
}

function deleteBook(bookId) {
  try {
    vfs.rmSync(bookDir(bookId), { recursive: true });
  } catch (e) {
    /* ignore */
  }
  saveLibrary(listBooks().filter((b) => b.id !== bookId));
}

// ---------------------------------------------------------- annotations

function annotationFile(bookId, chapter) {
  return annoDir(bookId) + '/' + String(chapter) + '.json';
}

function getAnnotations(bookId, chapter) {
  return readJson(annotationFile(bookId, chapter), []);
}

function saveAnnotations(bookId, chapter, list) {
  writeJson(annotationFile(bookId, chapter), list);
}

function addAnnotation(bookId, chapter, payload) {
  const list = getAnnotations(bookId, chapter);
  const item = {
    id: id('a'),
    anchor: String(payload.anchor || ''),
    note: String(payload.note || ''),
    who: 'user',
    paraIndex: Number.isFinite(Number(payload.paraIndex)) ? Number(payload.paraIndex) : -1,
    ts: new Date().toISOString(),
    replies: []
  };
  list.push(item);
  saveAnnotations(bookId, chapter, list);
  touchActivity();
  return item;
}

/**
 * 追加一条 AI 回应。
 * - 有 anchorId → 挂到该条批注下
 * - 无 anchorId → 挂到最近一条还没有回应的批注
 */
function addReply(bookId, chapter, text, anchorId) {
  const list = getAnnotations(bookId, chapter);
  if (!list.length) return null;
  let target = null;
  if (anchorId) target = list.find((a) => a.id === anchorId);
  if (!target) target = list.find((a) => !a.replies || !a.replies.length);
  if (!target) target = list[list.length - 1];
  if (!target.replies) target.replies = [];
  const reply = {
    who: 'ai',
    text: String(text || ''),
    ts: new Date().toISOString()
  };
  target.replies.push(reply);
  saveAnnotations(bookId, chapter, list);
  touchActivity();
  return { annotationId: target.id, reply: reply };
}

// ------------------------------------------------------------- activity
// 「有没有新动静」的时间戳。页面轮询它，变了就重新拉章节 ——
// 这样姜去回完批注，她的页面会自己更新出蓝色气泡，不用手动刷新。

function touchActivity() {
  try {
    ensureDirs();
    writeJson(ACTIVITY_FILE, { ts: Date.now(), at: new Date().toISOString() });
  } catch (e) { /* ignore */ }
}

function readActivity() {
  const v = readJson(ACTIVITY_FILE, null);
  return v && v.ts ? v.ts : 0;
}

// ------------------------------------------------------------- progress

function getProgress(bookId) {
  return readJson(bookDir(bookId) + '/progress.json', null);
}

function setProgress(bookId, patch) {
  const cur = getProgress(bookId) || { chapter: 1, paraIndex: 0, ratio: 0 };
  const next = Object.assign({}, cur, patch, { updatedAt: new Date().toISOString() });
  writeJson(bookDir(bookId) + '/progress.json', next);
  return next;
}

// ---------------------------------------------------------------- notes

function setNote(bookId, chapter, info) {
  const file = notesDir(bookId) + '/' + String(chapter) + '.md';
  const body = '# ' + (info.title || ('第 ' + chapter + ' 章')) + '\n\n' + (info.text || '');
  vfs.writeFileSync(file, body);
  const book = getBook(bookId);
  if (book) {
    book.notes = book.notes || {};
    book.notes[String(chapter)] = { title: info.title || '', chars: (info.text || '').length, ts: new Date().toISOString() };
    saveBook(book);
  }
  return info;
}

function getNote(bookId, chapter) {
  const file = notesDir(bookId) + '/' + String(chapter) + '.md';
  try {
    const raw = vfs.readFileSync(file);
    return raw.replace(/^# .*\n+/, '').trim();
  } catch (e) {
    return null;
  }
}

function listNotes(bookId) {
  let files = [];
  try {
    files = vfs.readdirSync(notesDir(bookId)).filter((f) => f.endsWith('.md'));
  } catch (e) {
    return [];
  }
  return files
    .map((f) => Number(f.replace(/\.md$/, '')))
    .filter((n) => !Number.isNaN(n))
    .sort((a, b) => a - b);
}

// ----------------------------------------------------------------- logs

function appendLog(entry) {
  ensureDirs();
  const logs = readJson(DEEPSEEK_LOG, []);
  logs.push(entry);
  writeJson(DEEPSEEK_LOG, logs.slice(-500));
  return entry;
}

function listLogs() {
  return readJson(DEEPSEEK_LOG, []);
}

function workbenchStats() {
  const logs = listLogs();
  const stats = { calls: 0, promptTokens: 0, completionTokens: 0, tokens: 0, cost: 0, failed: 0, byTask: {} };
  for (const l of logs) {
    stats.calls += 1;
    stats.promptTokens += l.promptTokens || 0;
    stats.completionTokens += l.completionTokens || 0;
    stats.tokens += (l.promptTokens || 0) + (l.completionTokens || 0);
    stats.cost += l.cost || 0;
    if (!l.ok) stats.failed += 1;
    const t = l.task || 'other';
    stats.byTask[t] = stats.byTask[t] || { calls: 0, tokens: 0, cost: 0 };
    stats.byTask[t].calls += 1;
    stats.byTask[t].tokens += (l.promptTokens || 0) + (l.completionTokens || 0);
    stats.byTask[t].cost += l.cost || 0;
  }
  stats.cost = Math.round(stats.cost * 10000) / 10000;
  return { stats, logs: logs.slice().reverse() };
}

// -------------------------------------------------------------- pending

/**
 * 列出所有「我写了但 AI 还没回」的批注。
 * 这是 AI 伴读的核心入口。
 */
function pendingItems() {
  const items = [];
  for (const book of listBooks()) {
    const dir = annoDir(book.id);
    let files = [];
    try {
      files = vfs.readdirSync(dir).filter((f) => f.endsWith('.json'));
    } catch (e) {
      continue;
    }
    for (const f of files) {
      const chapter = Number(f.replace(/\.json$/, ''));
      if (Number.isNaN(chapter)) continue;
      const list = readJson(dir + '/' + f, []);
      for (const a of list) {
        if (a.who !== 'user') continue;
        if (a.replies && a.replies.length) continue;
        const chapterMeta = (book.chapters || []).find((c) => c.index === chapter);
        items.push({
          bookId: book.id,
          bookTitle: book.title,
          chapter,
          chapterTitle: chapterMeta ? chapterMeta.title : '第 ' + chapter + ' 章',
          annotationId: a.id,
          anchor: a.anchor,
          note: a.note,
          ts: a.ts
        });
      }
    }
  }
  items.sort((x, y) => String(x.ts).localeCompare(String(y.ts)));
  return items;
}

module.exports = {
  ROOT,
  DATA,
  BOOKS,
  ensureDirs,
  readJson,
  writeJson,
  touchActivity,
  readActivity,
  readConfig,
  writeConfig,
  DEFAULT_CONFIG,
  id,
  bookDir,
  listBooks,
  getBook,
  saveBook,
  deleteBook,
  getAnnotations,
  saveAnnotations,
  addAnnotation,
  addReply,
  getProgress,
  setProgress,
  setNote,
  getNote,
  listNotes,
  appendLog,
  listLogs,
  workbenchStats,
  pendingItems
};
