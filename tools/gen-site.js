'use strict';
/**
 * gen-site.js —— 生成 public/site.json
 *
 * site.json 是**故意公开**的：仓库位置、KDF 参数、盐、显示用的名字。
 * 它里面没有密码、没有密钥、没有 token。
 * 盐不是秘密 —— 密钥才是，而密钥只从「密码」当场派生。
 *
 *   node tools/gen-site.js            # 已存在就原样保留盐
 *   node tools/gen-site.js --new-salt # 换盐（所有数据都要重加密，别乱点）
 */

const fs = require('fs');
const path = require('path');
const Vault = require('../public/vault.js');

const ROOT = path.resolve(__dirname, '..');
const FILE = path.join(ROOT, 'public', 'site.json');

const args = process.argv.slice(2);
const wantNewSalt = args.includes('--new-salt');
const branch = process.env.GH_BRANCH || 'main';
const owner = process.env.GH_OWNER || 'lilia-shound';
const repo = process.env.GH_REPO_NAME || 'reading-nook';

let salt = null;
if (!wantNewSalt && fs.existsSync(FILE)) {
  try {
    salt = JSON.parse(fs.readFileSync(FILE, 'utf8')).kdf.salt;
  } catch (e) { salt = null; }
}
if (!salt) salt = Vault.randomSaltB64();

const site = {
  mode: 'static',
  owner: owner,
  repo: repo,
  branch: branch,
  kdf: {
    algo: 'PBKDF2-SHA256',
    iter: Vault.ITERATIONS,
    salt: salt
  },
  names: {
    user: '姜来',
    ai: '姜去'
  },
  subtitle: '姜来 & 姜去',
  login_hint: '两个人的生日相加',
  // 静态版没有后端，所以「上传图书 / 生成剧情笔记 / 工作台」这些用不了。
  // 这一版专注：读、划线、写字、等姜去回话。
  static_only: ['upload', 'notes', 'workbench', 'settings-server', 'ai-auto'],
  updatedAt: new Date().toISOString()
};

fs.writeFileSync(FILE, JSON.stringify(site, null, 2) + '\n', 'utf8');
console.log('已写 public/site.json');
console.log('  仓库:', owner + '/' + repo + '@' + branch);
console.log('  盐  :', salt);
console.log('  迭代:', Vault.ITERATIONS);

// 把「电脑那版现在的局域网地址」也带上 —— 静态版写失败时要给她一个能点的链接，
// 而那个链接要是靠网络去读 data/endpoints.json.enc，在公司网络下正好读不到。
// 内联一份，零网络依赖；实时那份（换 Wi-Fi 自动更新）在静态版里优先用。
try {
  const vfs = require('../lib/vfs');
  const ep = JSON.parse(vfs.readFileSync('endpoints.json'));
  if (ep && ep.lan) {
    site.fallbackLan = ep.lan;
    console.log('  兜底局域网地址:', ep.lan, '（写失败时直接给链接）');
  }
} catch (e) {
  console.log('  （没读到局域网地址，跳过兜底）');
}
fs.writeFileSync(FILE, JSON.stringify(site, null, 2) + '\n', 'utf8');

// 同一份配置再内联成一份脚本 —— 让浏览器**启动时一个网络请求都不用发**。
// 起因：site.json 放在 Pages 上，而 Pages 的 CDN 会抖（实测 403 / ECONNRESET / 超时）。
// 一抖 → 读不到 site.json → 连登录框都出不来 → 整个站点打不开。
// 内联之后，配置跟着站点代码一起走，零依赖。
const inline = '/*!\n'
  + ' * site-inline.js —— 由 tools/gen-site.js 生成，**别手改**\n'
  + ' *\n'
  + ' * 站点配置的「随身副本」：让浏览器启动时不必先去网络拿 site.json\n'
  + ' *（Pages 的 CDN 会抖，一抖就整个站点开不了门）\n'
  + ' *\n'
  + ' * 改了配置就重新跑 `node tools/gen-site.js`，然后 `node tools/push-repo.js --site`\n'
  + ' */\n'
  + 'window.NOOK_SITE = ' + JSON.stringify(site, null, 2) + ';\n';
const INLINE_FILE = path.join(ROOT, 'public', 'site-inline.js');
fs.writeFileSync(INLINE_FILE, inline, 'utf8');
console.log('已写 public/site-inline.js（浏览器启动不用发请求了）');
