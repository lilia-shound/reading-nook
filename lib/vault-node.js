'use strict';
/**
 * vault-node.js —— 加密盒的 Node 版（**同步**）
 *
 * 为什么要有它：
 *   public/vault.js 是唯一的加密实现，浏览器和 Node 都用它。
 *   但它的 WebCrypto 是**异步**的，而 vfs 的接口是**同步**的（fs 风格）。
 *   原来的办法是把加解密丢进一个 `execFileSync` 子进程里跑 —— 主进程同步等它。
 *   代价是**每次加解密都要 spawn 一次 node**，光 spawn 就要 578 毫秒
 *   （实测这台机器），读一本书几十个文件，就是几十秒。
 *
 * 这里做同一件事，但**在进程内同步做完**：
 *   · PBKDF2-SHA256 → crypto.pbkdf2Sync（同步）
 *   · AES-256-GCM   → crypto.createCipheriv（同步）
 *   · 派生出来的密钥**缓存起来**（同一个密码只派生一次）→ 之后每个文件几乎不花时间
 *
 * 格式必须和 public/vault.js **一模一样**：
 *   · 信封：{"v":1,"alg":"AES-GCM","iv":base64(12字节),"ct":base64(密文+tag)}
 *   · WebCrypto 的 AES-GCM 把 16 字节的 tag 拼在密文后面，
 *     Node 把 tag 单独给 —— 这里手动拼回去，解的时候再拆下来。
 *   · 剥壳逻辑（谁把信封又 JSON.stringify 了一次）直接用 vault.js 的 unwrapEnvelope，
 *     不复制粘贴。
 *
 * 有 test/check_vault_node.js 盯着：两个方向互解，确保跑不偏。
 */

const crypto = require('crypto');
const Vault = require('../public/vault.js');   // 格式定义只有这一份

const IV_BYTES = 12;
const TAG_BYTES = 16;

// ------------------------------------------------------------ 密钥

let keyCache = null;   // { fp: 指纹, key: Buffer }

/**
 * 派生密钥（同步）。同一个密码 + 同一个盐 → 直接用缓存，不重复算 PBKDF2。
 * @param {string} passcode 密码
 * @param {string} saltB64  公开的盐（base64）
 * @param {number} [iterations]
 * @returns {Buffer} 32 字节的 AES-256 密钥
 */
function deriveKeySync(passcode, saltB64, iterations) {
  const iter = Number(iterations) || Vault.ITERATIONS;
  const fp = String(passcode) + '|' + String(saltB64) + '|' + String(iter);
  if (keyCache && keyCache.fp === fp) return keyCache.key;

  const salt = Buffer.from(String(saltB64), 'base64');
  const key = crypto.pbkdf2Sync(Buffer.from(String(passcode), 'utf8'), salt, iter, 32, 'sha256');
  keyCache = { fp: fp, key: key };
  return key;
}

/** 忘掉缓存的密钥（换了密码的时候用） */
function forgetKey() {
  keyCache = null;
}

// ------------------------------------------------------------ 加解密

/**
 * 加密一段文本，输出仓库里存的那种 JSON 字符串。
 * @param {Buffer} key  deriveKeySync 出来的密钥
 * @param {string} text 明文
 * @returns {string} JSON 字符串
 */
function encryptTextSync(key, text) {
  const iv = crypto.randomBytes(IV_BYTES);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(String(text), 'utf8'), c.final()]);
  const tag = c.getAuthTag();
  return JSON.stringify({
    v: 1,
    alg: 'AES-GCM',
    iv: iv.toString('base64'),
    // WebCrypto 把 tag 拼在密文后面 —— 这里手动拼回去
    ct: Buffer.concat([ct, tag]).toString('base64')
  });
}

/**
 * 解密。剥壳用 vault.js 的 unwrapEnvelope（谁套了多层 JSON 都能剥）。
 * @param {Buffer} key
 * @param {string} blob 仓库里存的那段字符串
 * @returns {string} 明文
 */
function decryptTextSync(key, blob) {
  const o = Vault.unwrapEnvelope(blob);
  if (!o) {
    throw new Error('vault: 这个文件不是用密码加密的（密码不对，或者它被写坏了 —— '
      + 'GitHub 历史里还有旧版本，可以用 restore_annos.js 捞回来）');
  }
  const raw = Buffer.from(String(o.ct || ''), 'base64');
  if (raw.length < TAG_BYTES) {
    throw new Error('vault: 密文长度不对（解不开）');
  }
  const tag = raw.slice(raw.length - TAG_BYTES);
  const ct = raw.slice(0, raw.length - TAG_BYTES);
  try {
    const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(String(o.iv || ''), 'base64'));
    d.setAuthTag(tag);
    return Buffer.concat([d.update(ct), d.final()]).toString('utf8');
  } catch (e) {
    throw new Error('vault: 密码不对，解不开（或者这个文件被改过了）');
  }
}

/** 解密并 parse 成 JSON */
function decryptJsonSync(key, blob) {
  const text = decryptTextSync(key, blob);
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error('vault: 解出来不是 JSON');
  }
}

module.exports = {
  deriveKeySync: deriveKeySync,
  forgetKey: forgetKey,
  encryptTextSync: encryptTextSync,
  decryptTextSync: decryptTextSync,
  decryptJsonSync: decryptJsonSync,
  unwrapEnvelope: Vault.unwrapEnvelope,
  ITERATIONS: Vault.ITERATIONS
};
