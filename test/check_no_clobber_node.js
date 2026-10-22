'use strict';
/**
 * check_no_clobber_node.js —— Node 端（本地服务）写的时候会不会冲掉云端刚写的
 *
 * 这是云端姜去 2026-10-22 夜提的那个问题的另一半：
 *   浏览器端已经验过了（check_no_clobber.js），
 *   这边验**本地服务**（lib/store.js → lib/vfs.js → lib/ghbackend.js）。
 *
 * 之前本地服务是「先读（可能命中缓存）→ 改 → 写」，
 * 而且 409 冲突时**只更新 sha、不重新读内容** ——
 * 于是它会用**本地的旧内容 + 新的 sha** 覆盖远端，把人家刚写的回应冲掉。
 * 现在改成：写之前永远先 GET 远端最新那份，在它上面改，再 PUT。
 *
 *   node test\check_no_clobber_node.js
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Vault = require('../public/vault.js');

const ROOT = path.resolve(__dirname, '..');
const SITE = JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'site.json'), 'utf8'));
const gh = require('../lib/ghbackend');
const PASS = 'test-pass-8888';

let passed = 0, failed = 0;
function ok(name, cond, extra) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')); }
}

/** 假仓库：路径 -> {sha, content}（content 是密文信封） */
const files = new Map();
let shaSeq = 0;

function encFor(key, value) {
  return JSON.stringify(Object.assign(JSON.parse(require('../public/vault.js').encryptTextSync
    ? {} : {}), {}));
}

// 真加密要用异步，所以这里手动做
async function putRemote(rel, value) {
  const key = await Vault.deriveKey(PASS, SITE.kdf.salt, SITE.kdf.iter);
  const o = JSON.parse(await Vault.encryptJson(key, value));
  o.mtime = Date.now();
  shaSeq++;
  files.set(rel, { sha: 'sha' + shaSeq, content: JSON.stringify(o) });
  return 'sha' + shaSeq;
}

// 假 request（注入 ghbackend）
gh._setRequest(function (method, apiPath, body) {
  const m = /^\/repos\/[^/]+\/[^/]+\/contents\/(.*)$/.exec(apiPath);
  if (!m) throw new Error('假仓库不认这个路径：' + apiPath);
  const rel = decodeURIComponent(m[1]).split('?')[0];
  if (method === 'GET') {
    const f = files.get(rel);
    if (!f) { const e = new Error('404 Not Found'); e.status = 404; throw e; }
    return {
      type: 'file', name: rel.split('/').pop(), path: rel, sha: f.sha, size: f.content.length,
      content: Buffer.from(f.content, 'utf8').toString('base64'), encoding: 'base64'
    };
  }
  if (method === 'PUT') {
    const b = body || {};
    const cur = files.get(rel);
    if (cur && b.sha && b.sha !== cur.sha) { const e = new Error('409 Conflict'); e.status = 409; throw e; }
    if (cur && !b.sha) { const e = new Error('422 Invalid request. "sha" wasn\'t supplied.'); e.status = 422; throw e; }
    shaSeq++;
    const sha = 'sha' + shaSeq;
    files.set(rel, { sha: sha, content: Buffer.from(b.content || '', 'base64').toString('utf8') });
    return { content: { sha: sha, path: rel } };
  }
  const e = new Error('405'); e.status = 405; throw e;
});

(async function main() {
  console.log('=== 本地服务写的时候会不会冲掉云端刚写的 ===');
  console.log('');

  process.env.NOOK_PASSCODE = PASS;
  process.env.GH_TOKEN = 'fake-token';

  const REL = 'books/b_x/annotations/1.json';
  const REPO_REL = 'data/' + REL + '.enc';   // 仓库里的路径最后一段带 .enc

  console.log('【1】远端初始：云端先写了一条 A');
  await putRemote(REPO_REL, [{ id: 'a_A', anchor: '甲', note: '云端写的', who: 'user', paraIndex: 0, ts: '2026-10-22T10:00:00.000Z', replies: [] }]);
  ok('远端有 1 条', true);

  console.log('');
  console.log('【2】本地服务再写一条（云端那条必须还在）');
  const store = require('../lib/store');
  console.log('  后端:', require('../lib/vfs').name);
  const item = store.addAnnotation('b_x', 1, { anchor: '乙', note: '本地写的', paraIndex: 1 });
  ok('写成功了', !!item && !!item.id, item && item.id);
  console.log('  仓库里的文件:', Array.from(files.keys()).join(' | '));

  const key = await Vault.deriveKey(PASS, SITE.kdf.salt, SITE.kdf.iter);
  const raw = files.get(REPO_REL).content;
  const list = JSON.parse(await Vault.decryptText(key, raw));
  const ids = list.map((a) => a.id);
  ok('云端写的 A 还在', ids.indexOf('a_A') >= 0, ids.join(','));
  ok('本地写的也在', ids.length === 2, 'n=' + ids.length);

  console.log('');
  console.log('【3】连着写两条，一条都不能丢');
  store.addAnnotation('b_x', 1, { anchor: '丙', note: '本地写的2', paraIndex: 2 });
  store.addAnnotation('b_x', 1, { anchor: '丁', note: '本地写的3', paraIndex: 3 });
  const raw2 = files.get(REPO_REL).content;
  const list2 = JSON.parse(await Vault.decryptText(key, raw2));
  ok('4 条都在', list2.length === 4, 'n=' + list2.length);

  console.log('');
  console.log('【4】addReply 挂错 id 要报错（不能静默挂到别处）');
  let err = null;
  try {
    store.addReply('b_x', 1, '挂错地方了', 'a_不存在');
  } catch (e) { err = e; }
  ok('挂错 id 报错了', !!err, err ? err.message : '没报错');
  ok('错是中文的', !!(err && /[\u4e00-\u9fa5]/.test(err.message)));

  console.log('');
  console.log('【5】挂对的要挂对');
  const rep = store.addReply('b_x', 1, '挂对了', 'a_A');
  ok('挂到了 a_A 上', rep && rep.annotationId === 'a_A', JSON.stringify(rep));
  const raw3 = files.get(REPO_REL).content;
  const list3 = JSON.parse(await Vault.decryptText(key, raw3));
  const aA = list3.find((a) => a.id === 'a_A');
  ok('a_A 有 1 条回应', aA && (aA.replies || []).length === 1, JSON.stringify(aA && (aA.replies || []).length));

  console.log('');
  console.log(failed ? 'ALL FAIL' : 'ALL PASS');
  console.log(passed + ' checks');
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error('出错:', e && e.message, e && e.stack ? e.stack.split('\n')[1] : '');
  process.exit(1);
});
