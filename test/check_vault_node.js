'use strict';
/**
 * check_vault_node.js —— 进程内加密（lib/vault-node.js）必须和 public/vault.js 一模一样
 *
 * 为什么要有这个测试：
 *   public/vault.js 是**唯一的加密实现**（浏览器用它是异步的）。
 *   为了让同步的 vfs 能用，Node 那边另有一份同步实现（lib/vault-node.js）。
 *   两份实现一旦跑偏，表现是**静悄悄的**：一边加密一边解不开，
 *   或者更糟 —— 解开了但数据是乱的。所以必须互相盯着。
 *
 * 跑：node test\check_vault_node.js
 */

const path = require('path');
const Vault = require(path.join(__dirname, '..', 'public', 'vault.js'));
const VaultNode = require(path.join(__dirname, '..', 'lib', 'vault-node.js'));

const PASS = 'self-test-passcode';
const SALT = Buffer.from('0123456789abcdef', 'utf8').toString('base64');   // 16 字节
const ITER = 5000;    // 测试用少迭代，跑得快（正式是 210000）

let pass = 0;
let fail = 0;

function check(name, fn) {
  try {
    const r = fn();
    if (r === false) throw new Error('条件不成立');
    console.log('  ✓ ' + name);
    pass++;
  } catch (e) {
    console.log('  ✗ ' + name + ' —— ' + (e && e.message ? e.message : e));
    fail++;
  }
}

async function main() {
  console.log('=== 信封格式两边一致 ===');

  const key = await Vault.deriveKey(PASS, SALT, ITER);
  const nodeKey = VaultNode.deriveKeySync(PASS, SALT, ITER);

  const text = '共读小屋 · 测试文本\n第二行：山鹑的足迹好似箭头\n';

  const blobA = await Vault.encryptText(key, text);
  check('vault.js 加密 → vault-node 解密，字一样', () => {
    return VaultNode.decryptTextSync(nodeKey, blobA) === text;
  });

  const blobB = VaultNode.encryptTextSync(nodeKey, text);
  let backOk = false;
  try {
    const back = await Vault.decryptText(key, blobB);
    backOk = (back === text);
  } catch (e) {
    backOk = false;
  }
  check('vault-node 加密 → vault.js 解密，字一样', () => backOk);

  check('信封的字段名一样（v / alg / iv / ct）', () => {
    const a = JSON.parse(blobA);
    const b = JSON.parse(blobB);
    const ka = Object.keys(a).sort().join(',');
    const kb = Object.keys(b).sort().join(',');
    if (ka !== kb) throw new Error(ka + ' ≠ ' + kb);
    if (a.v !== 1) throw new Error('v 不是 1');
    if (a.alg !== 'AES-GCM') throw new Error('alg 不是 AES-GCM');
    return true;
  });

  check('iv 是 12 字节、base64 标准编码', () => {
    const iv = Buffer.from(JSON.parse(blobA).iv, 'base64');
    if (iv.length !== 12) throw new Error('iv 长度 ' + iv.length);
    return true;
  });

  console.log('');
  console.log('=== 各种坏情况 ===');

  check('密码不对要报错（不能静悄悄解出乱码）', () => {
    const wrong = VaultNode.deriveKeySync('另一个密码', SALT, ITER);
    let threw = false;
    try { VaultNode.decryptTextSync(wrong, blobA); } catch (e) { threw = true; }
    if (!threw) throw new Error('竟然没报错');
    return true;
  });

  check('套了两层 JSON 的密文也能解开（剥壳上限内）', () => {
    const doubled = JSON.stringify(blobA);
    return VaultNode.decryptTextSync(nodeKey, doubled) === text;
  });

  check('套了三层 JSON → 剥不动，要说人话而不是乱解', () => {
    const tripled = JSON.stringify(JSON.stringify(blobA));
    let msg = '';
    try { VaultNode.decryptTextSync(nodeKey, tripled); } catch (e) { msg = String(e.message || ''); }
    if (!msg) throw new Error('竟然解开了 —— 那说明在乱解，更糟');
    if (!/加密|解不开|密码/.test(msg)) throw new Error('错里没说清楚：' + msg);
    return true;
  });

  check('根本不是密文 → 报错说人话', () => {
    let msg = '';
    try { VaultNode.decryptTextSync(nodeKey, '{"hello":1}'); } catch (e) { msg = String(e.message || ''); }
    if (!/加密|解不开|密码/.test(msg)) throw new Error('错里没说清楚：' + msg);
    return true;
  });

  console.log('');
  console.log('=== 密钥缓存 ===');

  check('派生两次拿到的是同一个密钥对象', () => {
    const a = VaultNode.deriveKeySync(PASS, SALT, ITER);
    const b = VaultNode.deriveKeySync(PASS, SALT, ITER);
    return a === b;
  });

  check('密码变了 → 拿到的是不同的密钥', () => {
    const a = VaultNode.deriveKeySync(PASS, SALT, ITER);
    const b = VaultNode.deriveKeySync('换个密码', SALT, ITER);
    return a !== b;
  });

  console.log('');
  console.log('=== 性能（原来每次都要 spawn 一个 node） ===');
  const t0 = Date.now();
  for (let i = 0; i < 200; i++) {
    VaultNode.decryptTextSync(nodeKey, blobA);
  }
  const per = (Date.now() - t0) / 200;
  console.log('  解密一次 ' + per.toFixed(3) + ' 毫秒（200 次）');
  check('解密快到可以忽略（< 5 毫秒一次）', () => per < 5);

  console.log('');
  console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  if (fail) process.exit(1);
}

main().catch((e) => {
  console.error('测试自己挂了：', e);
  process.exit(1);
});
