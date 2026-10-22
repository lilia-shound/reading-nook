'use strict';
/**
 * mdLite —— 极简 Markdown 渲染的测试
 *
 * 踩过的坑：中文引号强调的分支太贪婪，把「**重点**」抢走，
 * 导致 ** 原样显示给用户。现在加粗优先，引号分支只认真正的引号。
 */

// 从 app.js 里把 mdLite 抠出来测（保持同源，不测一份假的）
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');

function extract(name) {
  // 连 "async " 一起抽（少了 async，里面有 await 的函数就编不过）
  const m = new RegExp('(?:async\\s+)?function\\s+' + name + '\\s*\\([^)]*\\)\\s*\\{').exec(src);
  if (!m) { console.error('app.js 里找不到 ' + name); process.exit(1); }
  let i = m.index + m[0].length - 1;
  let depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) break; }
  }
  return src.slice(m.index, i + 1);
}

// 最小 DOM 替身：只要求 createElement / createTextNode / createDocumentFragment
function makeNode(tag) {
  const n = {
    tag, children: [], _t: '',
    appendChild(c) {
      if (c.tag === '#frag') { n.children.push(...c.children); return c; }
      n.children.push(c); c.parent = n; return c;
    },
    set textContent(v) { n.children = []; n._t = v; },
    get textContent() {
      if (n.children.length) return n.children.map((c) => c.textContent).join('');
      return n._t || '';
    }
  };
  return n;
}
const document = {
  createElement: (t) => makeNode(t),
  createTextNode: (t) => { const n = makeNode('#text'); n._t = t; return n; },
  createDocumentFragment: () => makeNode('#frag')
};

const factory = new Function('document',
  extract('mdLite') + '\nreturn mdLite;');
const mdLite = factory(document);

let pass = 0, fail = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log('  PASS  ' + name + '  ->  ' + JSON.stringify(got)); }
  else { fail++; console.log('  FAIL  ' + name + '  ->  got ' + JSON.stringify(got) + ', want ' + JSON.stringify(want)); }
}
function render(text) {
  const frag = mdLite(text);
  // 还原成 [['strong', '文字'], ['#text', '文字']] 序列
  const out = [];
  for (const c of frag.children) {
    if (c.tag === '#text') out.push(['#text', c.textContent]);
    else out.push([c.tag, c.textContent]);   // strong/em 整体输出，内部的 textContent 已经拼好
  }
  return out;
}
function plain(text) {
  return render(text).map((x) => x[1]).join('');
}

// ---------------------------------------------------------------- 基本
check('纯文本原样', plain('就是一句话。'), '就是一句话。');
check('**加粗** 变成 strong', render('**重点**'),
  [['strong', '重点']]);
check('__加粗__ 变成 strong', render('__重点__'),
  [['strong', '重点']]);
check('*斜体* 变成 em', render('*重点*'),
  [['em', '重点']]);
check('普通星号不动', plain('2 * 3 = 6'), '2 * 3 = 6');

// ---------------------------------------- 踩过的坑：中文引号抢走加粗
check('**重点** 不被引号分支抢走（关键回归）', render('**也印下多少能保留一阵子的符号印记**'),
  [['strong', '也印下多少能保留一阵子的符号印记']]);
check('引号里包加粗（引号保留，里面加粗）', render('他说「**这里**」'),
  [['#text', '他说'], ['#text', '「'], ['strong', '这里'], ['#text', '」']]);
check('** 和中文引号混排', render('注意那个限定词——「**一阵子**」。'),
  [['#text', '注意那个限定词——'], ['#text', '「'], ['strong', '一阵子'], ['#text', '」'], ['#text', '。']]);
check('**加粗跨过引号**（关键回归：不能被引号切成两半）', render('**爱默生那句「万物都在书写自己的历史」后面还有半句**'),
  [['strong', '爱默生那句「万物都在书写自己的历史」后面还有半句']]);
check('跨引号的加粗里，引号段本身仍然加粗', render('**前面「重点」后面**'),
  [['strong', '前面「重点」后面']]);

// ------------------------------------------------------- 中文引号强调
check('「重点」→ 引号保留，里面加粗', render('「重点」'),
  [['#text', '「'], ['strong', '重点'], ['#text', '」']]);
check('普通引号内容不会被乱加粗', plain('「古道」这一章'),
  '「古道」这一章');
check('中文引号里的字保持原样', plain('他引用了「万物都在书写自己的历史」这句话'),
  '他引用了「万物都在书写自己的历史」这句话');

// ------------------------------------------------------------ 混合
check('加粗 + 普通文字', render('前面的**加粗**后面的'),
  [['#text', '前面的'], ['strong', '加粗'], ['#text', '后面的']]);
check('换行不影响加粗', render('第一行\n**第二行加粗**'),
  [['#text', '第一行\n'], ['strong', '第二行加粗']]);
check('空文本', plain(''), '');

console.log('');
console.log(fail ? 'ALL FAIL' : 'ALL PASS');
console.log(pass + ' checks');
process.exit(fail ? 1 : 0);
