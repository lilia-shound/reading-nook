'use strict';
/**
 * GitHub 后端（lib/ghbackend.js）的自检。
 *
 * **不碰真网络**：注入一个假的 request，内存里假装有个 GitHub 仓库。
 * 假的仓库也照着真的规矩来：
 *   · 文件放 data/ 下面，最后一段带 .enc
 *   · GET 文件返回 base64 内容（还带换行，跟 GitHub 真的一样）
 *   · PUT 时 sha 对不上就 409（逼着后端重读重试）
 *   · DELETE 要 sha
 *
 * 跑：node test\check_ghbackend.js
 */

const gh = require('../lib/ghbackend');
const ghStore = require('../tools/gh-store.js');
const path = require('path');

let pass = 0, fail = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) {
    pass++;
    console.log('  PASS  ' + name + '  ->  ' + JSON.stringify(got));
  } else {
    fail++;
    console.log('  FAIL  ' + name + '  ->  got ' + JSON.stringify(got) + ', want ' + JSON.stringify(want));
  }
}
function checkTrue(name, got) {
  check(name, !!got, true);
}

// ------------------------------------------------------------ 假的仓库

function makeFakeRepo() {
  const files = new Map(); // 仓库路径 -> {sha, content(base64), size}
  const stat = { get: 0, put: 0, del: 0, conflictOnce: false };

  function b64WithBreaks(b64) {
    return (b64.match(/.{1,60}/g) || []).join('\n');
  }

  function listing(dir) {
    const prefix = dir === 'data' ? 'data/' : dir + '/';
    const dirs = new Map();
    const plain = [];
    for (const [full, rec] of files) {
      if (full.indexOf(prefix) !== 0) continue;
      const rel = full.slice(prefix.length);
      const slash = rel.indexOf('/');
      if (slash < 0) {
        plain.push({ name: rel, path: full, type: 'file', sha: rec.sha, size: rec.size });
      } else {
        const name = rel.slice(0, slash);
        if (!dirs.has(name)) dirs.set(name, { name: name, path: prefix + name, type: 'dir', sha: null, size: 0 });
      }
    }
    const all = Array.from(dirs.values()).concat(plain);
    all.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return all;
  }

  function err(status, message) {
    const e = new Error(status + ' ' + message);
    e.status = status;
    return e;
  }

  function request(method, apiPath, body) {
    const m = /^\/repos\/([^/]+)\/([^/]+)\/contents\/(.*)$/.exec(apiPath);
    if (!m) throw new Error('假仓库不认这个路径：' + apiPath);
    const rest = m[3];
    const qi = rest.indexOf('?');
    const pathPart = qi >= 0 ? rest.slice(0, qi) : rest;
    const p = decodeURIComponent(pathPart);
    const name = p.slice(p.lastIndexOf('/') + 1);

    if (method === 'GET') {
      stat.get++;
      const rec = files.get(p);
      if (rec) {
        return {
          type: 'file', name: name, path: p, sha: rec.sha, size: rec.size,
          content: b64WithBreaks(rec.content), encoding: 'base64'
        };
      }
      const kids = listing(p);
      if (kids.length) return kids;
      throw err(404, 'Not Found');
    }

    if (method === 'PUT') {
      stat.put++;
      if (stat.conflictOnce) {
        stat.conflictOnce = false;
        throw err(409, 'is at <sha> but expected <other>');
      }
      const rec = files.get(p);
      const b = body || {};
      if (b.sha) {
        if (!rec || rec.sha !== b.sha) throw err(409, 'sha 对不上');
      } else if (rec) {
        throw err(409, 'sha 缺了');
      }
      const content = String(b.content || '');
      const sha = 'sha' + (files.size + 1) + '_' + Math.random().toString(36).slice(2, 8);
      files.set(p, { sha: sha, content: content, size: content.length });
      return { content: { sha: sha, path: p, size: content.length } };
    }

    if (method === 'DELETE') {
      stat.del++;
      const rec = files.get(p);
      if (!rec) throw err(404, 'Not Found');
      if (body && body.sha && body.sha !== rec.sha) throw err(409, 'sha 对不上');
      files.delete(p);
      return { commit: { sha: 'commit1' } };
    }

    throw err(405, 'Method Not Allowed');
  }

  return {
    request: request,
    files: files,
    stat: stat,
    has: (p) => files.has(p),
    /** 仓库里那个文件存的东西（明文看，base64 解回来） */
    raw: (p) => {
      const rec = files.get(p);
      if (!rec) return null;
      return Buffer.from(rec.content.replace(/\s+/g, ''), 'base64').toString('utf8');
    }
  };
}

const repo = makeFakeRepo();

/** 仓库里存的永远是密文 —— 要看内容得解出来（清缓存，走真的读路径） */
function storedPlain(rel) {
  gh._clearCache();
  return gh.readFileSync(rel);
}

// 环境：假的 token、假的密码（都不是真的，也不落盘）
process.env.GH_TOKEN = 'fake-token-for-self-test';
process.env.NOOK_PASSCODE = 'self-test-passcode';
gh._setRequest(repo.request);

// ------------------------------------------------------------ 路径映射

console.log('=== 路径映射（.enc 加在最后一段） ===');
check('config.json → data/config.json.enc', gh._repoFilePath('config.json'), 'data/config.json.enc');
check('嵌套的', gh._repoFilePath('books/b_x/annotations/5.json'), 'data/books/b_x/annotations/5.json.enc');
check('notes', gh._repoFilePath('books/b_x/notes/5.md'), 'data/books/b_x/notes/5.md.enc');
check('docs', gh._repoFilePath('docs/a.md'), 'data/docs/a.md.enc');
check('目录不加 .enc', gh._repoDirPath('books/b_x/annotations'), 'data/books/b_x/annotations');
check('已经带 .enc 的不重复加', gh._repoFilePath('docs/a.md.enc'), 'data/docs/a.md.enc');

// ------------------------------------------------------------ 写 → 密文 → 读

console.log('');
console.log('=== 写进去的是密文，读出来是原文 ===');
const secret = '她的批注：「这一句我要记一辈子。」';
const secretRel = 'books/b1/notes/9.md';   // 剧情笔记是纯文本，正好试中文
gh.writeFileSync(secretRel, secret);

check('仓库里存的是带 .enc 的路径', repo.has('data/books/b1/notes/9.md.enc'), true);
check('仓库里没有不带后缀的路径', repo.has('data/books/b1/notes/9.md'), false);

const envelope = JSON.parse(repo.raw('data/books/b1/notes/9.md.enc'));
check('仓库里是密文信封', [envelope.v, envelope.alg], [1, 'AES-GCM']);
checkTrue('信封里有 iv 和 ct', envelope.iv && envelope.ct);
check('仓库里看不到明文', repo.raw('data/books/b1/notes/9.md.enc').indexOf('这一句我要记一辈子'), -1);
checkTrue('密文也不是明文的 base64', envelope.ct.indexOf('5L2g5aW9') < 0);

console.log('');
console.log('=== mtime ===');
checkTrue('信封里有 mtime（毫秒时间戳）', typeof envelope.mtime === 'number' && envelope.mtime > 0);
checkTrue('mtime 大概是现在', Math.abs(Date.now() - envelope.mtime) < 60000);

gh._clearCache(); // 走真的读路径，不吃缓存
check('读回来是原文', gh.readFileSync(secretRel), secret);

const st = gh.statSync(secretRel);
checkTrue('statSync 有 size', st && typeof st.size === 'number' && st.size > 0);
checkTrue('statSync 的 mtime 是 Date', st && st.mtime instanceof Date);
check('statSync 的 mtime 对得上信封', st.mtime.getTime(), envelope.mtime);

// ------------------------------------------------------------ 缓存

console.log('');
console.log('=== 内存缓存（同一个文件不反复打网络） ===');
gh._clearCache();
const beforeGet = repo.stat.get;
gh.readFileSync(secretRel);
gh.readFileSync(secretRel);
gh.readFileSync(secretRel);
check('读三次只发了一次请求', repo.stat.get - beforeGet, 1);

// ------------------------------------------------------------ 目录

console.log('');
console.log('=== 目录列表 ===');
gh.writeFileSync('books/b1/annotations/5.json', '[]');
gh.writeFileSync('books/b1/annotations/6.json', '[]');
gh.writeFileSync('books/b2/annotations/1.json', '[]');
gh.writeFileSync('books/b2/book.json', '{}');
const names = gh.readdirSync('books/b1/annotations').sort();
check('只列这一层的名字', names, ['5.json', '6.json']);
check('名字里没有 .enc', names.some((n) => n.endsWith('.enc')), false);
check('别的书的不混进来', gh.readdirSync('books/b2/annotations'), ['1.json']);
check('目录里也认子目录', gh.readdirSync('books/b2'), ['annotations', 'book.json']);
check('目录不存在返回空数组', gh.readdirSync('books/nope/annotations'), []);

// ------------------------------------------------------------ 不存在

console.log('');
console.log('=== 不存在的东西 ===');
let enoent = null;
try {
  gh.readFileSync('books/nope/nothing.json');
} catch (e) {
  enoent = e;
}
check('读不到要抛 ENOENT', enoent && enoent.code, 'ENOENT');
check('existsSync 说没有', gh.existsSync('books/nope/nothing.json'), false);
check('existsSync 说有', gh.existsSync('books/b1/annotations/5.json'), true);

// ------------------------------------------------------------ 没有 token

console.log('');
console.log('=== 没有 token 就写不了 ===');
const localHasToken = (function () {
  try {
    const fs = require('fs');
    const path = require('path');
    const raw = fs.readFileSync(path.join(__dirname, '..', 'data', '.local.json'), 'utf8');
    return !!(JSON.parse(raw) || {}).ghToken;
  } catch (e) {
    return false;
  }
})();
if (localHasToken) {
  console.log('  SKIP  本地 data/.local.json 里有 ghToken，这条测不了（换个环境再测）');
} else {
  const savedToken = process.env.GH_TOKEN;
  delete process.env.GH_TOKEN;
  let noTokenErr = null;
  try {
    gh.writeFileSync('books/b1/annotations/7.json', '[]');
  } catch (e) {
    noTokenErr = e;
  }
  process.env.GH_TOKEN = savedToken;
  checkTrue('没 token 时写要报错', noTokenErr);
  checkTrue('错是中文的', noTokenErr && /[\u4e00-\u9fa5]/.test(noTokenErr.message));
  checkTrue('错里说到了 token', noTokenErr && /token/.test(noTokenErr.message));
}

// ------------------------------------------------------------ 409 重试

console.log('');
console.log('=== 写冲突（409）要重读重试 ===');
repo.stat.conflictOnce = true;
const putBefore = repo.stat.put;
gh.writeFileSync('books/b1/annotations/8.json', '[]');
check('冲突之后重试写成功了', repo.stat.put - putBefore, 2);
gh._clearCache();
check('重试之后内容是对的', gh.readFileSync('books/b1/annotations/8.json'), '[]');

// ------------------------------------------------------------ reply

console.log('');
console.log('=== reply：挂错 id 要报错，不能静默挂到别的地方 ===');
const anno = [{
  id: 'a_aaa111', who: 'user', anchor: '「这一句我要记一辈子。」',
  note: '喜欢这句', paraIndex: 0, ts: '2026-10-22T00:00:00.000Z', replies: []
}, {
  id: 'a_bbb222', who: 'user', anchor: '「雾还没散。」',
  note: '这里也好美', paraIndex: 1, ts: '2026-10-22T00:01:00.000Z', replies: []
}];
gh.writeFileSync('books/b1/annotations/1.json', JSON.stringify(anno));
const store = ghStore.createStore(gh);

let wrongErr = null;
try {
  store.reply('b1', 1, 'a_zzz999', '我来看看');
} catch (e) {
  wrongErr = e;
}
checkTrue('挂错 id 要报错', wrongErr);
checkTrue('错是中文的', wrongErr && /[\u4e00-\u9fa5]/.test(wrongErr.message));
const afterWrong = JSON.parse(storedPlain('books/b1/annotations/1.json'));
check('挂错的时候文件没被改', afterWrong[0].replies.length, 0);
check('挂错的时候另一条也没被改', afterWrong[1].replies.length, 0);

const beforeEnv = JSON.parse(repo.raw('data/books/b1/annotations/1.json.enc'));
const replied = store.reply('b1', 1, 'a_aaa111', '我也喜欢这句 —— 铁轨和雾都记得。');
check('挂到了对的那一条', replied.annotationId, 'a_aaa111');
const after = JSON.parse(storedPlain('books/b1/annotations/1.json'));
check('回应挂在那一条下面', after[0].replies.length, 1);
check('没挂错别人', after[1].replies.length, 0);
check('回应是姜去说的', after[0].replies[0].who, 'ai');
check('回应内容一字不差', after[0].replies[0].text, '我也喜欢这句 —— 铁轨和雾都记得。');
checkTrue('回应有 ts', !!after[0].replies[0].ts);
const afterEnv = JSON.parse(repo.raw('data/books/b1/annotations/1.json.enc'));
checkTrue('写完 mtime 更新了', afterEnv.mtime >= beforeEnv.mtime);

// ------------------------------------------------------------ 工具的命令

console.log('');
console.log('=== gh-store 的命令 ===');
gh.writeFileSync('library.json', JSON.stringify([{ id: 'b1', title: '示例书', chapterCount: 2 }]));
gh.writeFileSync('books/b1/book.json', JSON.stringify({
  id: 'b1', title: '示例书', chapterCount: 1,
  chapters: [{ index: 1, title: '第1章 铁轨上的清晨', startLine: 0, endLine: 2 }]
}));
gh.writeFileSync('books/b1/text.txt', '第1章 铁轨上的清晨\n雾还没散。\n');
gh.writeFileSync('books/b1/notes/1.md', '# 第1章\n\n这一章讲的是雾。');
gh.writeFileSync('docs/gudao.md', '---\ntitle: 古道脉络\nsummary: 全书脉络\n---\n\n正文。\n');

const ch = store.readChapter('b1', 1);
check('read 拿到章节标题', ch.title, '第1章 铁轨上的清晨');
check('read 切出段落', ch.paragraphs, ['第1章 铁轨上的清晨', '雾还没散。']);
check('notes 拿到剧情笔记', store.readNotes('b1', 1), '这一章讲的是雾。');
check('docs 列出资料库', store.listDocs().map((d) => d.id), ['gudao']);
check('docs 读出标题', store.listDocs()[0].title, '古道脉络');
check('docs 读出摘要', store.listDocs()[0].summary, '全书脉络');
check('list 列出书', store.listBooks().map((b) => b.id), ['b1']);
const pending = store.listPending().map((p) => p.annotationId);
check('list 看得到等我回的批注', pending.includes('a_bbb222'), true);
check('回过的不再等我回', pending.includes('a_aaa111'), false);

// ------------------------------------------------------------ 命令行

console.log('');
console.log('=== 命令行（真的跑一遍 main） ===');

function runCli(argv) {
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  const savedExit = process.exitCode;
  let outBuf = '';
  let errBuf = '';
  process.stdout.write = function (s) { outBuf += s; return true; };
  process.stderr.write = function (s) { errBuf += s; return true; };
  let threw = null;
  try {
    ghStore.main(argv);
  } catch (e) {
    threw = e;
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
    process.exitCode = savedExit;
  }
  return { out: outBuf, err: errBuf, threw: threw };
}

const cliList = runCli(['list', '--pass', 'self-test-passcode']);
checkTrue('list 出了书架', cliList.out.indexOf('书架') >= 0);
checkTrue('list 里看得到书名', cliList.out.indexOf('示例书') >= 0);
checkTrue('list 里看得到等我回的批注', cliList.out.indexOf('a_bbb222') >= 0);

const cliRead = runCli(['read', '--book', 'b1', '--chapter', '1', '--pass', 'self-test-passcode']);
checkTrue('read 出了章节标题', cliRead.out.indexOf('铁轨上的清晨') >= 0);
checkTrue('read 出了正文段落', cliRead.out.indexOf('雾还没散') >= 0);

const cliNotes = runCli(['notes', '--book', 'b1', '--chapter', '1', '--pass', 'self-test-passcode']);
checkTrue('notes 出了剧情笔记', cliNotes.out.indexOf('这一章讲的是雾') >= 0);

const cliDocs = runCli(['docs', '--pass', 'self-test-passcode']);
checkTrue('docs 列了资料库', cliDocs.out.indexOf('古道脉络') >= 0);

const cliToken = runCli(['list', '--token', 'nope']);
checkTrue('--token 被拒了', !!cliToken.threw);
checkTrue('拒的时候说了要用环境变量', cliToken.err.indexOf('GH_TOKEN') >= 0);

const cliNoFile = runCli(['reply', '--book', 'b1', '--chapter', '1', '--anno', 'a_bbb222', '--pass', 'x']);
checkTrue('reply 不给 --file 被拒', !!cliNoFile.threw);

// reply 走文件：中文正文不能被命令行搞坏
const os = require('os');
const fsp = require('fs');
const tmpFile = path.join(os.tmpdir(), 'nook-reply-self-test.txt');
const replyText = '「雾还没散。」这句我记住了 —— 铁轨、雾、还有你的批注。';
fsp.writeFileSync(tmpFile, replyText, 'utf8');
try {
  const cliReply = runCli(['reply', '--book', 'b1', '--chapter', '1', '--anno', 'a_bbb222', '--file', tmpFile, '--pass', 'self-test-passcode']);
  checkTrue('reply 成功', cliReply.out.indexOf('a_bbb222') >= 0);
  const repliedText = JSON.parse(storedPlain('books/b1/annotations/1.json'))[1].replies;
  check('正文一字不差', repliedText.length === 1 && repliedText[0].text, replyText);
} finally {
  try { fsp.unlinkSync(tmpFile); } catch (e) { /* ignore */ }
}

// ------------------------------------------------------------ 出错要说人话

console.log('');
console.log('=== 出错要说人话，不能闷成「啥也没有」 ===');
const savedPc = process.env.NOOK_PASSCODE;
process.env.NOOK_PASSCODE = 'wrong-passcode-for-test';
gh._clearCache();
let pcErr = null;
try {
  store.listDocs();
} catch (e) {
  pcErr = e;
}
process.env.NOOK_PASSCODE = savedPc;
gh._clearCache();
checkTrue('密码不对要报错（不能闷成 0 篇）', pcErr);
checkTrue('错是中文的', pcErr && /[\u4e00-\u9fa5]/.test(pcErr.message));

// 一个坏文件（不是 JSON）不该把整份清单拖垮 —— 跟本地版 store.js 一个脾气
const annoNow = JSON.parse(storedPlain('books/b1/annotations/1.json'));
annoNow.push({
  id: 'a_ccc333', who: 'user', anchor: '「终点站叫遗忘。」',
  note: '这句也要记', paraIndex: 3, ts: '2026-10-22T00:02:00.000Z', replies: []
});
gh.writeFileSync('books/b1/annotations/1.json', JSON.stringify(annoNow));
gh.writeFileSync('books/b1/annotations/9.json', '这不是 JSON');
const pendingAfterBroken = store.listPending().map((p) => p.annotationId);
check('坏文件不影响别的批注', pendingAfterBroken.includes('a_ccc333'), true);

// ------------------------------------------------------------ 收尾

console.log('');
console.log(fail ? 'ALL FAIL' : 'ALL PASS');
console.log(pass + ' checks');
process.exit(fail ? 1 : 0);
