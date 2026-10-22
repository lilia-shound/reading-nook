'use strict';
/**
 * 共读小屋 · vfs（虚拟文件系统）
 *
 * 目的：让 store.js / docs.js **不知道数据到底存在哪儿**。
 *   - 本地磁盘（默认。她电脑上 `node server.js` 跑的就是这个，一点没变）
 *   - GitHub 仓库（NOOK_BACKEND=github —— 仓库是唯一事实来源，手机/电脑/云端姜去看的是同一份）
 *
 * 路径约定：**一律相对 data/ 的 POSIX 路径（正斜杠）**，比如
 *   config.json
 *   books/b_xxx/text.txt
 *   books/b_xxx/annotations/5.json
 *
 * 不用 path.join —— Windows 会翻成反斜杠，GitHub API 不认。
 * 也不拼绝对路径：换后端以后同一个 rel 要能指向另一个地方。
 *
 * 两个后端都实现同一组接口：
 *   readFileSync(rel)             -> string          不存在要抛错，error.code === 'ENOENT'
 *   writeFileSync(rel, content)   -> void
 *   existsSync(rel)               -> boolean
 *   readdirSync(rel)              -> string[]        文件/目录名（不含路径）；目录不存在返回 []
 *   mkdirSync(rel)                -> void            目录已存在也不报错
 *   rmSync(rel, {recursive:true}) -> void
 *   statSync(rel)                 -> {size, mtime} | null
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
// NOOK_DATA_DIR：把数据放到别的地方去。
// 测试用它开一个**隔离的临时目录**，这样跑测试不会往真数据（现在是公开的 GitHub 仓库）里写东西。
const DATA = process.env.NOOK_DATA_DIR
  ? path.resolve(process.env.NOOK_DATA_DIR)
  : path.join(ROOT, 'data');
const LOCAL_CONFIG = path.join(DATA, '.local.json');

// --------------------------------------------------------------- 本地后端

/** rel（相对 data/，正斜杠）→ 绝对路径 */
function toAbs(rel) {
  const parts = String(rel || '').split('/').filter(Boolean);
  return path.join(DATA, ...parts);
}

const fsBackend = {
  name: 'fs',

  readFileSync(rel) {
    // 不加编码参数的话会返回 Buffer，调用方要的是字符串
    return fs.readFileSync(toAbs(rel), 'utf8');
  },

  writeFileSync(rel, content) {
    const file = toAbs(rel);
    const dir = path.dirname(file);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    // 临时文件 + rename：写一半断电也不会把原文件搞成半截
    const tmp = file + '.tmp-' + process.pid + '-' + Date.now();
    fs.writeFileSync(tmp, content, 'utf8');
    fs.renameSync(tmp, file);
  },

  existsSync(rel) {
    return fs.existsSync(toAbs(rel));
  },

  readdirSync(rel) {
    try {
      return fs.readdirSync(toAbs(rel));
    } catch (e) {
      if (e.code === 'ENOENT') return [];
      throw e;
    }
  },

  mkdirSync(rel) {
    fs.mkdirSync(toAbs(rel), { recursive: true });
  },

  rmSync(rel) {
    fs.rmSync(toAbs(rel), { recursive: true, force: true });
  },

  statSync(rel) {
    try {
      const s = fs.statSync(toAbs(rel));
      return { size: s.size, mtime: s.mtime };
    } catch (e) {
      return null;
    }
  }
};

// ----------------------------------------------------------- 后端选择

/**
 * 本地专用配置（**永远不推仓库**）：
 *   { "backend": "github", "passcode": "06090823", "ghToken": "ghp_xxx" }
 */
function readLocalConfig() {
  try {
    const raw = fs.readFileSync(LOCAL_CONFIG, 'utf8').replace(/^\uFEFF/, '');
    return JSON.parse(raw);
  } catch (e) {
    return null;
  }
}

let active = null;

function pickBackend() {
  const local = readLocalConfig();
  const want = String(process.env.NOOK_BACKEND || (local && local.backend) || 'fs').toLowerCase();
  if (want === 'github' || want === 'gh') {
    try {
      // eslint-disable-next-line global-require
      const gh = require('./ghbackend');
      return gh;
    } catch (e) {
      console.error('[vfs] 要用 GitHub 后端，但 lib/ghbackend.js 加载失败：' + e.message);
      console.error('[vfs] 先退回本地磁盘后端。要修的话看：' + e.message);
      return fsBackend;
    }
  }
  return fsBackend;
}

function impl() {
  if (!active) active = pickBackend();
  return active;
}

/** 换后端（测试用） */
function _setBackend(b) {
  active = b;
}

// --------------------------------------------------------------- 对外接口

const vfs = {
  get name() {
    return impl().name || 'unknown';
  },

  readFileSync(rel) {
    return impl().readFileSync(rel);
  },

  writeFileSync(rel, content) {
    return impl().writeFileSync(rel, content);
  },

  existsSync(rel) {
    return impl().existsSync(rel);
  },

  readdirSync(rel) {
    return impl().readdirSync(rel);
  },

  mkdirSync(rel) {
    return impl().mkdirSync(rel);
  },

  rmSync(rel, opts) {
    return impl().rmSync(rel, opts || { recursive: true });
  },

  statSync(rel) {
    return impl().statSync(rel);
  },

  _setBackend: _setBackend,
  readLocalConfig: readLocalConfig,
  DATA: DATA,
  ROOT: ROOT
};

module.exports = vfs;
