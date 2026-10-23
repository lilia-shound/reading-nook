'use strict';
/**
 * 共读小屋 · GitHub 存储后端
 *
 * 给 lib/vfs.js 当「磁盘」用 —— 底下其实是一个 GitHub 仓库。
 *
 * 路径怎么对：
 *   逻辑路径（相对 data/，正斜杠）：  config.json
 *   仓库里的实际路径：              data/config.json.enc
 *   （最后一段加 .enc，目录不加。仓库里永远是密文。）
 *   readdirSync('books/x/annotations') 列的是 data/books/x/annotations/，
 *   返回去掉了 .enc 的逻辑名（5.json），这样 lib/store.js 能原样用。
 *
 * 几个不将就的地方：
 *   · **加密只有一份实现**（public/vault.js）。这里 require 它，不复制粘贴。
 *   · vfs 的接口是**同步**的（fs 风格），可 vault.js 的 WebCrypto 是异步的。
 *     所以加解密、HTTP 都放在一个**同步子进程**里跑（execFileSync + node -e），
 *     主进程同步等结果。接口一个字没改，以后换成 worker 线程也不影响别人。
 *   · 每次读写都走 api.github.com 的 contents 接口，**不走 raw 的 CDN** ——
 *     刚写完立刻就能读到自己的东西。
 *   · 写冲突（409）就重读 sha 再写，最多 3 次。
 *
 * token：GH_TOKEN 环境变量，或者 data/.local.json 的 ghToken（那个文件永远不推仓库）。
 * 密码：NOOK_PASSCODE 环境变量，或者 data/.local.json 的 passcode。
 * 没有 token 就只能读，写会抛一个说人话的中文错。
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const SITE_FILE = path.join(ROOT, 'public', 'site.json');
const LOCAL_FILE = path.join(ROOT, 'data', '.local.json');
const API = 'https://api.github.com';
// 加解密：进程内同步做，格式跟 public/vault.js 一模一样（那边是唯一一份定义）
const VaultNode = require('./vault-node');

// ----------------------------------------------------------- 配置

/** public/site.json（故意公开：盐不是秘密，密钥才是） */
function site() {
  try {
    const raw = fs.readFileSync(SITE_FILE, 'utf8').replace(/^\uFEFF/, '');
    const s = JSON.parse(raw);
    if (!s || !s.owner || !s.repo) throw new Error('缺 owner / repo');
    return s;
  } catch (e) {
    throw new Error('读不到 public/site.json（GitHub 后端要知道 owner/repo/branch/盐）：' + e.message);
  }
}

/** data/.local.json（本地专用，永远不推仓库） */
function localCfg() {
  try {
    const raw = fs.readFileSync(LOCAL_FILE, 'utf8').replace(/^\uFEFF/, '');
    const o = JSON.parse(raw);
    return (o && typeof o === 'object') ? o : {};
  } catch (e) {
    return {};
  }
}

function owner() { return String(site().owner); }
function repo() { return String(site().repo); }
function branch() { return String(site().branch || 'main'); }
function kdfSalt() { return String((site().kdf && site().kdf.salt) || ''); }
function kdfIter() { const n = Number(site().kdf && site().kdf.iter); return isFinite(n) && n > 0 ? n : 210000; }

/** token：环境变量优先，其次 data/.local.json */
function token() {
  const t = String(process.env.GH_TOKEN || '').trim();
  if (t) return t;
  return String(localCfg().ghToken || '').trim();
}

/** 密码：环境变量优先，其次 data/.local.json */
function passcode() {
  const p = String(process.env.NOOK_PASSCODE || '').trim();
  if (p) return p;
  return String(localCfg().passcode || '').trim();
}

// ------------------------------------------------------- 同步子进程

/**
 * 同步跑一小段 Node 代码，等它把结果吐回来。
 * 加解密（WebCrypto）和 HTTP（https）都是异步的，
 * 而 vfs 的接口是同步的 —— 中间这一层就是桥。
 */
function runChild(src, payload) {
  let out;
  try {
    out = execFileSync(process.execPath, ['-e', src], {
      input: JSON.stringify(payload),
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      // 兜底：子进程最多跑 15 秒，超了直接杀掉。
      // 没有这一条，子进程要是卡住（比如卡在 DNS 解析里），父进程会一直干等 ——
      // 整个服务跟着冻住，连静态页都不回。
      timeout: 15000,
      killSignal: 'SIGKILL'
    });
  } catch (e) {
    const detail = (e && e.stderr) ? String(e.stderr).trim() : '';
    const msg = (e && e.message) ? String(e.message) : '不知道怎么了';
    // 超时杀掉的，说人话
    if (e && (e.killed || e.signal === 'SIGKILL' || e.signal === 'SIGTERM')) {
      throw new Error('内部子进程超时被杀了（网络卡住了），没等它');
    }
    throw new Error('内部子进程跑挂了：' + (detail || msg));
  }
  try {
    return JSON.parse(out);
  } catch (e) {
    throw new Error('内部子进程返回的不是 JSON：' + String(out).slice(0, 200));
  }
}

/**
 * 发 HTTP 用的子进程：只用 https 标准库（不碰 fetch，免得 Node 版本有差别）
 *
 * 这里每一层都得有超时 —— 父进程是**同步**等这个子进程的，
 * 子进程要是永远不退出，整个服务就冻住（连静态页都不回）。
 * 卡点有三个，各管各的：
 *   ① DNS 解析（卡住的话连 socket 都不会有）
 *   ② 连上以后的响应等待
 *   ③ 兜底的总时长（不管卡在哪，到点交答案走人）
 */
const HTTP_SRC = `
const https = require('https');
const dns = require('dns');
const chunks = [];
process.stdin.on('data', function (c) { chunks.push(c); });
process.stdin.on('end', function () {
  const req = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  const u = new URL(req.url);
  const headers = req.headers || {};
  const body = (req.body === undefined || req.body === null) ? null : Buffer.from(req.body, 'utf8');
  if (body) headers['Content-Length'] = body.length;

  var hard = null;
  var sent = false;
  const done = function (status, text) {
    if (sent) return;
    sent = true;
    if (hard) clearTimeout(hard);
    process.stdout.write(Buffer.from(JSON.stringify({ status: status, text: text }), 'utf8'));
  };

  // ③ 兜底总时长：8 秒。到点就交「超时」这个答案，父进程不会永远等
  hard = setTimeout(function () { done(0, '请求超时（网络卡住了）'); }, 8000);

  // ① DNS 单独看住
  const lookup = function (host, opts, cb) {
    let finished = false;
    const t = setTimeout(function () {
      if (finished) return;
      finished = true;
      cb(new Error('DNS 解析超时'));
    }, 4000);
    dns.lookup(host, opts, function (err, addr, fam) {
      if (finished) return;
      finished = true;
      clearTimeout(t);
      cb(err, addr, fam);
    });
  };

  const r = https.request({
    method: req.method,
    hostname: u.hostname,
    port: u.port || 443,
    path: u.pathname + u.search,
    headers: headers,
    lookup: lookup
  }, function (res) {
    const cs = [];
    res.on('data', function (c) { cs.push(c); });
    res.on('end', function () { done(res.statusCode, Buffer.concat(cs).toString('utf8')); });
  });
  r.on('error', function (e) { done(0, String((e && e.message) || e)); });
  // ② 连上以后的响应等待
  r.setTimeout(6000, function () { r.destroy(new Error('等响应超时')); });
  if (body) r.write(body);
  r.end();
});
`;

// ------------------------------------------------------------ 加解密
//
// 进程内同步做（lib/vault-node.js），格式和 public/vault.js 一模一样。
// 以前是丢进 execFileSync 子进程跑的 —— 光 spawn 一次 node 就要 578 毫秒，
// 读一本书几十个文件就是几十秒。现在密钥还缓存着，几乎不花时间。

function vaultEncrypt(text) {
  const pc = passcode();
  if (!pc) {
    throw new Error('没有密码，存不进去。设一个环境变量 NOOK_PASSCODE，或者写进 data/.local.json 的 passcode 字段。');
  }
  const key = VaultNode.deriveKeySync(pc, kdfSalt(), kdfIter());
  return VaultNode.encryptTextSync(key, String(text));
}

function vaultDecrypt(blob) {
  const pc = passcode();
  if (!pc) {
    throw new Error('没有密码，解不开密文。设一个环境变量 NOOK_PASSCODE，或者写进 data/.local.json 的 passcode 字段。');
  }
  const key = VaultNode.deriveKeySync(pc, kdfSalt(), kdfIter());
  try {
    return VaultNode.decryptTextSync(key, blob);
  } catch (e) {
    // code = 'EVAULT'：跟「文件不存在」分得开，调用方能一眼看出是密码的事
    const err = new Error('vault: 密码不对，解不开（密码写错了，或者这个文件不是用这个密码加密的）'
      + ((e && e.message) ? '　—— ' + e.message : ''));
    err.code = 'EVAULT';
    throw err;
  }
}

// ------------------------------------------------------- GitHub 请求

/** apiPath：contents 接口的路径（带 ref，指向最新 commit 的内容） */
function apiPath(rel) {
  return '/repos/' + owner() + '/' + repo() + '/contents/' + encodePath(rel)
    + '?ref=' + encodeURIComponent(branch());
}

/** apiPathNoRef：写的时候用（分支放在 body 里） */
function apiPathNoRef(rel) {
  return '/repos/' + owner() + '/' + repo() + '/contents/' + encodePath(rel);
}

function encodePath(p) {
  return String(p).split('/').map((seg) => encodeURIComponent(seg)).join('/');
}

/**
 * 真正的请求。**这个函数是可以换掉的** ——
 * 测试里注入一个假的，就不用真打 GitHub 网络。
 * 约定：(method, apiPath, body) -> 解析好的 JSON；出错要 throw，且 error.status 是 HTTP 状态码。
 */
function defaultRequest(method, apiPath, body) {
  const headers = {
    'Accept': 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'reading-nook-backend'
  };
  const t = token();
  if (t) headers['Authorization'] = 'Bearer ' + t;

  let bodyText = null;
  if (body !== undefined && body !== null) {
    headers['Content-Type'] = 'application/json';
    bodyText = JSON.stringify(body);
  }

  const res = runChild(HTTP_SRC, { method: method, url: API + apiPath, headers: headers, body: bodyText });
  const status = Number(res.status) || 0;
  let data = null;
  try { data = res.text ? JSON.parse(res.text) : null; } catch (e) { data = res.text; }

  if (status >= 200 && status < 300) return data;

  const msg = (data && data.message) ? data.message : String(res.text || '').slice(0, 300);
  if (status === 0) {
    const e = new Error('连不上 GitHub：' + (msg || '网络不通'));
    e.status = 0;
    throw e;
  }
  const err = new Error(status + ' ' + msg);
  err.status = status;
  err.data = data;
  throw err;
}

let requestImpl = defaultRequest;

// 网络层会**抖**：连接被掐、GitHub 限流、5xx。
// 不重试的话，她会遇到「刚才还好好的，怎么突然打不开书了」—— 其实重试一次就好。
// status 0 = 请求本身失败（网络层），最常见。
const TRANSIENT = [0, 403, 429, 500, 502, 503, 504];

function delay(ms) {
  // 同步等待（vfs 的接口是同步的，没法 await）。
  // 用 Atomics.wait 睡，别用 while 空转 —— 空转会把 CPU 烧满，
  // 整个机器都跟着卡。
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
    return;
  } catch (e) { /* 兜底：老的 Node 不支持就空转 */ }
  const until = Date.now() + ms;
  while (Date.now() < until) { /* 干等 */ }
}

/**
 * 总预算：一次请求（含重试）最多占用这么久。
 * 同步调用会冻住整个服务，所以这个数不能太大。
 */
const REQ_BUDGET_MS = 20000;

function request(method, apiPath, body, used, deadline) {
  const dl = (deadline === undefined) ? (Date.now() + REQ_BUDGET_MS) : deadline;
  const tries = (used === undefined) ? 1 : used;
  try {
    return requestImpl(method, apiPath, body);
  } catch (e) {
    const st = e && e.status;
    // status 0 = 请求本身卡死/断网 —— 每试一次要等好几秒，贵，只再试一次
    const maxTries = (st === 0) ? 2 : 3;
    if (st !== undefined && TRANSIENT.indexOf(st) >= 0 && tries < maxTries && Date.now() < dl) {
      delay(400 * (3 - tries));
      return request(method, apiPath, body, tries + 1, dl);
    }
    throw e;
  }
}

// ---------------------------------------------------------- 路径映射

/** 逻辑路径（相对 data/）→ 仓库里的文件路径（最后一段加 .enc） */
function repoFilePath(rel) {
  const clean = normalizeRel(rel);
  if (!clean) return 'data/.enc';
  const parts = clean.split('/');
  const last = parts[parts.length - 1];
  parts[parts.length - 1] = /\.enc$/i.test(last) ? last : last + '.enc';
  return 'data/' + parts.join('/');
}

/** 逻辑目录 → 仓库里的目录路径（目录不加 .enc） */
function repoDirPath(rel) {
  const clean = normalizeRel(rel);
  return clean ? 'data/' + clean : 'data';
}

function normalizeRel(rel) {
  return String(rel == null ? '' : rel)
    .replace(/\\/g, '/')
    .split('/')
    .filter((p) => p && p !== '.' && p !== '..')
    .join('/');
}

// ------------------------------------------------------------ 内存缓存

/**
 * 读过的路径缓存起来（明文 + sha + mtime + 密码指纹）。
 * 同一个进程里反复读同一个文件不会反复打网络。
 *
 * 缓存默认 2 秒后过期（NOOK_GH_CACHE_MS 可调，0 = 不缓存）：
 *   她那边刚划的线、刚收到的回应，不能因为缓存被挡住 —— 所以不永久缓存。
 */const CACHE_MS = (function () {
  const v = process.env.NOOK_GH_CACHE_MS;
  if (v === undefined || v === '') return 2000;
  const n = Number(v);
  return (isFinite(n) && n >= 0) ? n : 2000;
})();

const cache = new Map(); // rel -> {plain, sha, mtime, size, at}
let cachePasscode = null; // 缓存是用哪个密码解的

function cacheGet(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (cachePasscode !== null && cachePasscode !== passcode()) {
    // 密码换了，缓存里的明文不作数了
    cache.clear();
    cachePasscode = null;
    return null;
  }
  if (Date.now() - hit.at > CACHE_MS) return null;
  return hit;
}

function cacheSet(key, entry) {
  cachePasscode = passcode();
  entry.at = Date.now();
  cache.set(key, entry);
}

/**
 * 取**过期了也认**的缓存。
 * 网络抖了的时候，宁可给她看手上这份（可能旧了几分钟），也别让她打不开书。
 */
function cacheGetStale(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (cachePasscode !== null && cachePasscode !== passcode()) {
    cache.clear();
    cachePasscode = null;
    return null;
  }
  return hit;
}

/** 清缓存 */
function clearCache() {
  cache.clear();
  cachePasscode = null;
}

// ------------------------------------------------------------ 本地镜像
//
// 为什么要有这层：
//   读一次数据 = 一次 GitHub 网络往返。实测这台机器 **1.7 秒**（其中 578 毫秒
//   是 spawn 子进程的开销，网络本身约 1.1 秒）。
//   读书是高频操作 —— 打开一章要读好几个文件，每次都等一秒多，根本没法看。
//
//   所以：把远端的密文**原样**存一份在本地（data/.mirror/），
//   读的时候解本地那份（进程内解密，不到 1 毫秒），后台再慢慢跟远端同步。
//
//   仓库仍然是唯一事实来源，规则一条没松：
//   · 写：永远 GET 远端最新那份 → 在那份上改 → PUT 回去（**绝不拿镜像当基底**）
//   · 读：镜像只是远端的缓存，最多落后一个轮询周期（默认 20 秒）
//   · 自己的写：写完立刻回填镜像（她马上就能看到自己刚划的那条线）
//
//   镜像里存的是**密文**，跟仓库里一样 —— 本机也不落明文。
//
//   默认**不开**。开了之后一次性工具（比如云端姜去用的 tools/gh-store.js）
//   就不该读镜像了 —— 它要的是「此刻最新的」，不是「20 秒前的」。
//   所以由 server.js 显式打开。

const MIRROR_DIR = process.env.NOOK_DATA_DIR
  ? path.join(path.resolve(process.env.NOOK_DATA_DIR), '.mirror')
  : path.join(ROOT, 'data', '.mirror');
const MIRROR_META = path.join(MIRROR_DIR, 'meta.json');

let mirrorMeta = null;    // { commit, files: { 仓库路径: {sha,size,mtime,localAt} }, updatedAt }
let mirrorEnabled = false;
let mirrorTimer = null;
let mirrorBusy = false;

/** 读镜像的元信息（哪些文件、sha 是多少） */
function loadMirrorMeta() {
  if (mirrorMeta) return mirrorMeta;
  try {
    const raw = fs.readFileSync(MIRROR_META, 'utf8').replace(/^\uFEFF/, '');
    const o = JSON.parse(raw);
    mirrorMeta = (o && typeof o === 'object') ? o : null;
  } catch (e) { mirrorMeta = null; }
  if (!mirrorMeta || typeof mirrorMeta !== 'object') mirrorMeta = { commit: null, files: {}, updatedAt: 0 };
  if (!mirrorMeta.files || typeof mirrorMeta.files !== 'object') mirrorMeta.files = {};
  if (typeof mirrorMeta.updatedAt !== 'number') mirrorMeta.updatedAt = 0;
  return mirrorMeta;
}

/** 存镜像的元信息（原子替换） */
function saveMirrorMeta() {
  const m = loadMirrorMeta();
  m.updatedAt = Date.now();
  fs.mkdirSync(MIRROR_DIR, { recursive: true });
  const tmp = MIRROR_META + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(m, null, 2), 'utf8');
  fs.renameSync(tmp, MIRROR_META);
}

/** 逻辑 rel → 镜像里那个密文文件的绝对路径 */
function mirrorFile(rel) {
  const rp = repoFilePath(rel);                       // data/books/x.json.enc
  return path.join(MIRROR_DIR, rp.slice('data/'.length));   // .mirror/books/x.json.enc
}

/** 读镜像里的密文（没有就 null） */
function mirrorReadBlob(rel) {
  try {
    return fs.readFileSync(mirrorFile(rel), 'utf8');
  } catch (e) { return null; }
}

/** 把密文写进镜像（原子替换），顺便记下 sha/大小/mtime */
function mirrorWriteBlob(rel, blob, info) {
  const f = mirrorFile(rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const tmp = f + '.tmp-' + process.pid + '-' + Date.now();
  fs.writeFileSync(tmp, blob, 'utf8');
  fs.renameSync(tmp, f);
  const m = loadMirrorMeta();
  const rp = repoFilePath(rel);
  m.files[rp] = {
    sha: (info && info.sha) || null,
    size: (info && typeof info.size === 'number') ? info.size : null,
    mtime: (info && typeof info.mtime === 'number') ? info.mtime : null,
    localAt: (info && typeof info.localAt === 'number') ? info.localAt : undefined
  };
  return m;
}

/** 从镜像里删掉一个文件（或者一个目录下的所有文件） */
function mirrorRemove(rel) {
  const key = normalizeRel(rel);
  const rp = repoFilePath(key);
  const m = loadMirrorMeta();
  const prefix = rp + '/';
  const kill = [];
  for (const p of Object.keys(m.files)) {
    if (p === rp || p.indexOf(prefix) === 0) kill.push(p);
  }
  for (const p of kill) {
    try { fs.unlinkSync(path.join(MIRROR_DIR, p.slice('data/'.length))); } catch (e) { /* ignore */ }
    delete m.files[p];
    cache.delete(p.slice('data/'.length).replace(/\.enc$/i, ''));
  }
  return m;
}

/** 镜像里列目录（没刷新过就返回 null，意思是「镜像还不知道，问我远端」） */
function mirrorListDir(rel) {
  const m = loadMirrorMeta();
  if (!m.commit) return null;
  const key = normalizeRel(rel);
  const prefix = 'data/' + (key ? key + '/' : '');
  const out = [];
  const seen = new Set();
  for (const rp of Object.keys(m.files)) {
    if (rp.indexOf(prefix) !== 0) continue;
    const rest = rp.slice(prefix.length);
    const seg = rest.split('/')[0];
    if (!seg || seen.has(seg)) continue;
    seen.add(seg);
    const isDir = rest.length > seg.length;      // 后面还有 '/' → 是目录
    out.push({
      name: isDir ? seg : seg.replace(/\.enc$/i, ''),
      type: isDir ? 'dir' : 'file',
      sha: (m.files[rp] && m.files[rp].sha) || null
    });
  }
  return out;
}

/** 镜像里这个文件在不在 */
function mirrorHas(rel) {
  const m = loadMirrorMeta();
  const rp = repoFilePath(rel);
  if (m.files[rp]) return true;
  const prefix = rp + '/';
  for (const p of Object.keys(m.files)) {
    if (p.indexOf(prefix) === 0) return true;
  }
  return false;
}

// ------------------------------------------------------- 异步刷新镜像

/** 异步 GET GitHub（不阻塞事件循环 —— 同步子进程只留给写路径用） */
async function ghFetchAsync(apiPath) {
  const headers = {
    'Accept': 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'reading-nook-backend'
  };
  const t = token();
  if (t) headers['Authorization'] = 'Bearer ' + t;
  const ctrl = new AbortController();
  const timer = setTimeout(function () { ctrl.abort(); }, 20000);
  try {
    const res = await fetch(API + apiPath, { headers: headers, signal: ctrl.signal });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch (e) { data = text; }
    if (!res.ok) {
      const e = new Error(res.status + ' ' + ((data && data.message) || String(text).slice(0, 200)));
      e.status = res.status;
      throw e;
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 把镜像跟远端对齐。
 *   1) tree 接口拿远端现在有哪些文件、sha 是多少（**一个请求**）
 *   2) 跟镜像里的 sha 比 → 只拉变了的那几个
 *   3) 远端删了的，镜像里也删掉
 */
async function refreshMirror() {
  if (!mirrorEnabled || mirrorBusy) return null;
  mirrorBusy = true;
  const startedAt = Date.now();
  let fetched = 0;
  try {
    const tree = await ghFetchAsync('/repos/' + owner() + '/' + repo() + '/git/trees/'
      + encodeURIComponent(branch()) + '?recursive=1');
    const entries = (tree && Array.isArray(tree.tree)) ? tree.tree : [];

    const remote = {};
    for (const e of entries) {
      if (!e || e.type !== 'blob') continue;
      const p = String(e.path || '');
      if (p.indexOf('data/') !== 0) continue;
      if (!/\.enc$/i.test(p)) continue;
      remote[p] = String(e.sha || '');
    }

    const meta = loadMirrorMeta();
    const need = [];
    for (const p of Object.keys(remote)) {
      const cur = meta.files[p];
      if (!cur || cur.sha !== remote[p]) need.push(p);
    }

    // 分批拉（一次 8 个，别把 GitHub 打到限流）
    for (let i = 0; i < need.length; i += 8) {
      const batch = need.slice(i, i + 8);
      const results = await Promise.all(batch.map(async function (p) {
        try {
          const d = await ghFetchAsync('/repos/' + owner() + '/' + repo() + '/contents/'
            + encodePath(p) + '?ref=' + encodeURIComponent(branch()));
          return { p: p, blob: decodeContent(d), sha: (d && d.sha) || remote[p] };
        } catch (e) {
          return null;   // 这个文件拉不到就跳过，下轮再说
        }
      }));
      for (const r of results) {
        if (!r) continue;
        const m = loadMirrorMeta();
        const cur = m.files[r.p];
        // 拉的这段时间里本地写过这个文件 → 别用旧的盖掉（下一轮自然会拿到新的）
        if (cur && cur.localAt && cur.localAt > startedAt) continue;
        let size = null;
        const mtime = envelopeMtime(r.blob);
        try {
          size = Buffer.byteLength(vaultDecrypt(r.blob), 'utf8');
        } catch (e) { /* 密码不对就先只存密文 */ }
        mirrorWriteBlob(logicalFromRepo(r.p), r.blob, { sha: r.sha, size: size, mtime: mtime });
        cache.delete(logicalFromRepo(r.p));
        fetched++;
      }
    }

    // 远端已经删掉的 → 镜像里也删掉
    const m = loadMirrorMeta();
    for (const p of Object.keys(m.files)) {
      if (!remote[p]) {
        try { fs.unlinkSync(path.join(MIRROR_DIR, p.slice('data/'.length))); } catch (e) { /* ignore */ }
        delete m.files[p];
        cache.delete(logicalFromRepo(p));
      }
    }

    m.commit = (tree && tree.sha) ? tree.sha : m.commit;
    saveMirrorMeta();
    return { fetched: fetched, files: Object.keys(remote).length };
  } catch (e) {
    // 网络不通就下轮再来，不影响服务
    return null;
  } finally {
    mirrorBusy = false;
  }
}

/** 仓库路径 → 逻辑路径（data/books/x.json.enc → books/x.json） */
function logicalFromRepo(repoPath) {
  let p = String(repoPath || '');
  if (p.indexOf('data/') === 0) p = p.slice('data/'.length);
  return p.replace(/\.enc$/i, '');
}

/** 打开镜像（server.js 调） */
function enableMirror() {
  mirrorEnabled = true;
  loadMirrorMeta();
}

/** 定时刷新（server.js 调）。第一次立刻刷，之后每隔 ms 刷一次。 */
function startMirrorRefresh(ms) {
  if (!mirrorEnabled || mirrorTimer) return;
  const gap = Math.max(5000, Number(ms) || 20000);
  refreshMirror();
  mirrorTimer = setInterval(function () { refreshMirror(); }, gap);
  if (mirrorTimer.unref) mirrorTimer.unref();
}

// ------------------------------------------------------------ 工具

function enoent(rel) {
  const e = new Error('文件不存在：' + rel + '（ENOENT）');
  e.code = 'ENOENT';
  e.path = rel;
  return e;
}

/** GitHub 返回的 base64 内容 → 仓库里存的那段字符串（密文信封） */
function decodeContent(data) {
  if (!data || typeof data !== 'object') throw new Error('GitHub 返回的内容看不懂');
  const enc = String(data.encoding || 'base64');
  if (enc !== 'base64' || !data.content) {
    if (Number(data.size) === 0) return '';
    throw new Error('这个文件的内容拿不到（contents 接口只给 1MB 以内的内容，太大的要用 raw 接口）');
  }
  return Buffer.from(String(data.content).replace(/\s+/g, ''), 'base64').toString('utf8');
}

/** 密文信封里的 mtime（毫秒） */
function envelopeMtime(blob) {
  try {
    const o = JSON.parse(String(blob));
    return (o && typeof o.mtime === 'number') ? o.mtime : null;
  } catch (e) {
    return null;
  }
}

/** 拿某个仓库文件当前的 sha（不存在返回 null） */
function fileSha(rel) {
  try {
    const d = request('GET', apiPath(rel), null);
    return (d && d.sha) ? d.sha : null;
  } catch (e) {
    if (e && e.status === 404) return null;
    throw e;
  }
}

/** 列仓库里某个目录（不存在返回 []） */
function listDir(rel) {
  const key = 'dir:' + normalizeRel(rel);
  const hit = cacheGet(key);
  if (hit) return hit.plain;

  let d;
  try {
    d = request('GET', apiPath(rel), null);
  } catch (e) {
    if (e && e.status === 404) return [];
    // 网络断了：目录列表也用旧的，先让她能看见书架
    const stale = cacheGetStale(key);
    if (stale) return stale.plain;
    throw e;
  }
  const list = Array.isArray(d) ? d : [];
  cacheSet(key, { plain: list });
  return list;
}

// ------------------------------------------------------------ 后端接口

/**
 * 读一个文件（相对 data/ 的逻辑路径）。
 * 不存在要抛错，而且 error.code === 'ENOENT'（fs 的老规矩，store.js 靠它 catch）。
 */
function readFileSync(rel) {
  const key = normalizeRel(rel);
  const hit = cacheGet(key);
  if (hit) return hit.plain;

  // 1) 镜像里有 → 本地解，不碰网络（这是让「翻书」变快的那一步）
  if (mirrorEnabled) {
    const blob = mirrorReadBlob(key);
    if (blob !== null) {
      try {
        const plain = vaultDecrypt(blob);
        const info = (loadMirrorMeta().files[repoFilePath(key)]) || {};
        cacheSet(key, {
          plain: plain,
          sha: info.sha || null,
          mtime: envelopeMtime(blob),
          size: Buffer.byteLength(plain, 'utf8')
        });
        return plain;
      } catch (e) {
        // 镜像里的解不开（换密码了？）→ 掉到网络那条路，顺手把镜像刷新掉
      }
    }
  }

  const rp = repoFilePath(key);
  let data;
  try {
    data = request('GET', apiPath(rp), null);
  } catch (e) {
    if (e && e.status === 404) throw enoent(key);
    // 网络断了：宁可用手上这份旧的（可能已经过期），也别让她打不开书
    const stale = cacheGetStale(key);
    if (stale) return stale.plain;
    throw e;
  }

  const blob = decodeContent(data);
  const plain = vaultDecrypt(blob);
  cacheSet(key, {
    plain: plain,
    sha: (data && data.sha) ? data.sha : null,
    mtime: envelopeMtime(blob),
    size: Buffer.byteLength(plain, 'utf8')
  });
  // 顺手存进镜像（下次读就不用再问网络了）
  if (mirrorEnabled) {
    try {
      mirrorWriteBlob(key, blob, {
        sha: (data && data.sha) ? data.sha : null,
        size: Buffer.byteLength(plain, 'utf8'),
        mtime: envelopeMtime(blob)
      });
    } catch (e) { /* 镜像写不进去也不影响正事 */ }
  }
  return plain;
}

/**
 * 写一个文件（自动加密，仓库里永远是密文）。
 * 没有 token 就写不了 —— 错要说人话。
 */
function writeFileSync(rel, content) {
  if (!token()) {
    throw new Error('没有 GitHub token，没法写。设一个环境变量 GH_TOKEN，'
      + '或者写进 data/.local.json 的 ghToken 字段（那个文件不会推上仓库）。');
  }

  const key = normalizeRel(rel);
  const text = String(content == null ? '' : content);

  // 密文信封：vault 的四件套 + mtime（mtime 放在信封外头，两边设备靠它判「谁更新」）
  const envelope = JSON.parse(vaultEncrypt(text));
  envelope.mtime = Date.now();
  const blob = JSON.stringify(envelope);

  const rp = repoFilePath(key);
  const hit = cacheGet(key);
  let sha = (hit && hit.sha) ? hit.sha : null;
  let lastErr = null;

  for (let attempt = 1; attempt <= 3; attempt++) {
    const body = {
      message: '更新 ' + key,
      content: Buffer.from(blob, 'utf8').toString('base64'),
      branch: branch()
    };
    if (sha) body.sha = sha;
    try {
      const res = request('PUT', apiPathNoRef(rp), body);
      const newSha = (res && res.content && res.content.sha) ? res.content.sha : sha;
      cacheSet(key, {
        plain: text,
        sha: newSha,
        mtime: envelope.mtime,
        size: Buffer.byteLength(text, 'utf8')
      });
      // 回填镜像：她刚划的线马上就能读到，不用等下一轮同步
      if (mirrorEnabled) {
        try {
          mirrorWriteBlob(key, blob, {
            sha: newSha,
            size: Buffer.byteLength(text, 'utf8'),
            mtime: envelope.mtime,
            localAt: Date.now()
          });
        } catch (e) { /* 镜像写不进去也不影响正事 */ }
      }
      return;
    } catch (e) {
      lastErr = e;
      // 409：有人同时在改 → 重读最新的 sha，合并后再写
      if (e && e.status === 409 && attempt < 3) {
        sha = fileSha(rp);
        continue;
      }
      // 422 "sha wasn't supplied" → 文件其实存在，但我们手上没有 sha
      // （缓存过期 / 那次读恰好抖了一下返回了 404）→ 去要一个再写
      if (e && e.status === 422 && /sha/i.test(String(e.message || '')) && attempt < 3) {
        sha = fileSha(rp);
        if (sha) continue;
        throw new Error('写不进去 ' + key + '：文件在，但拿不到它的 sha（网络抖了？再试一次）');
      }
      throw new Error('写不进去 ' + key + '：' + ((e && e.message) ? e.message : '不知道怎么了'));
    }
  }
  throw new Error('写不进去 ' + key + '：冲突重试了 3 次还是不行（'
    + ((lastErr && lastErr.message) ? lastErr.message : '未知原因') + '）');
}

/**
 * 读-改-写，**基底永远是远端最新的那份**。
 *
 * ⚠️ 为什么不能「拿本地缓存当基底」：
 *   云端那位也在写同一个仓库。他刚回完的 18 条回应在远端，
 *   而本地缓存可能是几秒前的旧快照 —— 拿它当基底写回去，
 *   就把人家的回应冲掉了（GitHub 的 PUT 是 last-write-wins）。
 *   所以铁律：**写之前永远先 GET 最新的 .enc，在那份最新数据上改，再 PUT 回去。**
 *   409 冲突也是**整轮重来**（重新读远端 + 重新合并），不是只换 sha。
 *
 * @param {string} rel        相对 data/ 的逻辑路径
 * @param {Function} mergeFn  (current) => next
 * @param {*} defaultValue    文件本来就不存在时的底
 */
function updateFileSync(rel, mergeFn, defaultValue) {
  if (!token()) {
    throw new Error('没有 GitHub token，没法写。设一个环境变量 GH_TOKEN，'
      + '或者写进 data/.local.json 的 ghToken 字段（那个文件不会推上仓库）。');
  }
  const key = normalizeRel(rel);
  const rp = repoFilePath(key);

  for (let attempt = 1; attempt <= 4; attempt++) {
    // 1) 读远端最新（**绕过缓存** —— 缓存里的可能是别人的旧版本）
    let current = defaultValue;
    let sha = null;
    try {
      const data = request('GET', apiPath(rp), null);
      const blob = decodeContent(data);
      sha = (data && data.sha) ? data.sha : null;
      try {
        current = JSON.parse(vaultDecrypt(blob));
      } catch (e) {
        current = defaultValue;      // 密文坏了 → 当成空文件重写
      }
      cacheSet(key, {
        plain: JSON.stringify(current),
        sha: sha,
        mtime: envelopeMtime(blob),
        size: 0
      });
    } catch (e) {
      if (!e || e.status !== 404) throw e;
      current = defaultValue;
      sha = null;
    }

    // 2) 在**远端最新**那份上合并
    const next = mergeFn ? mergeFn(current) : current;
    const text = JSON.stringify(next, null, 2);

    // 3) 加密 → 写
    const envelope = JSON.parse(vaultEncrypt(text));
    envelope.mtime = Date.now();
    const blob = JSON.stringify(envelope);
    const body = {
      message: '更新 ' + key,
      content: Buffer.from(blob, 'utf8').toString('base64'),
      branch: branch()
    };
    if (sha) body.sha = sha;
    try {
      const res = request('PUT', apiPathNoRef(rp), body);
      const newSha = (res && res.content && res.content.sha) ? res.content.sha : sha;
      cacheSet(key, {
        plain: text,
        sha: newSha,
        mtime: envelope.mtime,
        size: Buffer.byteLength(text, 'utf8')
      });
      // 回填镜像（写的是远端最新那份，镜像也得跟上）
      if (mirrorEnabled) {
        try {
          mirrorWriteBlob(key, blob, {
            sha: newSha,
            size: Buffer.byteLength(text, 'utf8'),
            mtime: envelope.mtime,
            localAt: Date.now()
          });
        } catch (e) { /* 镜像写不进去也不影响正事 */ }
      }
      return next;
    } catch (e) {
      // 409（有人同时在改）/ 422（我们手上没 sha）→ 整轮重来
      if (e && (e.status === 409 || e.status === 422) && attempt < 4) continue;
      throw new Error('写不进去 ' + key + '：' + ((e && e.message) ? e.message : '不知道怎么了'));
    }
  }
  throw new Error('写不进去 ' + key + '：冲突重试了 4 次还是不行');
}

/** 文件（或目录）在不在 */
function existsSync(rel) {
  const key = normalizeRel(rel);
  // 镜像刷新过就信镜像（省一次网络往返）
  if (mirrorEnabled && loadMirrorMeta().commit) return mirrorHas(key);
  try {
    request('GET', apiPath(repoFilePath(key)), null);
    return true;
  } catch (e) {
    if (!e || e.status !== 404) throw e;
  }
  try {
    const d = request('GET', apiPath(repoDirPath(key)), null);
    return Array.isArray(d);
  } catch (e) {
    if (e && e.status === 404) return false;
    throw e;
  }
}

/**
 * 列目录。返回**逻辑名**（去掉了 .enc），所以 store.js 里
 * readJson(dir + '/' + f) 这种老写法能直接用。
 */
function readdirSync(rel) {
  const key = normalizeRel(rel);
  // 镜像里有就用镜像的（快）—— 没刷新过就老老实实问远端
  const entries = (mirrorEnabled ? mirrorListDir(key) : null) || listDir(repoDirPath(key));
  const out = [];
  for (const e of entries) {
    const name = String((e && e.name) || '');
    if (!name) continue;
    if (e && e.type === 'file') out.push(name.replace(/\.enc$/i, ''));
    else out.push(name);
  }
  return out;
}

/** 建目录。GitHub 仓库里没有真目录 —— 文件一放进去目录就成立了，所以这里什么都不用做。 */
function mkdirSync(rel, opts) { // eslint-disable-line no-unused-vars
  // 故意空的：不用报错，目录不存在也不要紧（rel / opts 都用不上）
}

/** 删东西。recursive 的时候把底下所有文件都删掉（GitHub 里目录本来就是一堆文件） */
function rmSync(rel, opts) {
  if (!token()) {
    throw new Error('没有 GitHub token，没法删。设一个环境变量 GH_TOKEN，'
      + '或者写进 data/.local.json 的 ghToken 字段（那个文件不会推上仓库）。');
  }
  const key = normalizeRel(rel);
  if (!key) return;

  const rp = repoFilePath(key);
  const sha = fileSha(rp);
  if (sha) {
    request('DELETE', apiPathNoRef(rp), { message: '删除 ' + key, sha: sha, branch: branch() });
    cache.delete(key);
    if (mirrorEnabled) { try { mirrorRemove(key); } catch (e) { /* ignore */ } }
    return;
  }

  // 当目录处理：底下每个文件都删一遍
  const entries = listDir(repoDirPath(key));
  for (const e of entries) {
    const name = String((e && e.name) || '');
    if (!name) continue;
    const childKey = key + '/' + (e.type === 'file' ? name.replace(/\.enc$/i, '') : name);
    rmSync(childKey, opts);
  }
}

/**
 * 文件大小和修改时间。
 * size 是**明文**的字节数（和本地后端一个口径）；mtime 是密文信封里那个。
 * 文件不在就返回 null。
 */
function statSync(rel) {
  const key = normalizeRel(rel);
  const hit = cacheGet(key);
  if (hit) {
    return { size: hit.size, mtime: hit.mtime ? new Date(hit.mtime) : null };
  }

  // 镜像里记着明文大小和 mtime → 不用解密也知道
  if (mirrorEnabled) {
    const info = loadMirrorMeta().files[repoFilePath(key)];
    if (info && typeof info.size === 'number') {
      return { size: info.size, mtime: info.mtime ? new Date(info.mtime) : null };
    }
  }

  let data;
  try {
    data = request('GET', apiPath(repoFilePath(key)), null);
  } catch (e) {
    if (e && e.status === 404) return null;
    throw e;
  }

  const blob = decodeContent(data);
  const plain = vaultDecrypt(blob);
  const mtime = envelopeMtime(blob);
  cacheSet(key, {
    plain: plain,
    sha: (data && data.sha) ? data.sha : null,
    mtime: mtime,
    size: Buffer.byteLength(plain, 'utf8')
  });
  return { size: Buffer.byteLength(plain, 'utf8'), mtime: mtime ? new Date(mtime) : null };
}

// -------------------------------------------------------------- 导出

module.exports = {
  name: 'github',

  readFileSync: readFileSync,
  writeFileSync: writeFileSync,
  updateFileSync: updateFileSync,
  existsSync: existsSync,
  readdirSync: readdirSync,
  mkdirSync: mkdirSync,
  rmSync: rmSync,
  statSync: statSync,

  // ---- 下面是给测试和工具用的钩子，平时别碰 ----

  /** 换掉真正的 request（测试用假的，就不用打 GitHub 网络了） */
  _setRequest: function (fn) {
    requestImpl = (typeof fn === 'function') ? fn : defaultRequest;
  },
  /** 真的 request（调试用：看看网络到底通不通） */
  _defaultRequest: defaultRequest,
  /** 还原成真的 request，清掉缓存 */
  _reset: function () {
    requestImpl = defaultRequest;
    clearCache();
  },
  /** 只清缓存（测试要确认「读回来还是原文」时用） */
  _clearCache: clearCache,
  /** 打开本地镜像（server.js 调）—— 读就走本地，不再等网络 */
  enableMirror: enableMirror,
  /** 定时把镜像跟远端对齐（server.js 调） */
  startMirrorRefresh: startMirrorRefresh,
  /** 立刻同步一次（测试用） */
  refreshMirror: refreshMirror,
  /** 镜像现在是什么情况（调试用） */
  _mirrorInfo: function () {
    const m = loadMirrorMeta();
    return {
      enabled: mirrorEnabled,
      commit: m.commit,
      files: Object.keys(m.files).length,
      updatedAt: m.updatedAt
    };
  },
  /** 看看现在配的是啥（不打印密码/token 本身） */
  _info: function () {
    return {
      owner: owner(),
      repo: repo(),
      branch: branch(),
      salt: kdfSalt(),
      iter: kdfIter(),
      hasToken: !!token(),
      hasPasscode: !!passcode(),
      cacheMs: CACHE_MS
    };
  },
  /** 逻辑路径 → 仓库路径（测试要确认 .enc 映射） */
  _repoFilePath: repoFilePath,
  _repoDirPath: repoDirPath
};
