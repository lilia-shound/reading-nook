'use strict';
/**
 * 「点哪本书都变成古道」这个 bug 的回归测试。
 *
 * 根因：openBook 是"先换 current（标题立刻变）、后取数据（正文要等网络）"，
 * 中间那个空窗里屏幕上还留着上一本书的字 —— 慢网下看着就像串书。
 * 而且 loadChapter 没有校验"我还是当前那本书吗"，快速点两本时会互相覆盖。
 *
 * 测法：把 app.js 里的 loadChapter 抽出来，在一个可控的假环境里跑。
 * 关键点：抽取时必须连 "async " 一起抽（少了 async，里面有 await 就编不过），
 * 而 current 是模块级变量，要用 getter 注入才能读到最新值。
 */

const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');

function extract(name) {
  const re = new RegExp('(?:async\\s+)?function\\s+' + name + '\\s*\\([^)]*\\)\\s*\\{');
  const m = re.exec(src);
  if (!m) { console.error('app.js 里找不到 ' + name); process.exit(1); }
  let i = m.index + m[0].length - 1, depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) break; }
  }
  return src.slice(m.index, i + 1);
}

// current 用一个可读写的盒子装起来，函数体通过 currentBox.value 访问
function makeLoadChapter(apiImpl, $impl, toastImpl, box, settings) {
  const body = extract('loadChapter')
    .replace(/\bcurrent\b/g, 'currentBox.value');
  // 渲染相关的函数在这个测试里不需要真跑，注入空实现
  const f = new Function(
    'api', '$', 'toast', 'currentBox', 'S', 'document',
    'const renderPage = () => {};\n' +
    'const renderScroll = () => {};\n' +
    'const restoreProgress = () => {};\n' +
    'const buildToc = () => {};\n' +
    body + '\nreturn loadChapter;'
  );
  return Promise.resolve(f(apiImpl, $impl, toastImpl, box, settings, makeDocument()));
}

// 最小 document：只需要 createElement 返回一个能设 textContent / className 的节点
function makeDocument() {
  return {
    createElement(tag) {
      return {
        tag, className: '', textContent: '',
        set className(v) { this._c = v; }, get className() { return this._c || ''; }
      };
    }
  };
}

function newBox(current) {
  return { value: current };
}
function newState() {
  return {
    dom: {
      readerContent: { innerHTML: 'OLD-BOOK-CONTENT' },
      readerTitle: { textContent: '' },
      readerProgress: { textContent: '' }
    },
    toasts: []
  };
}
function make$(state) {
  function node(o) {
    o.appendChild = (c) => { o._kids = o._kids || []; o._kids.push(c); return c; };
    o._kids = o._kids || [];
    return o;
  }
  // 复用 state.dom（测试里要直接改 innerHTML / textContent）
  const dom = state.dom;
  dom.readerContent.appendChild = (c) => { dom.readerContent._kids = dom.readerContent._kids || []; dom.readerContent._kids.push(c); return c; };
  dom.readerTitle.appendChild = (c) => c;
  dom.readerProgress.appendChild = (c) => c;
  return function $(sel) {
    return dom[sel.replace('#', '')] || null;
  };
}

let pass = 0, fail = 0;
const SETTINGS = { turnMode: 'scroll', readMode: 'annotate' };
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log('  PASS  ' + name + '  ->  ' + JSON.stringify(got)); }
  else { fail++; console.log('  FAIL  ' + name + '  ->  got ' + JSON.stringify(got) + ', want ' + JSON.stringify(want)); }
}

async function run() {
  // ------------------------------------------------ 1) 正常路径：内容对
  {
    const state = newState();
    const apiCalls = [];
    const api = async (p) => {
      apiCalls.push(p);
      if (p.indexOf('/chapter/') >= 0) {
        const id = /\/books\/([^/]+)\//.exec(p)[1];
        const ch = Number(p.split('/').pop());
        return { title: id + '-第' + ch + '章', totalChapters: id === 'A' ? 5 : 24, paragraphs: [id + '-正文'] };
      }
      return { annotations: [] };
    };
    const toast = (m) => state.toasts.push(m);
    const box = newBox({ book: { id: 'A', title: '甲书', chapterCount: 5 }, chapter: 1, paragraphs: [], annos: [] });
    const loadChapter = await makeLoadChapter(api, make$(state), toast, box, SETTINGS);

    await loadChapter(1);
    check('正常时标题用新书的数据', state.dom.readerTitle.textContent, 'A-第1章');
    check('正常时进度是新书的章节数', state.dom.readerProgress.textContent, '1 / 5');
    check('正常时请求的是这本书', apiCalls[0], '/api/books/A/chapter/1');
    check('正常时 current.paragraphs 是新书的内容', box.value.paragraphs, ['A-正文']);
  }

  // --------------------------------------- 2) 取不到正文：清屏 + 报错
  {
    const state = newState();
    let failOnce = true;
    const api = async (p) => {
      if (p.indexOf('/chapter/') >= 0 && failOnce) { failOnce = false; throw new Error('网络断了'); }
      return { annotations: [] };
    };
    const toast = (m) => state.toasts.push(m);
    const box = newBox({ book: { id: 'B', title: '乙书', chapterCount: 24 }, chapter: 1, paragraphs: [], annos: [] });
    const loadChapter = await makeLoadChapter(api, make$(state), toast, box, SETTINGS);

    state.dom.readerContent.innerHTML = '上一本书的正文还在';
    state.toasts.length = 0;
    await loadChapter(1);
    check('取不到正文时把旧内容清掉', state.dom.readerContent.innerHTML, '');
    check('取不到正文时标题写明打不开', state.dom.readerTitle.textContent, '乙书 · 打不开');
    check('取不到正文时给用户一句提示', state.toasts.length > 0, true);
  }

  // ------------- 3) 响应回来时已经换了书 → 过期数据必须丢弃（串书元凶）
  {
    const state = newState();
    let resolveChapter = null;
    const slowApi = (p) => {
      if (p.indexOf('/chapter/') >= 0) {
        return new Promise((res) => {
          resolveChapter = () => res({ title: 'A-第1章', totalChapters: 5, paragraphs: ['A-正文'] });
        });
      }
      return Promise.resolve({ annotations: [] });
    };
    const toast = (m) => state.toasts.push(m);
    const box = newBox({ book: { id: 'A', title: '甲书', chapterCount: 5 }, chapter: 1, paragraphs: [], annos: [] });
    const loadChapter = await makeLoadChapter(slowApi, make$(state), toast, box, SETTINGS);

    const pending = loadChapter(1);
    // 趁 A 的请求还在飞，用户切到了 B
    box.value = { book: { id: 'B', title: '乙书', chapterCount: 24 }, chapter: 1, paragraphs: [], annos: [] };
    state.dom.readerTitle.textContent = '乙书 · 正在打开…';
    resolveChapter();
    await pending;
    check('过期响应不覆盖当前书的标题', state.dom.readerTitle.textContent, '乙书 · 正在打开…');
    check('过期响应不把 A 的正文写进 current', box.value.paragraphs, []);
  }

  console.log('');
  console.log(fail ? 'ALL FAIL' : 'ALL PASS');
  console.log(pass + ' checks');
  process.exit(fail ? 1 : 0);
}

run().catch((e) => { console.error(e); process.exit(1); });
