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
