'use strict';
/**
 * check_repo_data.js —— 验仓库里存的东西是不是真的密文
 *
 * 这套方案的地基是「仓库是公开的，但里面的数据是密文」。
 * 所以必须真的去 GitHub 上把文件拉下来验，而不是相信推送脚本。
 *
 *   node test/check_repo_data.js
 */

const https = require('https');
const path = require('path');
const Vault = require('../public/vault.js');

const site = require(path.join(__dirname, '..', 'public', 'site.json'));
const RAW = 'https://raw.githubusercontent.com/' + site.owner + '/' + site.repo + '/' + site.branch + '/';

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  → ' + extra : '')); }
}

function getOnce(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'nook-check' } }, (res) => {
      const cs = [];
      res.on('data', (c) => cs.push(c));
      res.on('end', () => {
        const body = Buffer.concat(cs).toString('utf8');
        if (res.statusCode >= 200 && res.statusCode < 300) resolve(body);
        else { const e = new Error('HTTP ' + res.statusCode); e.status = res.statusCode; reject(e); }
      });
    }).on('error', reject);
  });
}

/**
 * 网络层会抖 —— 实测这台机器上偶尔会**连续一两分钟**连不上 raw.githubusercontent.com
 * （表现是 ECONNRESET / UND_ERR_CONNECT_TIMEOUT）。
 * 那不是代码坏了，是网络在断。这种时候重试几次就好了，
 * 不重试的话测试会「红」得毫无意义，还容易让人以为改坏了什么。
 */
function get(url, times) {
  const n = times === undefined ? 4 : times;
  return getOnce(url).catch((e) => {
    const st = e && e.status;
    const net = st === undefined || st === 0 || st >= 500;
    if (net && n > 1) {
      return new Promise((r) => setTimeout(r, 800 * (5 - n))).then(() => get(url, n - 1));
    }
    throw e;
  });
}

function passcode() {
  if (process.env.NOOK_PASSCODE) return process.env.NOOK_PASSCODE;
  try {
    const cfg = JSON.parse(require('fs').readFileSync(path.join(__dirname, '..', 'data', 'config.json'), 'utf8'));
    if (cfg.passcode) return cfg.passcode;
  } catch (e) { /* ignore */ }
  return '06090823';
}

(async () => {
  console.log('仓库:', site.owner + '/' + site.repo + '@' + site.branch);
  console.log('');

  const key = await Vault.deriveKey(passcode(), site.kdf.salt, site.kdf.iter);

  console.log('=== 仓库里有没有明文 ===');
  const lib = await get(RAW + 'data/library.json.enc');
  ok('library.json.enc 是信封格式', /"alg"\s*:\s*"AES-GCM"/.test(lib) && /"ct"\s*:/.test(lib));
  ok('library.json.enc 里有 mtime', /"mtime"\s*:\s*\d+/.test(lib));
  ok('library.json.enc 看不到书名', lib.indexOf('古道') < 0 && lib.indexOf('示例书') < 0);
  ok('library.json.enc 看不到中文正文', !/[\u4e00-\u9fa5]{4,}/.test(lib));

  const cfgBlob = await get(RAW + 'data/config.json.enc');
  ok('config.json.enc 看不到明文密码', cfgBlob.indexOf('06090823') < 0);
  ok('config.json.enc 是密文', /"ct"\s*:/.test(cfgBlob));

  console.log('');
  console.log('=== 该藏起来的没推上去 ===');
  for (const p of ['data/.local.json.enc', 'data/logs/deepseek.json.enc']) {
    let exists = true;
    try { await get(RAW + p); } catch (e) { if (e.status === 404) exists = false; }
    ok(p + ' 不在仓库里', !exists);
  }
  // 隧道地址**是要在仓库里的**（静态版靠它找到「改走家里电脑代写」那条路），
  // 但必须是密文 —— 里面是那个隧道域名。
  let tunnelBlob = '';
  let tunnelThere = true;
  try { tunnelBlob = await get(RAW + 'data/tunnel.json.enc'); } catch (e) { if (e.status === 404) tunnelThere = false; }
  ok('data/tunnel.json.enc 在仓库里（静态版要靠它找代写通道）', tunnelThere);
  ok('data/tunnel.json.enc 是密文', tunnelThere && /"ct"\s*:/.test(tunnelBlob));
  ok('data/tunnel.json.enc 看不到隧道域名', tunnelThere && tunnelBlob.indexOf('trycloudflare.com') < 0);

  console.log('');
  console.log('=== 密码对了能解开 ===');
  const books = await Vault.decryptJson(key, lib);
  ok('解出书架是数组', Array.isArray(books), typeof books);
  ok('书架里有书', books.length >= 2, 'books=' + books.length);
  const gudao = books.find((b) => b.title === '古道');
  ok('《古道》在', !!gudao);
  if (gudao) {
    ok('《古道》24 章', gudao.chapterCount === 24, 'chapterCount=' + gudao.chapterCount);
    ok('《古道》有 19 份剧情笔记', Object.keys(gudao.notes || {}).length === 19,
      'notes=' + Object.keys(gudao.notes || {}).length);
  }

  const cfg = await Vault.decryptJson(key, cfgBlob);
  ok('config 里没有 passcode', !('passcode' in cfg), Object.keys(cfg).join(','));
  ok('config 里没有 deepseek_api_key', !('deepseek_api_key' in cfg));
  ok('config 里还有 user_name', cfg.user_name === '姜来', String(cfg.user_name));

  console.log('');
  console.log('=== 密码错了解不开 ===');
  let threw = false;
  try {
    const bad = await Vault.deriveKey('99999999', site.kdf.salt, site.kdf.iter);
    await Vault.decryptJson(bad, lib);
  } catch (e) { threw = true; }
  ok('错密码解不开（抛错）', threw);

  console.log('');
  console.log('=== 正文也在 ===');
  const textBlob = await get(RAW + 'data/books/' + gudao.id + '/text.txt.enc');
  ok('正文是密文', /"ct"\s*:/.test(textBlob));
  ok('正文里看不到"古道"', textBlob.indexOf('古道') < 0);
  const plain = await Vault.decryptText(key, textBlob);
  ok('正文能解开', plain.length > 1000, 'len=' + plain.length);
  ok('解出来的正文是中文', /[\u4e00-\u9fa5]/.test(plain));

  console.log('');
  console.log('=== 批注也在 ===');
  const annoBlob = await get(RAW + 'data/books/' + gudao.id + '/annotations/5.json.enc');
  const annos = await Vault.decryptJson(key, annoBlob);
  // 条数**不写死** —— 姜来和云端姜去一直在加，写死就会某天突然「失败」
  ok('第 5 章有批注', Array.isArray(annos) && annos.length >= 3, 'n=' + (annos || []).length);
  ok('每条都有姜去的回应', (annos || []).every((a) => a.replies && a.replies.length),
    JSON.stringify((annos || []).map((a) => (a.replies || []).length)));

  console.log('');
  console.log(fail ? 'ALL FAIL' : 'ALL PASS');
  console.log(pass + ' checks');
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('出错:', e.message, e.stack ? e.stack.split('\n')[1] : '');
  process.exit(1);
});
