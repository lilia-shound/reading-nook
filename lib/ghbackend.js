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
const VAULT_FILE = path.join(ROOT, 'public', 'vault.js');
const API = 'https://api.github.com';

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
      windowsHide: true
    });
  } catch (e) {
    const detail = (e && e.stderr) ? String(e.stderr).trim() : '';
    const msg = (e && e.message) ? String(e.message) : '不知道怎么了';
    throw new Error('内部子进程跑挂了：' + (detail || msg));
  }
  try {
    return JSON.parse(out);
  } catch (e) {
    throw new Error('内部子进程返回的不是 JSON：' + String(out).slice(0, 200));
  }
}

/** 加解密用的子进程：require 的是 public/vault.js（唯一那份加密实现） */
const CRYPTO_SRC = `
const chunks = [];
process.stdin.on('data', function (c) { chunks.push(c); });
process.stdin.on('end', async function () {
  let out;
  try {
    const req = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const Vault = require(req.vaultPath);
    const key = await Vault.deriveKey(req.passcode, req.salt, req.iter);
    if (req.op === 'encrypt') {
      out = { ok: true, value: await Vault.encryptText(key, req.text) };
    } else if (req.op === 'decrypt') {
      out = { ok: true, value: await Vault.decryptText(key, req.text) };
    } else {
      out = { ok: false, error: '不会的操作：' + req.op };
    }
  } catch (e) {
    out = { ok: false, error: (e && e.message) ? e.message : String(e) };
  }
  process.stdout.write(Buffer.from(JSON.stringify(out), 'utf8'));
});
`;

/** 发 HTTP 用的子进程：只用 https 标准库（不碰 fetch，免得 Node 版本有差别） */
const HTTP_SRC = `
const https = require('https');
const chunks = [];
process.stdin.on('data', function (c) { chunks.push(c); });
process.stdin.on('end', function () {
  const req = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  const u = new URL(req.url);
  const headers = req.headers || {};
  const body = (req.body === undefined || req.body === null) ? null : Buffer.from(req.body, 'utf8');
  if (body) headers['Content-Length'] = body.length;
  const done = function (status, text) {
    process.stdout.write(Buffer.from(JSON.stringify({ status: status, text: text }), 'utf8'));
  };
  const r = https.request({
    method: req.method,
    hostname: u.hostname,
    path: u.pathname + u.search,
    headers: headers
  }, function (res) {
    const cs = [];
    res.on('data', function (c) { cs.push(c); });
    res.on('end', function () { done(res.statusCode, Buffer.concat(cs).toString('utf8')); });
  });
  r.on('error', function (e) { done(0, String((e && e.message) || e)); });
  if (body) r.write(body);
  r.end();
});
`;

// ------------------------------------------------------------ 加解密

function vaultEncrypt(text) {
  const pc = passcode();
  if (!pc) {
    throw new Error('没有密码，存不进去。设一个环境变量 NOOK_PASSCODE，或者写进 data/.local.json 的 passcode 字段。');
  }
  const res = runChild(CRYPTO_SRC, {
    op: 'encrypt',
    passcode: pc,
    vaultPath: VAULT_FILE,
    salt: kdfSalt(),
    iter: kdfIter(),
    text: String(text)
  });
  if (!res || !res.ok) {
    throw new Error('加密失败：' + ((res && res.error) || '不知道怎么了'));
  }
  return String(res.value);
}

function vaultDecrypt(blob) {
  const pc = passcode();
  if (!pc) {
    throw new Error('没有密码，解不开密文。设一个环境变量 NOOK_PASSCODE，或者写进 data/.local.json 的 passcode 字段。');
  }
  const res = runChild(CRYPTO_SRC, {
    op: 'decrypt',
    passcode: pc,
    vaultPath: VAULT_FILE,
    salt: kdfSalt(),
    iter: kdfIter(),
    text: String(blob)
  });
  if (!res || !res.ok) {
    // code = 'EVAULT'：跟「文件不存在」分得开，调用方能一眼看出是密码的事
    const e = new Error('vault: 密码不对，解不开（密码写错了，或者这个文件不是用这个密码加密的）'
      + ((res && res.error) ? '　—— ' + res.error : ''));
    e.code = 'EVAULT';
    throw e;
  }
  return String(res.value);
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

function request(method, apiPath, body) {
  return requestImpl(method, apiPath, body);
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

/** 清缓存 */
function clearCache() {
  cache.clear();
  cachePasscode = null;
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
  let d;
  try {
    d = request('GET', apiPath(rel), null);
  } catch (e) {
    if (e && e.status === 404) return [];
    throw e;
  }
  return Array.isArray(d) ? d : [];
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

  const rp = repoFilePath(key);
  let data;
  try {
    data = request('GET', apiPath(rp), null);
  } catch (e) {
    if (e && e.status === 404) throw enoent(key);
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
      return;
    } catch (e) {
      lastErr = e;
      if (e && e.status === 409 && attempt < 3) {
        // 有人同时在改：重读最新的 sha，合并后再写
        sha = fileSha(rp);
        continue;
      }
      throw new Error('写不进去 ' + key + '：' + ((e && e.message) ? e.message : '不知道怎么了'));
    }
  }
  throw new Error('写不进去 ' + key + '：冲突重试了 3 次还是不行（'
    + ((lastErr && lastErr.message) ? lastErr.message : '未知原因') + '）');
}

/** 文件（或目录）在不在 */
function existsSync(rel) {
  const key = normalizeRel(rel);
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
  const entries = listDir(repoDirPath(key));
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
