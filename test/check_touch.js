'use strict';
/**
 * 触屏划线核心逻辑的测试（不依赖浏览器，用 JSDOM 风格的最小 DOM 替身太重，
 * 这里直接测纯函数部分：短语扩展规则 + 锚点文本提取）。
 *
 * 真机长按无法在 CI 里模拟，但这两个函数是长按路径的"脑"，测它们就够了：
 *   expandToPhrase  —— 手指底下的字取多少
 *   anchorTextOf    —— 选中的文字怎么换算回原文
 */

// 从 app.js 里把这几段逻辑抠出来测（保持同源，避免测一份假的）
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');

function extract(name) {
  // 连 "async " 一起抽（少了 async，里面有 await 的函数就编不过）
  const re = new RegExp('(?:async\\s+)?function\\s+' + name + '\\s*\\([^)]*\\)\\s*\\{');
  const m = re.exec(src);
  if (!m) throw new Error('app.js 里找不到 ' + name);
  let i = m.index + m[0].length - 1;   // 指向 {
  let depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) break; }
  }
  return src.slice(m.index, i + 1);
}

const SEL_BREAK = /[，。！？；：、,.!?;:"'（）()《》「」『』…—·\n\r]/;
const SEL_WORD = /[0-9A-Za-z_À-ɏ一-鿿぀-ヿ가-힯]/;

// 造一个最小 DOM：段落里塞文本节点
function fakeTextNode(text) {
  return { nodeType: 3, data: text, parentElement: null };
}
function fakeEl(tag, children, className) {
  const el = {
    nodeType: 1, tagName: tag.toUpperCase(), childNodes: children,
    classList: { contains: (c) => className === c }
  };
  children.forEach((c) => { c.parentElement = el; });
  return el;
}
function fakeRange() {
  return {
    startContainer: null, startOffset: 0, endContainer: null, endOffset: 0,
    setStart(n, o) { this.startContainer = n; this.startOffset = o; },
    setEnd(n, o) { this.endContainer = n; this.endOffset = o; },
    collapse() {}
  };
}

const expandSrc = extract('expandToPhrase');
const anchorSrc = extract('anchorTextOf');
const paraIdxSrc = extract('paraTextIndex');

// 拼一个可执行的环境
const factory = new Function(
  'SEL_BREAK', 'SEL_WORD', 'NodeFilter', 'document',
  expandSrc + '\n' + paraIdxSrc + '\n' + anchorSrc + '\n' +
  'return { expandToPhrase, anchorTextOf, paraTextIndex };'
);
const mod = factory(SEL_BREAK, SEL_WORD, { SHOW_TEXT: 4 }, {
  body: { childNodes: [] },
  createRange: fakeRange
});

let pass = 0, fail = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log('  PASS  ' + name + '  ->  ' + JSON.stringify(got)); }
  else { fail++; console.log('  FAIL  ' + name + '  ->  got ' + JSON.stringify(got) + ', want ' + JSON.stringify(want)); }
}

// ---------------------------------------------------------------- 取词范围
{
  const t = fakeTextNode('车窗外的灯一盏盏往后退，姜来把书页往下压了压。');
  const range = { startContainer: t, startOffset: 4 };
  const out = mod.expandToPhrase(range);
  check('中文长按取到逗号为止的一整句',
    [out.startContainer.data.slice(out.startOffset, out.endOffset)],
    ['车窗外的灯一盏盏往后退']);
}
{
  // 没有标点的中文：整段都算一句话
  const t = fakeTextNode('车窗外的灯一盏盏往后退');
  const range = { startContainer: t, startOffset: 4 };
  const out = mod.expandToPhrase(range);
  check('中文没有标点时取整段（上限 20 字）',
    [out.startContainer.data.slice(out.startOffset, out.endOffset)],
    ['车窗外的灯一盏盏往后退']);
}
{
  // 超过 20 字的超长句要截断
  const long = '一'.repeat(40);
  const t = fakeTextNode(long);
  const range = { startContainer: t, startOffset: 20 };
  const out = mod.expandToPhrase(range);
  check('超长段落被截断到 40 字以内',
    [out.endOffset - out.startOffset <= 40],
    [true]);
}
{
  const t = fakeTextNode('hello world');
  const range = { startContainer: t, startOffset: 2 };
  const out = mod.expandToPhrase(range);
  check('英文长按取一个词',
    [out.startContainer.data.slice(out.startOffset, out.endOffset)],
    ['hello']);
}
{
  const t = fakeTextNode('第一章 铁轨上的第1站');
  const range = { startContainer: t, startOffset: 0 };
  const out = mod.expandToPhrase(range);
  check('开头长按不会越界',
    [out.startContainer.data.slice(out.startOffset, out.endOffset)],
    ['第一章']);
}
{
  const t = fakeTextNode('短。');
  const range = { startContainer: t, startOffset: 1 };
  const out = mod.expandToPhrase(range);
  check('标点上也至少选到一个字',
    [out.startContainer.data.slice(out.startOffset, out.endOffset)],
    ['。']);
}

// ---------------------------------------------------- 锚点换算回原文
{
  // 段落 = 文本节点 A + 气泡 + 文本节点 B
  const a = fakeTextNode('前面的正文。');
  const bub = fakeEl('div', [fakeTextNode('划线 · 我')], 'bubble');
  const b = fakeTextNode('后面的正文。');
  const para = fakeEl('p', [a, bub, b], 'para');
  const idx = mod.paraTextIndex(para);
  check('气泡里的字不算正文', idx.text, '前面的正文。后面的正文。');

  const range = { startContainer: b, startOffset: 0, endContainer: b, endOffset: 3 };
  check('选区换算成原文', mod.anchorTextOf(range, para), '后面的');
}
{
  // 选区跨两个文本节点：a 的 offset 4（"文"）→ b 的 offset 2（"后面"）
  const a = fakeTextNode('前面的正文。');
  const b = fakeTextNode('后面的正文。');
  const para = fakeEl('p', [a, b], 'para');
  const range = { startContainer: a, startOffset: 4, endContainer: b, endOffset: 2 };
  check('跨节点选区也能换算', mod.anchorTextOf(range, para), '文。后面');
}
{
  // 选区落在已经划过线的 span 里
  const hl = fakeEl('span', [fakeTextNode('划过的字')], 'hl');
  const a = fakeTextNode('开头');
  const b = fakeTextNode('结尾');
  const para = fakeEl('p', [a, hl, b], 'para');
  const range = { startContainer: hl.childNodes[0], startOffset: 0, endContainer: hl.childNodes[0], endOffset: 3 };
  check('落在已划线 span 里也能换算', mod.anchorTextOf(range, para), '划过的');
}

console.log('');
console.log(fail ? 'ALL FAIL' : 'ALL PASS');
console.log(pass + ' checks');
process.exit(fail ? 1 : 0);
