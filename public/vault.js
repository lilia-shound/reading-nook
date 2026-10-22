/*!
 * vault.js —— 共读小屋的「加密盒」
 *
 * 一份代码，浏览器和 Node 都能用（UMD）。**这是唯一的加密实现**，
 * 浏览器端和 Node 端都从这里取，两边不会跑偏。
 *
 * 密钥怎么来的：
 *   密码（她自己定的那个）→ PBKDF2-SHA256(盐, 迭代数) → AES-256-GCM 密钥
 *   盐和迭代数放在 site.json（**故意公开** —— 盐不是秘密，密钥才是）。
 *   密码本身**不存在于任何地方**：不在仓库里、不在构建产物里、不在配置文件里。
 *   它只在她输入的那一刻被用来派生密钥，然后就没了。
 *
 * 仓库里存的是什么：
 *   每个数据文件都是一段 JSON：{"v":1,"alg":"AES-GCM","iv":"...","ct":"..."}
 *   ct 是密文。别人拿到仓库也只能看到一堆看不懂的字节。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Vault = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var ITERATIONS = 210000; // PBKDF2 迭代数。手机上也只慢半秒左右。
  var SALT_BYTES = 16;
  var IV_BYTES = 12;

  // ---------------------------------------------------------- base64

  function b64encode(bytes) {
    if (typeof Buffer !== 'undefined' && Buffer.from) {
      return Buffer.from(bytes).toString('base64');
    }
    var bin = '';
    for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  }

  function b64decode(str) {
    if (typeof Buffer !== 'undefined' && Buffer.from) {
      return new Uint8Array(Buffer.from(String(str), 'base64'));
    }
    var bin = atob(String(str));
    var out = new Uint8Array(bin.length);
    for (var j = 0; j < bin.length; j++) out[j] = bin.charCodeAt(j);
    return out;
  }

  function toBytes(str) {
    return new TextEncoder().encode(String(str));
  }

  function fromBytes(bytes) {
    return new TextDecoder().decode(bytes);
  }

  function subtle() {
    var c = (typeof globalThis !== 'undefined' ? globalThis.crypto : undefined);
    if (!c || !c.subtle) {
      throw new Error('vault: 这个环境没有 WebCrypto（需要 HTTPS 或 localhost）');
    }
    return c.subtle;
  }

  // ------------------------------------------------------------- 盐

  function randomSaltB64() {
    var bytes = new Uint8Array(SALT_BYTES);
    (typeof globalThis !== 'undefined' ? globalThis.crypto : {}).getRandomValues(bytes);
    return b64encode(bytes);
  }

  // ------------------------------------------------------------- 密钥

  /**
   * 从密码派生密钥。
   * @param {string} passcode 密码
   * @param {string} saltB64  公开的盐（base64）
   * @param {number} [iterations]
   * @returns {Promise<CryptoKey>} 不可导出的 AES-GCM 密钥
   */
  async function deriveKey(passcode, saltB64, iterations) {
    var iter = Number(iterations) || ITERATIONS;
    var base = await subtle().importKey('raw', toBytes(passcode), 'PBKDF2', false, ['deriveKey']);
    return subtle().deriveKey(
      { name: 'PBKDF2', salt: b64decode(saltB64), iterations: iter, hash: 'SHA-256' },
      base,
      { name: 'AES-GCM', length: 256 },
      false, // 不可导出：密钥进不了 localStorage，只能活在内存里
      ['encrypt', 'decrypt']
    );
  }

  // ------------------------------------------------------------- 加解密

  /**
   * 加密一段文本，输出仓库里存的那种 JSON 字符串。
   */
  async function encryptText(key, text) {
    var iv = new Uint8Array(IV_BYTES);
    (typeof globalThis !== 'undefined' ? globalThis.crypto : {}).getRandomValues(iv);
    var ct = await subtle().encrypt({ name: 'AES-GCM', iv: iv }, key, toBytes(text));
    return JSON.stringify({
      v: 1,
      alg: 'AES-GCM',
      iv: b64encode(iv),
      ct: b64encode(new Uint8Array(ct))
    });
  }

  /**
   * 解密。密码不对的话，WebCrypto 会直接抛错（认证标签对不上）——
   * 这正是「密码对不对」的唯一判据，比比哈希字符串可靠。
   */
  async function decryptText(key, blob) {
    var o = blob;
    if (typeof o === 'string') {
      try {
        o = JSON.parse(o);
      } catch (e) {
        throw new Error('vault: 这段不是加密数据');
      }
    }
    if (!o || o.v !== 1 || o.alg !== 'AES-GCM' || !o.iv || !o.ct) {
      throw new Error('vault: 格式不认识');
    }
    var pt = await subtle().decrypt(
      { name: 'AES-GCM', iv: b64decode(o.iv) },
      key,
      b64decode(o.ct)
    );
    return fromBytes(new Uint8Array(pt));
  }

  /** 加密一个 JSON 值（自动 stringify） */
  async function encryptJson(key, value) {
    return encryptText(key, JSON.stringify(value));
  }

  /** 解密并 parse 成 JSON */
  async function decryptJson(key, blob) {
    var text = await decryptText(key, blob);
    try {
      return JSON.parse(text);
    } catch (e) {
      throw new Error('vault: 解出来不是 JSON');
    }
  }

  return {
    ITERATIONS: ITERATIONS,
    b64encode: b64encode,
    b64decode: b64decode,
    randomSaltB64: randomSaltB64,
    deriveKey: deriveKey,
    encryptText: encryptText,
    decryptText: decryptText,
    encryptJson: encryptJson,
    decryptJson: decryptJson
  };
});
