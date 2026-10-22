'use strict';
/**
 * 资料库（lib/docs.js）的测试
 *
 * 资料库是伴读 AI 读「不属于任何一本书的那些东西」的地方 ——
 * 全书脉络、设计说明、我们两个的约定。
 * 它跑在公网上（云端那位通过隧道读），所以边界必须严：
 *   · 不能读到 data/ 以外的任何文件（路径穿越）
 *   · 目录里只认 .md
 *   · front-matter 要能解析
 */

const vfs = require('../lib/vfs');
const docs = require('../lib/docs');

let pass = 0, fail = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log('  PASS  ' + name + '  ->  ' + JSON.stringify(got)); }
  else { fail++; console.log('  FAIL  ' + name + '  ->  got ' + JSON.stringify(got) + ', want ' + JSON.stringify(want)); }
}

// 准备测试文档
// 路径是相对 data/ 的 POSIX 路径（走 vfs）—— 这样换到 GitHub 后端时这个测试照样有意义
//
// ⚠️ 但 GitHub 后端下「写」就是往公开仓库里 commit —— 测试文档不能进她的仓库。
// 所以那台机器上只做只读的检查（真的文档 + 路径穿越），不造测试文件。
const isGitHub = vfs.name === 'github';
docs.ensureDocsDir();
const f1 = docs.DOCS + '/t-one.md';
const f2 = docs.DOCS + '/t-two.md';
const f3 = docs.DOCS + '/t-notmd.txt';
if (!isGitHub) {
  vfs.writeFileSync(f1, '---\ntitle: 第一篇\nsummary: 摘要一\ntags: [古道, 测试]\n---\n\n正文一。\n');
  vfs.writeFileSync(f2, '---\ntitle: 第二篇\n---\n\n正文二。\n');
  vfs.writeFileSync(f3, '不是 markdown');
}

console.log('=== listDocs ===');
if (isGitHub) {
  console.log('  （GitHub 后端：只做只读检查，不往仓库里塞测试文件）');
}
const list = docs.listDocs();
const ids = list.map(d => d.id);
if (!isGitHub) {
  check('列出了两篇 .md', ids.filter(i => i === 't-one' || i === 't-two').sort(), ['t-one', 't-two']);
  check('不列 .txt', ids.includes('t-notmd'), false);
  const one = list.find(d => d.id === 't-one');
  check('解析 title', one.title, '第一篇');
  check('解析 summary', one.summary, '摘要一');
  check('解析 tags', one.tags, ['古道', '测试']);
}

console.log('');
console.log('=== readDoc ===');
if (!isGitHub) {
  const d1 = docs.readDoc('t-one');
  check('读到正文', d1.body, '正文一。');
  check('正文里不含 front-matter', d1.body.indexOf('---'), -1);
  check('标题来自 front-matter', d1.title, '第一篇');
  const d2 = docs.readDoc('t-two');
  check('没有 summary 时是空串', d2.summary, '');
  check('没有 tags 时是空数组', d2.tags, []);
}

console.log('');
console.log('=== 边界 ===');
check('读不存在的返回 null', docs.readDoc('nope-xyz'), null);
check('路径穿越被挡住', docs.readDoc('../../../etc/passwd'), null);
check('路径穿越（编码过的）被挡住', docs.readDoc('..%2f..%2fserver.js'), null);
check('目录外的文件读不到', docs.readDoc('../server'), null);

console.log('');
console.log('=== 真实文档 ===');
const real = docs.listDocs().filter(d => !d.id.startsWith('t-'));
real.forEach(d => console.log('  · ' + d.id + '  ' + d.title + '  (' + d.chars + ' 字)'));
check('《古道》脉络在资料库里', real.some(d => d.id === 'gudao-outline'), true);

// 清理
if (!isGitHub) {
  [f1, f2, f3].forEach(f => { try { vfs.rmSync(f); } catch (e) { /* ignore */ } });
}

console.log('');
console.log(fail ? 'ALL FAIL' : 'ALL PASS');
console.log(pass + ' checks');
process.exit(fail ? 1 : 0);
