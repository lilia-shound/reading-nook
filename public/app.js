'use strict';
/**
 * 共读小屋 - 前端
 * 原生 JS，无框架。
 */

(function () {
  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.prototype.slice.call((root || document).querySelectorAll(sel));

  const THEMES = [
    { slug: 'cream-dog', label: '奶油小狗', emoji: '🐶', group: '温柔系' },
    { slug: 'matcha', label: '抹茶老铺', emoji: '🍵', group: '温柔系' },
    { slug: 'muxia', label: '慕夏花神', emoji: '🌸', group: '温柔系' },
    { slug: 'french-blue', label: '法式蓝笺', emoji: '💌', group: '温柔系' },
    { slug: 'mono-sweet', label: '黑白甜', emoji: '🎀', group: '温柔系' },
    { slug: 'clay', label: '黏土', emoji: '🧱', group: '拟态系' },
    { slug: 'neumorph', label: '新拟物', emoji: '🫧', group: '拟态系' },
    { slug: 'glass', label: '拟态玻璃', emoji: '🪟', group: '拟态系' },
    { slug: 'liquid-glass', label: '液态玻璃', emoji: '💧', group: '拟态系' },
    { slug: 'skeuomorph', label: '拟物化', emoji: '🎛️', group: '拟态系' },
    { slug: 'material-design', label: '材质设计', emoji: '📐', group: '现代系' },
    { slug: 'bauhaus', label: '包豪斯', emoji: '🔺', group: '现代系' },
    { slug: 'flat-design', label: '扁平化', emoji: '▭', group: '现代系' },
    { slug: 'minimalism', label: '极简', emoji: '◻️', group: '现代系' },
    { slug: 'neo-brutalism', label: '新粗野', emoji: '🧱', group: '粗野系' },
    { slug: 'brutalism', label: '粗野主义', emoji: '⛓️', group: '粗野系' },
    { slug: 'anti-design', label: '反设计', emoji: '🖍️', group: '粗野系' },
    { slug: 'acid-graphics', label: '酸性设计', emoji: '🧪', group: '赛博系' },
    { slug: 'retrofuturism', label: '复古未来', emoji: '🛸', group: '赛博系' }
  ];

  const PALETTES = {
    '黑白': ['#1f1f1f', '#6b6b6b', '#a8a8a8', '#d8d8d8', '#ffffff'],
    '莫兰迪': ['#a8b5a2', '#c9ada7', '#9a8c98', '#b8c0d0', '#e6ddd3'],
    '多巴胺': ['#ff5d8f', '#ffb400', '#3ddc97', '#5b8cff', '#c56cf0'],
    '薄荷曼波': ['#a8e6cf', '#dcedc1', '#ffd3b6', '#ffaaa5', '#bde0fe']
  };

  const DEFAULTS = {
    theme: 'cream-dog',
    mode: 'day',
    colors: { hlMine: '#ffd9e6', hlAi: '#cfe3ff', bubMine: '#ffd9e6', bubAi: '#cfe3ff' },
    textColor: '',
    bgMode: 'theme',
    bgImage: '',
    turnMode: 'pager',
    fontSize: 17,
    readMode: 'annotate',
    lpStrategy: 'auto'      // 安卓长按取词：auto 跟系统 / self 我们自己取
  };

  let S = loadSettings();
  let books = [];
  let current = null;   // { book, chapter, meta, paragraphs, annos, pages, pageIndex }
  let currentView = '#viewShelf';
  let selBarState = { anchor: '', paraIndex: -1 };
  let toastTimer = null;

  function loadSettings() {
    try {
      const raw = localStorage.getItem('nook.settings');
      if (!raw) return JSON.parse(JSON.stringify(DEFAULTS));
      const o = JSON.parse(raw);
      return Object.assign(JSON.parse(JSON.stringify(DEFAULTS)), o, {
        colors: Object.assign({}, DEFAULTS.colors, o.colors || {})
      });
    } catch (e) {
      return JSON.parse(JSON.stringify(DEFAULTS));
    }
  }
  function saveSettings() {
    localStorage.setItem('nook.settings', JSON.stringify(S));
  }

  // 阅读模式按书存，不要全局共用一个开关。
  //
  // 之前 S.readMode 是全局的：在书架上点过一次"纯阅读"，之后不管点哪本书
  // 都是纯阅读 —— 而纯阅读模式下划线根本不注册事件，长按完全没反应。
  // 手机和桌面各存各的 localStorage，所以还会出现"电脑能划、手机不能划"
  // 这种鬼现象。现在每本书各存各的。
  function getBookReadMode(bookId) {
    try {
      const raw = localStorage.getItem('nook.readmode');
      if (!raw) return 'annotate';
      const map = JSON.parse(raw);
      return map[bookId] || 'annotate';
    } catch (e) {
      return 'annotate';
    }
  }

  function setBookReadMode(bookId, mode) {
    try {
      const raw = localStorage.getItem('nook.readmode');
      const map = raw ? JSON.parse(raw) : {};
      map[bookId] = mode;
      localStorage.setItem('nook.readmode', JSON.stringify(map));
    } catch (e) { /* ignore */ }
    S.readMode = mode;
    saveSettings();
  }

  // ------------------------------------------------------------- 网络

  async function api(path, opt) {
    // 静态版（公网）：没有自己的后端，数据在 GitHub 仓库里
    if (window.__NOOK_STATIC__ && window.GhApi) return window.GhApi.handle(path, opt);
    opt = opt || {};
    const init = { method: opt.method || 'GET', headers: {} };
    if (opt.json !== undefined) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(opt.json);
    } else if (opt.raw !== undefined) {
      init.body = opt.raw;
      if (opt.filename) init.headers['X-Filename'] = encodeURIComponent(opt.filename);
    }
    const res = await fetch(path, init);
    let data = null;
    try { data = await res.json(); } catch (e) { data = {}; }
    if (!res.ok) {
      const err = new Error(data && data.error ? data.error : 'HTTP ' + res.status);
      err.status = res.status;
      throw err;
    }
    return data;
  }

  // ------------------------------------------------------------- 外观

  function applyAppearance() {
    document.body.dataset.theme = S.theme;
    document.body.dataset.mode = S.mode;
    const c = S.colors;
    if (c.hlMine) document.body.style.setProperty('--hl-mine', c.hlMine);
    if (c.hlAi) document.body.style.setProperty('--hl-ai', c.hlAi);
    if (c.bubMine) document.body.style.setProperty('--bub-mine', c.bubMine);
    if (c.bubAi) document.body.style.setProperty('--bub-ai', c.bubAi);
    if (S.textColor) document.body.style.setProperty('--text-color', S.textColor);
    if (S.bgImage) document.body.style.setProperty('--bg-image', 'url(' + S.bgImage + ')');
    document.documentElement.style.setProperty('--reader-fs', S.fontSize + 'px');
    const reader = $('#viewReader');
    if (reader) reader.dataset.bg = S.bgMode;
    saveSettings();
    syncSettingsUI();
  }

  function syncSettingsUI() {
    $$('#themeGrid .theme-card').forEach((el) => el.classList.toggle('theme-card--active', el.dataset.theme === S.theme));
    $$('#modeSeg .seg__item').forEach((el) => el.classList.toggle('seg__item--active', el.dataset.mode === S.mode));
    $$('#bgSeg .seg__item').forEach((el) => el.classList.toggle('seg__item--active', el.dataset.bg === S.bgMode));
    $$('#turnSeg .seg__item').forEach((el) => el.classList.toggle('seg__item--active', el.dataset.turn === S.turnMode));
    $$('#fontSeg .seg__item').forEach((el) => el.classList.toggle('seg__item--active', Number(el.dataset.size) === Number(S.fontSize)));
    $('#bgImageRow').classList.toggle('hidden', S.bgMode !== 'image');
    syncLpStrategyUI();
    [['#swatchHlMine', S.colors.hlMine], ['#swatchHlAi', S.colors.hlAi], ['#swatchBubMine', S.colors.bubMine],
     ['#swatchBubAi', S.colors.bubAi], ['#swatchText', S.textColor || '']].forEach((pair) => {
      const box = $(pair[0]);
      if (!box) return;
      $$('.swatch', box).forEach((el) => el.classList.toggle('swatch--active', el.dataset.color === pair[1]));
    });
  }

  // 长按取词策略的 UI（只在安卓上露出来）
  function syncLpStrategyUI() {
    const row = $('#lpStrategyRow');
    const hint = $('#lpStrategyHint');
    if (!row) return;
    const android = isAndroidLike();
    row.classList.toggle('hidden', !android);
    if (hint) {
      hint.classList.toggle('hidden', !android);
      hint.textContent = android
        ? (lpStrategy() === 'self'
          ? '我们自己取词：长按会选中一整句，工具条干净，但范围是我们定的。'
          : '跟系统选词：选词最准，但安卓可能同时弹出系统自己的「复制/分享」工具条。')
        : '';
    }
    $$('#lpSeg .seg__item').forEach((el) => {
      el.classList.toggle('seg__item--active', el.dataset.lp === lpStrategy());
    });
  }

  function buildThemeGrid() {
    const grid = $('#themeGrid');
    grid.innerHTML = '';
    // 主题多了要分组，不然一屏拉到底找不着自己那套
    let group = '';
    THEMES.forEach((t) => {
      if (t.group !== group) {
        group = t.group;
        const h = document.createElement('div');
        h.className = 'theme-grid__group';
        h.textContent = group;
        grid.appendChild(h);
      }
      const b = document.createElement('div');
      b.className = 'theme-card';
      b.dataset.theme = t.slug;
      b.innerHTML = '<div class="theme-card__chip" style="background:' + themeChip(t.slug) + '"></div>' +
        '<div class="theme-card__label">' + t.emoji + ' ' + t.label + '</div>';
      b.addEventListener('click', () => { S.theme = t.slug; applyAppearance(); });
      grid.appendChild(b);
    });
  }

  function themeChip(slug) {
    const map = {
      'cream-dog': 'linear-gradient(135deg,#f6e7c8,#e9b9a8)',
      matcha: 'linear-gradient(135deg,#cfe0bd,#8fae7d)',
      muxia: 'linear-gradient(135deg,#f0d5de,#b48ea8)',
      'mono-sweet': 'linear-gradient(135deg,#f2f2f2,#3a3a3a)',
      'french-blue': 'linear-gradient(135deg,#dce6f5,#7d9bc4)',
      clay: 'linear-gradient(135deg,#f0c9a8,#c98f6b)',
      neumorph: 'linear-gradient(135deg,#e3e9f2,#c2cddd)',
      glass: 'linear-gradient(135deg,#cfe9f5,#9fc7e8)',
      'liquid-glass': 'linear-gradient(135deg,#e6e4f7,#8f8cf0)',
      skeuomorph: 'linear-gradient(135deg,#f5e6d3,#deb887)',
      bauhaus: 'linear-gradient(135deg,#ffd100 0 34%,#e30613 34% 67%,#0033a0 67%)',
      'material-design': 'linear-gradient(135deg,#fafafa 0 45%,#6750a4 45% 100%)',
      'neo-brutalism': 'linear-gradient(135deg,#fffdf7 0 55%,#ff6b6b 55% 78%,#1a1a2e 78%)',
      'acid-graphics': 'linear-gradient(135deg,#0d0d0d 0 40%,#39ff14 40% 70%,#ff00ff 70%)',
      retrofuturism: 'linear-gradient(135deg,#0d0221 0 40%,#00ffff 40% 70%,#ff69b4 70%)',
      'anti-design': 'linear-gradient(135deg,#f8f5f0 0 40%,#e8364e 40% 70%,#2d5bff 70%)',
      brutalism: 'linear-gradient(135deg,#e8e8e8 0 50%,#2d2d2d 50% 75%,#111 75%)',
      'flat-design': 'linear-gradient(135deg,#ffffff 0 50%,#3498db 50% 75%,#2c3e50 75%)',
      minimalism: 'linear-gradient(135deg,#f7f7f7 0 60%,#1a1a1a 60% 75%,#e2e2e2 75%)'
    };
    return map[slug] || '#ddd';
  }

  function buildSwatches(boxSel, key) {
    const box = $(boxSel);
    if (!box) return;
    box.innerHTML = '';
    Object.keys(PALETTES).forEach((pname) => {
      PALETTES[pname].forEach((color) => {
        const b = document.createElement('div');
        b.className = 'swatch';
        b.dataset.color = color;
        b.innerHTML = '<div class="swatch__chip" style="background:' + color + '"></div>';
        b.addEventListener('click', () => {
          if (key === 'textColor') S.textColor = color;
          else S.colors[key] = color;
          applyAppearance();
        });
        box.appendChild(b);
      });
    });
    const custom = document.createElement('div');
    custom.className = 'swatch';
    custom.innerHTML = '<div class="swatch__chip" style="background:conic-gradient(from 0deg,#ff5d8f,#ffb400,#3ddc97,#5b8cff,#c56cf0,#ff5d8f)"></div>';
    const input = document.createElement('input');
    input.type = 'color';
    input.value = '#ffd9e6';
    input.style.cssText = 'position:absolute;opacity:0;width:100%;height:100%;left:0;top:0;cursor:pointer;border:0;padding:0';
    input.addEventListener('input', () => {
      if (key === 'textColor') S.textColor = input.value;
      else S.colors[key] = input.value;
      applyAppearance();
    });
    custom.appendChild(input);
    box.appendChild(custom);
  }

  // 极简 Markdown：**加粗** / *斜体* / 「重点」→加粗，其余原样。
  // 避免把符号原样显示给用户。
  //
  // 踩过的两个坑：
  //   1) 中文引号分支太贪婪，把「**重点**」整个抢走，** 原样显示。
  //   2) 反过来先切引号段也不行 —— 「**加粗跨过引号**」会被切成两半，
  //      两半的 ** 都配不上对，又变成字面量。
  //
  // 所以用"一次扫 + 递归"的写法：
  //   · 先按 **加粗** / *斜体* / 「引号段」的顺序找最外层的标记
  //   · 找到加粗，里面再递归处理一次（引号、嵌套的标记都能认）
  //   · 找到引号段，引号本身保留（读者要看到书名），内容递归处理
  function mdLite(text) {
    const frag = document.createDocumentFragment();
    const src = String(text == null ? '' : text);
    const re = /\*\*([^*\n]+)\*\*|__([^_\n]+)__|\*([^*\n]+)\*|「([^「」\n]{1,40})」/g;
    let last = 0, m;
    while ((m = re.exec(src)) !== null) {
      if (m.index > last) frag.appendChild(document.createTextNode(src.slice(last, m.index)));
      if (m[1] !== undefined || m[2] !== undefined) {
        const el = document.createElement('strong');
        el.appendChild(mdLite(m[1] !== undefined ? m[1] : m[2]));
        frag.appendChild(el);
      } else if (m[3] !== undefined) {
        const el = document.createElement('em');
        el.appendChild(mdLite(m[3]));
        frag.appendChild(el);
      } else {
        // 「重点」→ 引号保留，里面加粗
        frag.appendChild(document.createTextNode('「'));
        const el = document.createElement('strong');
        el.appendChild(mdLite(m[4]));
        frag.appendChild(el);
        frag.appendChild(document.createTextNode('」'));
      }
      last = m.index + m[0].length;
    }
    if (last < src.length) frag.appendChild(document.createTextNode(src.slice(last)));
    return frag;
  }

  function setBubbleText(el, text) {
    el.textContent = '';
    el.appendChild(mdLite(text));
  }

  // ------------------------------------------------------------- 提示

  function toast(msg) {
    const el = $('#toast');
    el.textContent = msg;
    el.classList.add('toast--show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('toast--show'), 2600);
  }

  function show(view) {
    currentView = view;
    ['#viewShelf', '#viewReader', '#viewSettings', '#viewWorkbench'].forEach((v) => $(v).classList.add('hidden'));
    $(view).classList.remove('hidden');
    // 浮层跟着视图走：切走时收起来，免得盖住下一屏
    if (view !== '#viewReader') {
      $('#toc').classList.add('hidden');
      $('#annoPanel').classList.add('hidden');
    }
    $('#topTitle').textContent = {
      '#viewShelf': '共读小屋', '#viewReader': current ? current.book.title : '阅读',
      '#viewSettings': '设置', '#viewWorkbench': 'DeepSeek 工作台'
    }[view];
  }

  // ------------------------------------------------------------- 路由
  // hash 形式： #/shelf | #/read/<bookId>/<chapter> | #/settings | #/workbench
  // 这样刷新、切窗口、把链接发给 iPad 都不会丢位置。

  function parseHash() {
    const h = (location.hash || '').replace(/^#\/?/, '');
    const parts = h.split('/').filter(Boolean);
    if (!parts.length) return { view: 'shelf' };
    if (parts[0] === 'read' && parts[1]) {
      return { view: 'read', bookId: parts[1], chapter: Number(parts[2] || 1) };
    }
    if (parts[0] === 'settings') return { view: 'settings' };
    if (parts[0] === 'workbench') return { view: 'workbench' };
    return { view: 'shelf' };
  }

  function setHash(view, bookId, chapter) {
    let h = '#/shelf';
    if (view === 'read' && bookId) h = '#/read/' + bookId + '/' + (chapter || 1);
    else if (view === 'settings') h = '#/settings';
    else if (view === 'workbench') h = '#/workbench';
    if (location.hash !== h) location.hash = h;
  }

  async function applyRoute() {
    const r = parseHash();
    if (r.view === 'read' && r.bookId) {
      const book = books.find((b) => b.id === r.bookId);
      if (book) {
        show('#viewReader');
        if (!current || current.book.id !== book.id || current.chapter !== r.chapter) {
          try {
            await openBook(book, r.chapter, true);
          } catch (e) {
            toast('打不开：' + (e.message || '出了点问题'));
          }
        }
        return;
      }
      // 链接里的书不在书架上了（比如刚被删掉）—— 回书架，别停在空白页
      toast('那本书不在书架上了');
      show('#viewShelf');
      setHash('shelf');
      return;
    }
    if (r.view === 'settings') { show('#viewSettings'); loadServerSettings(); return; }
    if (r.view === 'workbench') { show('#viewWorkbench'); loadWorkbench(); return; }
    show('#viewShelf');
  }

  // ------------------------------------------------------------- 登录

  async function boot() {
    buildThemeGrid();
    buildSwatches('#swatchHlMine', 'hlMine');
    buildSwatches('#swatchHlAi', 'hlAi');
    buildSwatches('#swatchBubMine', 'bubMine');
    buildSwatches('#swatchBubAi', 'bubAi');
    buildSwatches('#swatchText', 'textColor');
    applyAppearance();
    wireEvents();
    // 静态版（公网）要先看 site.json 才知道走哪条路
    await detectMode();
    // 密码提示语（登录前就能看到，不然想不起来）
    try {
      const h = await api('/api/health');
      if (h.login_hint) $('#loginHint').textContent = '提示：' + h.login_hint;
    } catch (e) { /* ignore */ }
    if (window.__NOOK_STATIC__) {
      // 静态版没有 cookie 免登录这一说 —— 每次都得输密码
      $('#login').classList.remove('hidden');
      $('#app').classList.add('hidden');
      $('#passcode').focus();
      return;
    }
    try {
      const lib = await api('/api/library');
      enterApp(lib);
    } catch (e) {
      $('#login').classList.remove('hidden');
      $('#app').classList.add('hidden');
      $('#passcode').focus();
    }
  }

  // ------------------------------------------------- 静态版（GitHub 后端）

  /**
   * 决定走哪条数据路：
   *   - **本地模式**：本机服务（8231）把仓库里的密文解开后给明文 → 浏览器不用管加密
   *   - **静态模式**：浏览器自己去 GitHub 读密文、自己解密
   *
   * ⚠️ 判据必须是「同源的本机服务在不在」，**不能只看 site.json**：
   *   `http://192.168.x.x:8231` 不是安全上下文，**浏览器不给 WebCrypto**，
   *   浏览器自己解不开密文 → 登录直接失败。
   *   所以局域网版必须走本机服务（明文 API），静态模式只留给 https 的公网版。
   */
  async function detectMode() {
    // ① 先问「同源有没有本机服务」（相对路径，不跨域，不用发到外面去）
    try {
      const probe = await fetch('api/health', { cache: 'no-store' });
      if (probe.ok) {
        // 有本机服务 → 本地模式：数据由它解开给你
        return;
      }
    } catch (e) { /* 没有本机服务 → 往下 */ }

    // ② 没有本机服务 → 静态版（https 的公网版）
    try {
      let site = window.NOOK_SITE || null;
      if (!site) {
        const res = await fetch('site.json', { cache: 'no-store' });
        site = await res.json();
      }
      if (!site || site.mode !== 'static') return;
      window.__NOOK_STATIC__ = true;
      window.__NOOK_SITE__ = site;
      if (window.GhApi && window.GhApi.init) {
        try { await window.GhApi.init(site); } catch (e) { /* ignore */ }
      }
      setupGhUi(site);
    } catch (e) { /* ignore */ }
  }

  function setupGhUi(site) {
    const gh = $('#loginGh');
    if (gh) gh.classList.remove('hidden');
    const grp = $('#ghSettingsGroup');
    if (grp) grp.classList.remove('hidden');
    const info = $('#ghRepoInfo');
    if (info) {
      info.textContent = (site.owner || '') + '/' + (site.repo || '') + '（' + (site.branch || 'main') +
        '）· 仓库里存的是密文；密码只在你输入的那一瞬间被用来派生密钥，仓库里没有';
    }
    const st = $('#ghTokenStatus');
    const tok = window.GhApi && window.GhApi.getToken ? window.GhApi.getToken() : '';
    if (st) st.textContent = tok ? '已连上 · token 存在这台设备的浏览器里' : '还没连上 · 现在是只读';
    const setTok = $('#setGhToken');
    if (setTok) setTok.value = '';
  }

  function ghTokenChanged() {
    const tok = window.GhApi && window.GhApi.getToken ? window.GhApi.getToken() : '';
    const st = $('#ghTokenStatus');
    if (st) st.textContent = tok ? '已连上 · token 存在这台设备的浏览器里' : '还没连上 · 现在是只读';
    const cs = $('#ghConnStatus');
    if (cs) cs.textContent = tok ? '已连上 GitHub · 可以划线了' : '还没连上 GitHub · 现在是只读，划线会失败';
  }

  function enterApp(lib) {
    $('#login').classList.add('hidden');
    $('#app').classList.remove('hidden');
    books = lib.books || [];
    $('#shelfSubtitle').textContent = lib.subtitle || '姜来 & 姜去';
    renderShelf();
    loadFormatHint();
    // 盯着有没有待回的批注，姜去回完自己会消失
    pollPending();
    if (pendingTimer) clearInterval(pendingTimer);
    pendingTimer = setInterval(pollPending, pollInterval());
    applyRoute();
  }

  async function doLogin() {
    const v = $('#passcode').value.trim();
    $('#loginError').textContent = '';
    try {
      const r = await api('/api/login', { method: 'POST', json: { passcode: v } });
      $('#shelfSubtitle').textContent = r.subtitle || '';
      const lib = await api('/api/library');
      enterApp(lib);
    } catch (e) {
      const msg = String((e && e.message) || '');
      $('#loginError').textContent = /密码/.test(msg) ? '密码不对，再想想' : msg;
      $('#passcode').select();
    }
  }

  // ------------------------------------------------------------- 书架

  function renderShelf() {
    const grid = $('#bookGrid');
    grid.innerHTML = '';
    $('#shelfEmpty').classList.toggle('hidden', books.length > 0);
    books.forEach((b) => {
      const card = document.createElement('div');
      card.className = 'book-card';
      const pct = b.progress ? Math.round((b.progress.ratio || 0) * 100) : 0;
      const est = b.noteEstimate || null;
      const pend = pendingByBook[b.id] || 0;
      const meta = b.chapterCount + ' 章 · ' + (b.encoding || '?') + ' · ' + (b.noteCount ? '笔记 ' + b.noteCount : '无笔记') +
        (est && est.chapters ? ' · 剩余笔记约 ¥' + est.cost.toFixed(2) : '') +
        (pend ? ' · 💬 待回 ' + pend : '');
      card.innerHTML =
        '<div class="book-card__cover">📖</div>' +
        '<div class="book-card__title"></div>' +
        '<div class="book-card__meta"></div>' +
        '<div class="book-card__progress"><div class="progress-bar"><div class="progress-bar__fill" style="width:' + pct + '%"></div></div></div>' +
        '<div class="book-card__actions"></div>';
      $('.book-card__title', card).textContent = b.title;
      $('.book-card__meta', card).textContent = meta;
      const acts = $('.book-card__actions', card);
      if (b.progress) acts.appendChild(btn('继续读', 'btn--primary btn--sm', () => openBook(b, b.progress.chapter)));
      acts.appendChild(btn('纯阅读', 'btn--ghost btn--sm', () => { setBookReadMode(b.id, 'read'); openBook(b, 1); }));
      acts.appendChild(btn('批注共读', 'btn--ai btn--sm', () => { setBookReadMode(b.id, 'annotate'); openBook(b, b.progress ? b.progress.chapter : 1); }));
      if (est && est.chapters) acts.appendChild(btn('写剧情笔记', 'btn--ghost btn--sm', () => openGenModal(b)));
      acts.appendChild(btn('删', 'btn--danger btn--sm', async () => {
        if (!confirm('删掉《' + b.title + '》？批注和笔记会一起没。')) return;
        await api('/api/books/' + encodeURIComponent(b.id), { method: 'DELETE' });
        await refreshLibrary();
        toast('已删除');
      }));
      grid.appendChild(card);
    });
  }

  function btn(label, cls, fn) {    const b = document.createElement('button');
    b.className = 'btn ' + cls;
    b.textContent = label;
    b.addEventListener('click', fn);
    return b;
  }

  async function refreshLibrary() {
    const lib = await api('/api/library');
    books = lib.books || [];
    renderShelf();
  }

  async function uploadFile(file) {
    if (!file) return;
    const name = file.name || '';
    const ext = (name.split('.').pop() || '').toLowerCase();
    // 读不了的格式先在本地拦一句，别让用户干等一个必然失败的请求
    if (ext === 'mobi' || ext === 'azw' || ext === 'azw3' || ext === 'prc') {
      toast('MOBI / AZW3（Kindle 格式）暂时还读不了。用 Calibre 打开它另存为 EPUB 再传，一步的事');
      return;
    }
    if (ext === 'pdf') {
      toast('PDF 暂时还读不了（里面的字是排版过的，抽出来会乱）。先转成 TXT 或 EPUB');
      return;
    }
    toast('正在拆章…');
    try {
      const r = await api('/api/books', { method: 'POST', raw: file, filename: file.name });
      await refreshLibrary();
      toast('《' + r.book.title + '》已上架，共 ' + r.book.chapterCount + ' 章');
    } catch (e) {
      toast('上传失败：' + e.message);
    }
  }

  /** 书架上写清楚支持哪些格式、哪些暂时读不了 */
  async function loadFormatHint() {
    const box = $('#formatHint');
    if (!box) return;
    try {
      const r = await api('/api/formats');
      const list = r.formats || [];
      const ok = list.filter((f) => f.ok);
      const no = list.filter((f) => !f.ok);
      box.innerHTML = '';
      const line1 = document.createElement('div');
      line1.textContent = '支持：' + ok.map((f) => f.label).join(' / ');
      box.appendChild(line1);
      if (no.length) {
        const line2 = document.createElement('div');
        line2.textContent = '暂时读不了：' + no.map((f) => f.label + '（' + f.note + '）').join('；');
        box.appendChild(line2);
      }
    } catch (e) { /* ignore */ }
  }

  // ------------------------------------------------------------- 阅读器

  async function openBook(book, chapter, fromRoute) {
    current = { book: book, chapter: chapter || 1, paragraphs: [], annos: [], pageIndex: 0, pages: [] };
    // 每本书各读各的模式
    S.readMode = getBookReadMode(book.id);
    syncAnnoModeUI();
    show('#viewReader');
    // 立刻把上一本书的正文清掉 —— 不然网络慢的那一秒里，
    // 屏幕上还留着上一本书的字，看着就像"点哪本都是那本"。
    $('#readerContent').innerHTML = '';
    $('#readerTitle').textContent = book.title || '正在打开…';
    $('#readerProgress').textContent = '';
    if (!fromRoute) setHash('read', book.id, current.chapter);
    // 书架给的是缩略版书对象（没有 chapters），目录要靠章节清单 ——
    // 去要一份完整的。（原来是直接用缩略版，目录一直是空的）
    if (!book.chapters) {
      try {
        const r = await api('/api/books/' + encodeURIComponent(book.id));
        if (r && r.book && current && current.book.id === book.id) {
          current.book = r.book;
        }
      } catch (e) { /* 要不到就算了，目录空着也能读 */ }
    }
    try {
      await loadChapter(current.chapter);
    } catch (e) {
      toast('打不开：' + (e.message || '出了点问题'));
    }
  }

  // 批注模式按钮的样子：开着是实心高亮，关着是灰的
  function syncAnnoModeUI() {
    const b = $('#btnAnnoMode');
    if (!b) return;
    const on = S.readMode === 'annotate';
    b.classList.toggle('icon-btn--on', on);
    b.title = on ? '批注模式（点一下切成纯阅读）' : '纯阅读模式（点一下打开划线）';
    b.setAttribute('aria-pressed', on ? 'true' : 'false');
  }

  async function loadChapter(ch) {
    if (!current) return;
    const b = current.book;
    // 记住"我是谁"：网络回来以后如果 current 已经换成别的书了，
    // 这份数据就是过期的，直接丢掉 —— 不然会出现"点 A 显示 B"的串书。
    const myBookId = b.id;
    const myBook = b;
    let data, annos = [];
    try {
      data = await api('/api/books/' + encodeURIComponent(myBookId) + '/chapter/' + ch);
    } catch (e) {
      // 取不到正文：不要把上一本书的内容留在屏幕上（看着就像"点哪本都是那本"）
      if (current && current.book.id === myBookId) {
        $('#readerContent').innerHTML = '';
        const box = document.createElement('div');
        box.className = 'empty';
        box.textContent = '这一章没打开：' + (e.message || '取不到内容');
        $('#readerContent').appendChild(box);
        $('#readerTitle').textContent = (myBook.title || '') + ' · 打不开';
        toast('打不开：' + (e.message || '取不到内容'));
      }
      return;
    }
    try {
      const a = await api('/api/books/' + encodeURIComponent(myBookId) + '/annotations/' + ch);
      annos = a.annotations || [];
    } catch (e) { /* 还没有批注 */ }

    // 过期响应：期间用户已经切到别的书/别的章了，丢掉
    if (!current || current.book.id !== myBookId) return;

    current.chapter = ch;
    current.meta = data;
    current.paragraphs = data.paragraphs || [];
    current.annos = annos;
    $('#readerTitle').textContent = data.title || ('第 ' + ch + ' 章');
    $('#readerProgress').textContent = ch + ' / ' + (data.totalChapters || myBook.chapterCount);
    if (S.turnMode === 'pager') {
      current.pages = paginate(current.paragraphs);
      current.pageIndex = 0;
      renderPage();
    } else {
      current.pages = [];
      current.pageIndex = 0;
      renderScroll();
    }
    restoreProgress();
    buildToc();
  }

  function pageBudget() {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    return Math.max(320, Math.floor(vw * vh * 0.0034));
  }

  function paginate(paragraphs) {
    const budget = pageBudget();
    const pages = [];
    let cur = [];
    let len = 0;
    paragraphs.forEach((p, i) => {
      if (len + p.length > budget && cur.length) {
        pages.push(cur);
        cur = [];
        len = 0;
      }
      cur.push({ t: p, i: i });
      len += p.length;
    });
    if (cur.length) pages.push(cur);
    return pages.length ? pages : [[]];
  }

  function renderPage() {
    const box = $('#readerContent');
    box.innerHTML = '';
    const page = (current.pages || [])[current.pageIndex] || [];
    page.forEach((item) => {
      box.appendChild(buildPara(item.t, item.i));
    });
    if (!page.length) {
      const e = document.createElement('div');
      e.className = 'empty';
      e.textContent = '这一章是空的';
      box.appendChild(e);
    }
    $('#readerProgress').textContent = current.chapter + ' / ' + (current.book.chapterCount || 1) +
      (current.pages.length > 1 ? '  ·  ' + (current.pageIndex + 1) + '/' + current.pages.length : '');
    saveProgress();
  }

  function renderScroll() {
    const box = $('#readerContent');
    box.innerHTML = '';
    current.paragraphOffset = 0;
    current.paragraphs.forEach((text, i) => box.appendChild(buildPara(text, i)));
    if (S.readMode === 'annotate') {
      const annos = current.annos.filter((a) => a.who === 'user');
      if (annos.length) {
        const head = document.createElement('div');
        head.className = 'reader__chapter-title';
        head.textContent = '— 本章 ' + annos.length + ' 条批注 —';
        box.insertBefore(head, box.firstChild);
      }
    }
    const body = $('#readerBody');
    body.scrollTop = 0;
  }

  function onScrollSave() {
    if (!current || S.turnMode !== 'scroll') return;
    const body = $('#readerBody');
    const ratio = body.scrollTop / Math.max(1, body.scrollHeight - body.clientHeight);
    api('/api/books/' + encodeURIComponent(current.book.id) + '/progress', {
      method: 'POST', json: { chapter: current.chapter, paraIndex: 0, ratio: Math.min(1, Math.max(0, ratio)) }
    }).catch(() => {});
  }

  function buildPara(text, paraIndex) {
    const p = document.createElement('p');
    p.className = 'para';
    p.dataset.index = String(paraIndex);
    const annos = (current.annos || []).filter((a) => a.paraIndex === paraIndex);
    if (S.readMode !== 'annotate' || !annos.length) {
      p.textContent = text;
      return p;
    }
    // 按 anchor 切分高亮
    //
    // 注意 indexOf 的坑：同一句话在一段里出现两次时，两条批注都会匹配到
    // 第一次出现的位置 —— 第二条就高亮错地方了。所以这里用一个"已消费
    // 位置"表，每条批注从上次结束的地方往后找，保证顺序对上。
    const used = new Set();
    let rest = text;
    let guard = 0;
    while (rest.length && guard++ < 40) {
      let hit = null;
      for (const a of annos) {
        const key = (a.anchor || '').trim();
        if (!key) continue;
        const idx = rest.indexOf(key);
        if (idx < 0) continue;
        // 同一段文字被两条批注抢：先到先得，后面的往后找
        if (used.has(a.id)) continue;
        hit = { a: a, idx: idx, len: key.length };
        break;
      }
      if (!hit) { p.appendChild(document.createTextNode(rest)); break; }
      used.add(hit.a.id);
      if (hit.idx > 0) p.appendChild(document.createTextNode(rest.slice(0, hit.idx)));
      const span = document.createElement('span');
      span.className = 'hl ' + (hit.a.replies && hit.a.replies.length ? 'hl--ai' : 'hl--mine');
      span.textContent = rest.substr(hit.idx, hit.len);
      // 刚长按完（正在划线）时，别让这个 click 打开批注面板 —— 长按完松手
      // 浏览器会补一个 click 事件，跟划线打架。
      span.addEventListener('click', (e) => {
        e.stopPropagation();
        if (Date.now() < lpGuardUntil) return;    // 刚长按完，忽略
        openAnnoPanel(hit.a.id);
      });
      p.appendChild(span);
      rest = rest.slice(hit.idx + hit.len);
    }
    // 气泡
    annos.forEach((a) => {
      const bub = document.createElement('div');
      bub.className = 'bubble bubble--mine';
      bub.innerHTML = '<div class="bubble__name"></div><div class="bubble__text"></div>';
      $('.bubble__name', bub).textContent = (a.note ? '' : '划线') + ' · 我';
      $('.bubble__text', bub).textContent = a.note || '';
      bub.addEventListener('click', () => openAnnoPanel(a.id));
      p.appendChild(bub);
      (a.replies || []).forEach((r) => {
        const rb = document.createElement('div');
        rb.className = 'bubble bubble--ai';
        rb.innerHTML = '<div class="bubble__name"></div><div class="bubble__text"></div>';
        $('.bubble__name', rb).textContent = '他';
        setBubbleText($('.bubble__text', rb), r.text);
        p.appendChild(rb);
      });
    });
    return p;
  }

  function buildToc() {
    const list = $('#tocList');
    list.innerHTML = '';
    (current.book.chapters || []).forEach((c) => {
      const item = document.createElement('div');
      item.className = 'toc__item' + (c.index === current.chapter ? ' toc__item--active' : '');
      item.textContent = c.title || ('第 ' + c.index + ' 章');
      item.addEventListener('click', () => {
        $('#toc').classList.add('hidden');
        loadChapter(c.index);
      });
      list.appendChild(item);
    });
  }

  function restoreProgress() {
    api('/api/books/' + encodeURIComponent(current.book.id) + '/progress')
      .then((r) => {
        const p = r.progress;
        if (!p || p.chapter !== current.chapter) return;
        if (S.turnMode === 'pager' && current.pages.length) {
          const idx = Math.min(current.pages.length - 1, Math.floor((p.ratio || 0) * current.pages.length));
          current.pageIndex = idx;
          renderPage();
        }
      })
      .catch(() => {});
  }

  function saveProgress() {
    if (!current) return;
    const ratio = S.turnMode === 'pager' && current.pages.length
      ? (current.pageIndex + 1) / current.pages.length
      : (current.chapter - 1) / Math.max(1, current.book.chapterCount);
    api('/api/books/' + encodeURIComponent(current.book.id) + '/progress', {
      method: 'POST',
      json: { chapter: current.chapter, paraIndex: current.pageIndex, ratio: Math.min(1, Math.max(0, ratio)) }
    }).catch(() => {});
  }

  // ------------------------------------------------------- 选区与批注
  //
  // 桌面：鼠标拖选、双击选词。
  // 手机 / 平板：长按。
  //
  // 触屏端有四个坑，每一个都足以让"长按划线"彻底失灵：
  //   1) 系统长按会先弹自己的"复制/粘贴"气泡或选择工具条，那个东西会吃掉我们
  //      工具条上的第一次点击 —— CSS 关掉系统气泡，工具条用 fixed 定位。
  //   2) 系统选区落地是异步的：touchend 那一刻往往还没选好 —— 所以改用
  //      selectionchange 驱动，而不是 touchend + 延时。
  //   3) 长按之后手指一动，"横向滑动翻页"会判定成翻页 → 整页重画 → 选区没了。
  //      所以长按中 / 本次手势里刚产生选区时都不许翻页。
  //   4) 各家原生长按行为不一致（谁先弹、弹什么、选区什么时候落地都不同）。
  //      所以我们自己接管：到点我们自己取词、自己选中、自己弹工具条。

  let selBarPressed = false;   // 正按着工具条：此时不许因选区塌缩而隐藏
  let selTimer = 0;            // selectionchange 防抖
  let selCreatedAt = 0;        // 最近一次"选区成立"的时刻
  let lpTimer = 0;             // 触屏长按计时器
  let lpStart = null;          // 长按起点
  let lpActive = false;        // 本次手势按出过长按 → 不许翻页
  let lpGuardUntil = 0;        // 长按保护期：这段时间内的 click 一律忽略
                              // （长按松手后浏览器会补一个 click，
                              //   不挡的话会跟划线打架）

  // 段落正文（不含批注气泡）在 DOM 里对应到原文的偏移对照表。
  // 划线是按"原文里的那串字"存回去的，所以必须以原文为准 —— 直接用
  // String(selection) 会把气泡里的字也算进去，回头就找不到这一段了。
  function paraTextIndex(paraEl) {
    const nodes = [];
    let text = '';
    (function walk(el) {
      for (const child of el.childNodes) {
        if (child.nodeType === 3) {
          nodes.push({ node: child, start: text.length });
          text += child.data;
        } else if (child.nodeType === 1) {
          if (child.classList && child.classList.contains('bubble')) continue;  // 气泡不算正文
          walk(child);
        }
      }
    })(paraEl);
    return { text: text, nodes: nodes };
  }

  function anchorTextOf(range, paraEl) {
    const idx = paraTextIndex(paraEl);
    let s = null, e = null;
    for (const n of idx.nodes) {
      if (n.node === range.startContainer) s = n;
      if (n.node === range.endContainer) e = n;
    }
    if (s && e) {
      let a = s.start + range.startOffset;
      let b = e.start + range.endOffset;
      if (b < a) { const t = a; a = b; b = t; }
      a = Math.max(0, Math.min(a, idx.text.length));
      b = Math.max(0, Math.min(b, idx.text.length));
      const t = idx.text.slice(a, b).trim();
      if (t) return t;
    }
    return String(range || '').trim();
  }

  function currentSel() {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
    const range = sel.getRangeAt(0);
    const node = sel.anchorNode;
    const el = node && node.nodeType === 3 ? node.parentElement : node;
    // 选区可能落在"已经划过线"的那段字里（.hl），要往上找到真正的那一段
    const para = el && el.closest ? el.closest('.para') : null;
    if (!para) return null;
    const anchor = anchorTextOf(range, para);
    if (!anchor || anchor.length > 500) return null;
    return { anchor: anchor, paraIndex: Number(para.dataset.index), range: range };
  }

  function onSelection() {
    if (!current || S.readMode !== 'annotate') return;
    const info = currentSel();
    if (!info) {
      // 选区没了。正文里的选区消失 = 用户点了别处 → 收起工具条；
      // 但如果刚才正按着工具条（手指还没抬），或者刚刚才长按完
      // （安卓的系统工具条会短暂抢走选区），就别收 —— 否则工具条会闪一下。
      const justLongPressed = Date.now() < lpGuardUntil;
      if (!selBarPressed && !justLongPressed) hideSelBar();
      return;
    }
    selCreatedAt = Date.now();
    selBarState = { anchor: info.anchor, paraIndex: info.paraIndex };
    placeSelBar(info.range.getBoundingClientRect());
  }

  // 工具条贴着选区放。
  //
  // 安卓 Chrome 的浮动工具条（复制/分享/全选）弹在选区**上方**，
  // 所以安卓这一档我们的工具条放**下方** —— 两边错开，谁也不压谁。
  // iPad/桌面：默认下方，下面放不下就翻上去。
  function placeSelBar(rect) {
    if (!rect || (!rect.width && !rect.height)) return;
    const bar = $('#selBar');
    bar.classList.remove('hidden');
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const bw = bar.offsetWidth || 160;
    const bh = bar.offsetHeight || 44;
    const M = 8;
    let left = rect.left + rect.width / 2;
    left = Math.min(Math.max(left, bw / 2 + M), vw - bw / 2 - M);
    let top;
    if (isAndroidLike()) {
      // 安卓：放下方
      top = rect.bottom + 10;
      if (top + bh > vh - M) top = rect.top - bh - 10;   // 下方放不下才翻上去
    } else {
      top = rect.bottom + 10;
      if (top + bh > vh - M) top = rect.top - bh - 10;
    }
    if (top < M) top = rect.bottom + 10;
    top = Math.min(Math.max(top, M), Math.max(M, vh - bh - M));
    bar.style.left = left + 'px';
    bar.style.top = top + 'px';
    bar.style.bottom = 'auto';
    bar.style.transform = 'translateX(-50%)';
  }

  function hideSelBar() {
    $('#selBar').classList.add('hidden');
  }

  // 工具条上的动作。anchor / paraIndex 早就存好了 —— 不依赖此刻的选区，
  // 因为在手机上点按钮那一刻选区可能已经被系统收走了。
  function doSelAction(act) {
    const anchor = selBarState.anchor;
    const idx = selBarState.paraIndex;
    if (!anchor) { hideSelBar(); return; }
    hideSelBar();
    if (act === 'highlight') {
      saveAnnotation(anchor, '', idx);
    } else {
      openNoteModal(anchor, idx);
    }
  }

  // ------------------------------------------------------- 我们自己接管长按
  //
  // 到点了就在手指底下取词、选中、弹工具条 —— 不依赖各家系统那套
  // 不一样的原生长按（有的先弹气泡再选，有的选完才弹）。
  //
  // 但安卓要另说：
  //   iPad (iOS)  长按 → 系统弹「复制/粘贴」气泡，我们用 -webkit-touch-callout:none 关掉
  //   安卓 Chrome  长按 → 系统弹**浮动工具条**（复制/分享/全选），
  //                    -webkit-touch-callout 对它无效，只能靠 contextmenu preventDefault；
  //                    而且它弹出来的位置在选区**上方**，我们的工具条得放**下方**才不被压住。
  //
  // 所以安卓这一档：
  //   · 长按延后到 520ms（等系统先弹它的工具条，我们再弹自己的，它就压不住我们）
  //   · 工具条固定放在选区**下方**（避开安卓系统工具条的位置）
  //
  // 另外安卓上"谁先选词"有两种打法，各有机型偏好：
  //   'auto'  等系统选（默认）—— 选词最准，但系统的浮动工具条会跟着弹出来
  //   'self'  我们自己取词 —— 工具条干净，但取词范围是我们定的（整句/整词）
  // 姜来可以在设置里改；auto 在她那台机器上不好使就切 self。
  function isAndroidLike() {
    return /Android/i.test(navigator.userAgent || '');
  }
  function lpStrategy() {
    return S.lpStrategy || 'auto';
  }

  function rangeAtPoint(x, y) {
    let range = null;
    if (document.caretRangeFromPoint) {
      try { range = document.caretRangeFromPoint(x, y); } catch (err) { range = null; }
    }
    if (!range && document.caretPositionFromPoint) {
      try {
        const pos = document.caretPositionFromPoint(x, y);
        if (pos && pos.offsetNode) {
          range = document.createRange();
          range.setStart(pos.offsetNode, pos.offset);
          range.collapse(true);
        }
      } catch (err) { range = null; }
    }
    if (!range) return null;
    return expandToPhrase(range);
  }

  const SEL_BREAK = /[，。！？；：、,.!?;:"'（）()《》「」『』…—·\n\r]/;
  const SEL_WORD = /[0-9A-Za-z_À-ɏ一-鿿぀-ヿ가-힯]/;

  // 扩成"一个词/一句话"：英文按词，中文按标点断句（最多各取 20 字）。
  function expandToPhrase(range) {
    let node = range.startContainer;
    if (!node || node.nodeType !== 3) {
      const walker = document.createTreeWalker(node || document.body, NodeFilter.SHOW_TEXT);
      node = walker.nextNode();
      if (!node) return null;
    }
    const text = node.data;
    const i = Math.max(0, Math.min(range.startOffset, text.length));
    let start = i, end = i;
    if (i < text.length && SEL_WORD.test(text.charAt(i))) {
      let n = 0;
      while (start > 0 && n < 20) {
        const ch = text.charAt(start - 1);
        if (SEL_BREAK.test(ch) || !SEL_WORD.test(ch)) break;
        start--; n++;
      }
      let m = 0;
      while (end < text.length && m < 20) {
        const ch = text.charAt(end);
        if (SEL_BREAK.test(ch) || !SEL_WORD.test(ch)) break;
        end++; m++;
      }
    }
    if (end <= start) end = Math.min(text.length, start + 1);
    const out = document.createRange();
    try {
      out.setStart(node, start);
      out.setEnd(node, end);
    } catch (err) { return null; }
    return out;
  }

  function doLongPress(x, y) {
    lpActive = true;
    lpGuardUntil = Date.now() + 700;    // 长按保护期：松手后补的那个 click 一律忽略

    if (isAndroidLike() && lpStrategy() === 'auto') {
      // 安卓：别跟系统抢选区。
      //
      // Chrome 长按会自己选中词并弹浮动工具条 —— 那个选区是**真的**，
      // 我们没必要再自己 addRange 一次（抢来抢去反而会闪）。
      // 所以安卓只做一件事：等系统的选区落地，然后弹我们自己的工具条。
      // 如果 200ms 后系统还没给出选区（有些安卓机不自动选词），我们再自己取。
      setTimeout(() => {
        const sel = window.getSelection();
        if (sel && !sel.isCollapsed && String(sel).trim()) {
          onSelection();               // 系统选好了 → 直接弹工具条
        } else {
          const range = rangeAtPoint(x, y);
          if (!range) return;
          try {
            sel.removeAllRanges();
            sel.addRange(range);
          } catch (e) { return; }
          onSelection();
        }
      }, 200);
      return;
    }

    // iPad / 桌面：自己取词
    const range = rangeAtPoint(x, y);
    if (!range) return;
    const sel = window.getSelection();
    if (!sel) return;
    try {
      sel.removeAllRanges();
      sel.addRange(range);
    } catch (err) { return; }
    onSelection();
  }

  async function saveAnnotation(anchor, note, paraIndex) {
    try {
      await api('/api/books/' + encodeURIComponent(current.book.id) + '/annotations/' + current.chapter, {
        method: 'POST', json: { anchor: anchor, note: note, paraIndex: paraIndex }
      });
      const a = await api('/api/books/' + encodeURIComponent(current.book.id) + '/annotations/' + current.chapter);
      current.annos = a.annotations || [];
      if (S.turnMode === 'pager') renderPage(); else renderScroll();
      toast('存下了');
    } catch (e) {
      toast('没存上：' + e.message);
    }
  }

  // ------------------------------------------- 待回批注 · 轮询提示
  // 姜来在聊天里回批注是有延迟的（他要先醒来）。所以页面自己盯着，
  // 一旦有你划线还没回的地方，顶栏就亮一个 💬 —— 不用切窗口来喊他。
  let pendingByBook = {};
  let pendingTimer = null;
  let lastActivityTs = 0;

  /**
   * 轮询间隔。
   *
   * **没连 GitHub 的时候要放慢** —— 未登录状态下 GitHub 的接口每个 IP 每小时只有 60 次，
   * 20 秒一次 = 180 次/小时，直接把额度打满，然后「打不开书」、
   * 而且报的是看不懂的 403。
   * 连上 token 之后走的是认证接口（5000 次/小时），20 秒随便轮。
   */
  function pollInterval() {
    if (!window.__NOOK_STATIC__) return 20000;
    const has = window.GhApi && window.GhApi.hasToken ? window.GhApi.hasToken() : false;
    return has ? 20000 : 240000;   // 没 token：4 分钟一次
  }

  async function pollPending() {
    try {
      const r = await api('/api/pending');
      const items = r.items || [];
      const byBook = {};
      items.forEach((it) => {
        byBook[it.bookId] = (byBook[it.bookId] || 0) + 1;
      });
      const before = JSON.stringify(pendingByBook);
      pendingByBook = byBook;
      if (JSON.stringify(pendingByBook) !== before) {
        updatePendingUI(items);
      }
      // 姜去回完批注 → 活动戳会变 → 正在读的这一章自动重画，蓝色气泡就出来了
      const p = await api('/api/ping');
      if (p.ts && p.ts !== lastActivityTs) {
        const first = lastActivityTs === 0;
        lastActivityTs = p.ts;
        if (!first && current && currentView === '#viewReader') {
          await loadChapter(current.chapter);
          if (!$('#annoPanel').classList.contains('hidden')) openAnnoPanel();
          toast('姜去回批注了');
        }
      }
    } catch (e) { /* 没登录或者服务没起，安静点 */ }
  }

  function updatePendingUI(items) {
    const btnEl = $('#btnPending');
    const n = (items || []).length;
    if (btnEl) {
      if (n > 0) {
        btnEl.textContent = '💬 ' + n;
        btnEl.classList.remove('hidden');
        btnEl.title = '姜去有 ' + n + ' 句话要说';
      } else {
        btnEl.classList.add('hidden');
      }
    }
    if (currentView === '#viewShelf') renderShelf();
  }

  // -------------------------------------------------------- 批注面板

  async function openAnnoPanel(focusId) {
    const panel = $('#annoPanel');
    const list = $('#annoList');
    list.innerHTML = '';
    const annos = current.annos.filter((a) => a.who === 'user');
    if (!annos.length) {
      list.innerHTML = '<div class="empty">这一章还没有批注。<br>选中一段文字，试试划线或写想法。</div>';
    }
    annos.forEach((a) => {
      const item = document.createElement('div');
      item.className = 'anno-item' + (a.replies && a.replies.length ? ' anno-item--replied' : '');
      item.id = 'anno-' + a.id;
      const meta = document.createElement('div');
      meta.className = 'anno-item__meta';
      meta.textContent = (a.replies && a.replies.length ? '✓ 已回复' : '… 等他回') + ' · ' + new Date(a.ts).toLocaleString('zh-CN', { hour12: false });
      const anchor = document.createElement('div');
      anchor.className = 'anno-item__anchor';
      anchor.textContent = '「' + a.anchor + '」';
      const note = document.createElement('div');
      note.className = 'anno-item__note';
      note.textContent = a.note || '（只划了线）';
      item.appendChild(meta);
      item.appendChild(anchor);
      item.appendChild(note);
      (a.replies || []).forEach((r) => {
        const b = document.createElement('div');
        b.className = 'bubble bubble--ai';
        b.innerHTML = '<div class="bubble__name"></div><div class="bubble__text"></div>';
        $('.bubble__name', b).textContent = '他';
        setBubbleText($('.bubble__text', b), r.text);
        item.appendChild(b);
      });
      list.appendChild(item);
    });
    panel.classList.remove('hidden');
    if (focusId) {
      const el = document.getElementById('anno-' + focusId);
      if (el) el.scrollIntoView({ block: 'center' });
    }
  }

  // ------------------------------------------------------------- 工作台

  async function loadWorkbench() {
    const wb = await api('/api/workbench');
    const st = wb.stats || {};
    const statsBox = $('#wbStats');
    statsBox.innerHTML = '';
    [
      { n: st.calls || 0, l: '总调用' },
      { n: (st.tokens || 0).toLocaleString('zh-CN'), l: '总 tokens' },
      { n: '¥' + (st.cost || 0).toFixed(4), l: '估算花费' },
      { n: st.failed || 0, l: '失败' }
    ].forEach((x) => {
      const d = document.createElement('div');
      d.className = 'stat';
      d.innerHTML = '<div class="stat__num"></div><div class="stat__label"></div>';
      $('.stat__num', d).textContent = x.n;
      $('.stat__label', d).textContent = x.l;
      statsBox.appendChild(d);
    });

    const notesBox = $('#wbNotes');
    notesBox.innerHTML = '';

    // 计价说明：官方是峰谷分时价，账本按调用当时的档位算
    if (wb.pricing) {
      const p = wb.pricing;
      const model = p.model || 'deepseek-flash';
      const row = p.table && p.table[model];
      const rate = row ? (p.nowIsPeak ? row.peak : row.offpeak) : null;
      const line = document.createElement('div');
      line.className = 'muted';
      line.style.cssText = 'margin:2px 0 12px;font-size:.86rem;line-height:1.6';
      line.textContent = rate
        ? '帮工模型 ' + model + ' · 当前' + (p.nowIsPeak ? '高峰档' : '低谷档') +
          ' · 输入未命中 ¥' + rate.cache_miss + '/M、缓存命中 ¥' + rate.cache_hit +
          '/M、输出 ¥' + rate.output + '/M（DeepSeek 官方价，账本按调用当时的档位估算）'
        : '帮工模型 ' + model;
      notesBox.appendChild(line);
    }

    (wb.books || []).forEach((b) => {
      const card = document.createElement('div');
      card.className = 'note-card';
      card.innerHTML = '<div class="note-card__ch"></div><div class="muted"></div>';
      $('.note-card__ch', card).textContent = b.title;
      const est = b.noteEstimate || null;
      $('.muted', card).textContent = b.chapterCount + ' 章 · 已生成 ' + b.noteCount + ' 份笔记' +
        (est && est.chapters ? ' · 剩余 ' + est.chapters + ' 章约 ¥' + est.cost.toFixed(2) : '');
      const row = document.createElement('div');
      row.className = 'btn-row';
      if (b.noteCount < b.chapterCount) {
        row.appendChild(btn('生成剧情笔记', 'btn--primary btn--sm', () => openGenModal(b)));
      }
      card.appendChild(row);
      notesBox.appendChild(card);
    });

    const logBox = $('#wbLog');
    logBox.innerHTML = '';
    if (!wb.logs || !wb.logs.length) {
      logBox.innerHTML = '<div class="empty">还没有任何调用记录。</div>';
    }
    (wb.logs || []).forEach((l) => {
      const row = document.createElement('div');
      row.className = 'log-row' + (l.ok ? '' : ' log-row--err');
      row.innerHTML = '<div class="log-row__task"></div><div class="log-row__meta"></div>';
      $('.log-row__task', row).textContent =
        (l.ok ? '✓ ' : '✕ ') + (l.task || '') + (l.detail ? ' · ' + l.detail : '') +
        ' · ' + (l.book || '');
      const cache = l.cacheHitTokens ? ('（缓存命中 ' + l.cacheHitTokens + '）') : '';
      $('.log-row__meta', row).textContent =
        new Date(l.ts).toLocaleString('zh-CN', { hour12: false }) +
        ' · ' + (l.promptTokens || 0) + '+' + (l.completionTokens || 0) + ' tok' + cache +
        ' · ' + (l.durationMs || 0) + 'ms' +
        ' · ¥' + (l.cost || 0).toFixed(5) +
        (l.period ? ' · ' + (l.period === 'peak' ? '高峰档' : '低谷档') : '') +
        (l.error ? ' · ' + l.error : '');
      logBox.appendChild(row);
    });
  }

  // ------------------------------------------------------------- 事件

  function wireEvents() {
    $('#loginBtn').addEventListener('click', doLogin);
    $('#passcode').addEventListener('keydown', (e) => { if (e.key === 'Enter') doLogin(); });

    // GitHub 连接（只有静态版用得上；本地版这些元素被藏起来了）
    const ghToggle = $('#loginGhToggle');
    if (ghToggle) {
      ghToggle.addEventListener('click', () => {
        const body = $('#loginGhBody');
        if (body) body.classList.toggle('hidden');
      });
    }
    const ghSave = $('#ghTokenSave');
    if (ghSave) {
      ghSave.addEventListener('click', () => {
        const inp = $('#ghToken');
        const t = ((inp && inp.value) || '').trim();
        if (!t) { toast('先把 token 粘进来'); return; }
        if (window.GhApi && window.GhApi.setToken) window.GhApi.setToken(t);
        if (inp) inp.value = '';
        ghTokenChanged();
        toast('连上了 · 现在能划线了');
      });
    }
    const btnSaveGh = $('#btnSaveGhToken');
    if (btnSaveGh) {
      btnSaveGh.addEventListener('click', () => {
        const inp = $('#setGhToken');
        const t = ((inp && inp.value) || '').trim();
        if (!t) { toast('先把 token 粘进来'); return; }
        if (window.GhApi && window.GhApi.setToken) window.GhApi.setToken(t);
        if (inp) inp.value = '';
        ghTokenChanged();
        toast('存好了');
      });
    }
    const btnClearGh = $('#btnClearGhToken');
    if (btnClearGh) {
      btnClearGh.addEventListener('click', () => {
        if (window.GhApi && window.GhApi.setToken) window.GhApi.setToken('');
        const inp = $('#setGhToken');
        if (inp) inp.value = '';
        ghTokenChanged();
        toast('token 删了 · 现在是只读');
      });
    }

    $('#btnHome').addEventListener('click', () => { refreshLibrary(); setHash('shelf'); show('#viewShelf'); });
    $('#btnSettings').addEventListener('click', () => { setHash('settings'); show('#viewSettings'); loadServerSettings(); });
    $('#btnWorkbench').addEventListener('click', () => { setHash('workbench'); show('#viewWorkbench'); loadWorkbench(); });
    $('#btnBack').addEventListener('click', () => { saveProgress(); refreshLibrary(); setHash('shelf'); show('#viewShelf'); });
    $('#btnToc').addEventListener('click', () => $('#toc').classList.toggle('hidden'));
    $('#tocClose').addEventListener('click', () => $('#toc').classList.add('hidden'));
    $('#btnAnno').addEventListener('click', () => openAnnoPanel());
    $('#annoClose').addEventListener('click', () => $('#annoPanel').classList.add('hidden'));

    // 批注模式开关：在书里随时能切。划不了线的时候，这个按钮就是救命稻草。
    $('#btnAnnoMode').addEventListener('click', () => {
      if (!current) return;
      const next = S.readMode === 'annotate' ? 'read' : 'annotate';
      setBookReadMode(current.book.id, next);
      syncAnnoModeUI();
      hideSelBar();
      if (S.turnMode === 'pager') renderPage(); else renderScroll();
      toast(next === 'annotate' ? '批注模式：长按文字可以划线' : '纯阅读模式：不划线');
    });

    // 待回批注：点了直接跳到那一章的批注面板
    $('#btnPending').addEventListener('click', async () => {
      try {
        const r = await api('/api/pending');
        const items = r.items || [];
        if (!items.length) { toast('没有待回的批注'); return; }
        const it = items[0];
        const b = books.find((x) => x.id === it.bookId);
        if (!b) { toast('那本书不在书架上了'); return; }
        await openBook(b, it.chapter);
        openAnnoPanel(it.annotationId);
        pollPending();
      } catch (e) {
        toast('打不开：' + e.message);
      }
    });

    $('#btnPrev').addEventListener('click', () => goChapter(-1));
    $('#btnNext').addEventListener('click', () => goChapter(1));
    $('#tapLeft').addEventListener('click', () => turn(-1));
    $('#tapRight').addEventListener('click', () => turn(1));

    // 模式 / 背景 / 翻页 / 字号
    $('#modeSeg').addEventListener('click', (e) => {
      const t = e.target.closest('[data-mode]');
      if (t) { S.mode = t.dataset.mode; applyAppearance(); }
    });
    $('#bgSeg').addEventListener('click', (e) => {
      const t = e.target.closest('[data-bg]');
      if (t) { S.bgMode = t.dataset.bg; applyAppearance(); }
    });
    $('#turnSeg').addEventListener('click', (e) => {
      const t = e.target.closest('[data-turn]');
      if (t) { S.turnMode = t.dataset.turn; applyAppearance(); if (current) loadChapter(current.chapter); }
    });
    $('#fontSeg').addEventListener('click', (e) => {
      const t = e.target.closest('[data-size]');
      if (t) { S.fontSize = Number(t.dataset.size); applyAppearance(); }
    });

    // 长按取词策略：只在安卓上出现（iPad 不用管）
    $('#lpSeg').addEventListener('click', (e) => {
      const t = e.target.closest('[data-lp]');
      if (!t) return;
      S.lpStrategy = t.dataset.lp;
      saveSettings();
      syncLpStrategyUI();
      toast(S.lpStrategy === 'self' ? '长按由我们自己取词' : '长按跟系统选词');
    });

    // 上传
    $('#fileInput').addEventListener('change', (e) => uploadFile(e.target.files[0]));
    const drop = $('#uploadDrop');
    ['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('btn--primary'); }));
    ['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('btn--primary'); }));
    drop.addEventListener('drop', (e) => uploadFile(e.dataTransfer.files[0]));

    // 背景图
    $('#bgImageInput').addEventListener('change', (e) => {
      const f = e.target.files[0];
      if (!f) return;
      const r = new FileReader();
      r.onload = () => { S.bgImage = r.result; S.bgMode = 'image'; applyAppearance(); };
      r.readAsDataURL(f);
    });

    // 设置里的服务器项
    $('#btnSaveSettings').addEventListener('click', saveServerSettings);
    $('#btnResetSettings').addEventListener('click', () => {
      localStorage.removeItem('nook.settings');
      S = loadSettings();
      applyAppearance();
      toast('外观已恢复默认');
    });

    // 选区工具条
    // 用 pointerdown/pointerup 自己处理，不靠 click —— 手机上系统长按气泡
    // 会吃掉 click 的第一次触发；而且手指按下去时浏览器已经把选区收起来了，
    // 等 click 到达时选区早就塌了。所以按下先记下动作，抬起才执行。
    const selBar = $('#selBar');
    let selBarAct = null;
    let selBarClickUntil = 0;
    selBar.addEventListener('pointerdown', (e) => {
      const t = e.target.closest('[data-act]');
      if (!t) return;
      selBarPressed = true;                 // 手指/鼠标正按着：别让选区塌缩把工具条收走
      selBarAct = { act: t.dataset.act, x: e.clientX, y: e.clientY };
    });
    selBar.addEventListener('pointerup', (e) => {
      if (!selBarAct) { selBarPressed = false; return; }
      const moved = Math.abs(e.clientX - selBarAct.x) > 14 || Math.abs(e.clientY - selBarAct.y) > 14;
      const act = selBarAct.act;
      selBarAct = null;
      selBarPressed = false;
      if (moved) return;                    // 拖出去了，不算点
      selBarClickUntil = Date.now() + 600;  // pointerup 已经干过活了，别让 click 再来一次
      doSelAction(act);
    });
    selBar.addEventListener('pointercancel', () => { selBarPressed = false; selBarAct = null; });
    selBar.addEventListener('click', (e) => {
      if (Date.now() < selBarClickUntil) return;   // pointerup 已经处理过了
      const t = e.target.closest('[data-act]');
      if (!t) return;
      doSelAction(t.dataset.act);
    });

    // 弹窗
    $('#modalClose').addEventListener('click', closeModal);
    $('#modalCancel').addEventListener('click', closeModal);
    $('#modal .modal__mask').addEventListener('click', closeModal);
    $('#modalSave').addEventListener('click', async () => {
      const text = $('#modalText').value.trim();
      closeModal();
      if (text) saveAnnotation(modalState.anchor, text, modalState.paraIndex);
    });

    // 生成剧情笔记的确认弹窗
    $('#genClose').addEventListener('click', closeGenModal);
    $('#genCancel').addEventListener('click', closeGenModal);
    $('#genModal .modal__mask').addEventListener('click', closeGenModal);
    $('#genStart').addEventListener('click', async () => {
      const book = genState.book;
      if (!book) return;
      const budget = Number($('#genBudget').value) || 0;
      closeGenModal();
      try {
        const r = await api('/api/tasks/notes', { method: 'POST', json: { bookId: book.id, maxCost: budget } });
        if (!r.ok) { toast('开不了：' + (r.error || '缺 key')); return; }
        let msg = '已排 ' + r.planned + ' 章（约 ¥' + r.estimated + '）';
        if (r.skipped) msg += '，' + r.skipped + ' 章超预算没排';
        if (r.skippedByKind) msg += '，' + r.skippedByKind + ' 个附录章节已跳过';
        toast(msg + '，进度看工作台日志');
        setTimeout(() => loadWorkbench(), 1500);
      } catch (e) {
        toast('没排上：' + e.message);
      }
    });

    // 选区监听
    //
    // 桌面：mouseup 之后选区就定型了。
    // 触屏：系统选区什么时候落地是不确定的（iOS 的气泡、Android 的选择条
    // 都会延后），所以真正的驱动源是 selectionchange —— 它每次选区变化
    // 都会响。用防抖把一串连续变化收成一次。
    document.addEventListener('mouseup', () => setTimeout(onSelection, 10));
    document.addEventListener('selectionchange', () => {
      if (selTimer) clearTimeout(selTimer);
      selTimer = setTimeout(() => { selTimer = 0; onSelection(); }, 40);
    });
    // 滚动进度只挂一次（之前每次 renderScroll 都挂一遍，越读越慢）
    $('#readerBody').addEventListener('scroll', onScrollSave, { passive: true });

    // 触屏长按我们自己接管：
    //   · 手指按住不动 → 我们自己在手指底下取词、选中、弹工具条
    //   · 手指动了（想滚动）→ 取消
    //   · 系统自己也可能弹了原生菜单 → 把它关掉，免得抢走我们工具条的第一下
    //
    // 安卓的延迟不一样：Chrome 大约 500ms 才弹它自己的浮动工具条，
    // 我们要是 380ms 就弹 ours，它会后到并盖住我们。所以安卓等 520ms。
    const readerBody = $('#readerBody');
    function lpDelay() {
      if (!isAndroidLike()) return 380;
      return lpStrategy() === 'self' ? 380 : 520;
    }
    readerBody.addEventListener('touchstart', (e) => {
      lpActive = false;
      if (!current || S.readMode !== 'annotate') return;
      if (e.touches.length !== 1) return;
      const t = e.touches[0];
      lpStart = { x: t.clientX, y: t.clientY };
      clearTimeout(lpTimer);
      lpTimer = setTimeout(() => {
        lpTimer = 0;
        if (!lpStart) return;
        doLongPress(lpStart.x, lpStart.y);
      }, lpDelay());
    }, { passive: true });

    readerBody.addEventListener('touchmove', (e) => {
      if (!lpStart) return;
      const t = e.touches[0];
      if (Math.abs(t.clientX - lpStart.x) > 12 || Math.abs(t.clientY - lpStart.y) > 12) {
        lpStart = null;                    // 手指动了 = 想滚动，不是想划线
        clearTimeout(lpTimer);
        lpTimer = 0;
      }
    }, { passive: true });

    const endTouch = () => {
      clearTimeout(lpTimer);
      lpTimer = 0;
      lpStart = null;
    };
    readerBody.addEventListener('touchend', endTouch, { passive: true });
    readerBody.addEventListener('touchcancel', endTouch, { passive: true });

    // 干掉系统长按菜单（iOS 的复制气泡 / Android 的浮动工具条）：
    // 它们会压在我们的工具条上，还会吃掉第一次点击。
    //
    // 挂在 document 上并用捕获阶段 —— 安卓的浮动工具条不一定冒泡到
    // readerBody（Chrome 会在更上层处理），只在 readerBody 上监听会漏掉。
    document.addEventListener('contextmenu', (e) => {
      if (S.readMode !== 'annotate') return;
      // 只在正文区域里屏蔽，别把设置页输入框的右键菜单也吃了
      if (e.target && e.target.closest && !e.target.closest('#readerContent, #selBar')) return;
      e.preventDefault();
    }, true);

    // 安卓额外一招：Chrome 有时用 touch 事件而不是 contextmenu 触发选择菜单，
    // 长按后紧跟一个 touchend，我们把它吞掉，别让它变成一次"点空白处"
    // （会把我们的选区收掉，用户看到的就是"选不中"）。
    if (isAndroidLike()) {
      let lpGuardUntil = 0;
      readerBody.addEventListener('touchend', (e) => {
        if (Date.now() < lpGuardUntil) {
          e.preventDefault();
          e.stopPropagation();
        }
      }, { passive: false });
      const markLp = () => { lpGuardUntil = Date.now() + 400; };
      readerBody.addEventListener('touchstart', markLp, { passive: true });
    }

    // 键盘
    document.addEventListener('keydown', (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
      if (e.key === 'ArrowLeft') turn(-1);
      if (e.key === 'ArrowRight') turn(1);
      if (e.key === 'Escape') { hideSelBar(); closeModal(); $('#toc').classList.add('hidden'); $('#annoPanel').classList.add('hidden'); }
    });

    // 滑动翻页
    //
    // 关键：长按划线时手指也会动一点点（人有手的），一旦位移过了 60px
    // 就翻页 → 整页重画 → 刚选好的选区瞬间消失 → 用户看到的是"长按没反应"。
    // 所以：这次手势里只要出现过选区，或者按得够久（是长按不是滑动），
    // 一律不翻页。
    let touchX = null;
    let touchAt = 0;
    $('#readerBody').addEventListener('touchstart', (e) => {
      touchX = e.touches[0].clientX;
      touchAt = Date.now();
    }, { passive: true });
    $('#readerBody').addEventListener('touchend', (e) => {
      if (touchX === null || S.turnMode !== 'pager') { touchX = null; return; }
      const dx = e.changedTouches[0].clientX - touchX;
      const held = Date.now() - touchAt;
      touchX = null;
      if (lpActive) { lpActive = false; return; }     // 这次是长按，别翻页
      if (selCreatedAt && Date.now() - selCreatedAt < 1200) return;  // 刚划了线
      if (held > 350) return;                          // 按了半天才松 = 长按
      if (Math.abs(dx) > 60) turn(dx < 0 ? 1 : -1);
    }, { passive: true });

    window.addEventListener('hashchange', () => { applyRoute(); });

    window.addEventListener('resize', () => {
      syncViewportHeight();
      // 手机上滚动会改变地址栏高度 → 触发 resize → 整页重画 → 刚长按选好的
      // 选区瞬间被冲掉，用户看到的就是"长按没反应"。
      // 所以：正在划线/选区还活着的时候，绝不重画。
      if (selBarPressed || lpActive) return;
      if (selCreatedAt && Date.now() - selCreatedAt < 1500) return;
      if (current && S.turnMode === 'pager') {
        current.pages = paginate(current.paragraphs);
        current.pageIndex = Math.min(current.pageIndex, current.pages.length - 1);
        renderPage();
      }
    });

    // 软键盘弹起/收起时 visualViewport 会变 —— 弹窗要跟着挪
    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', syncViewportHeight);
      window.visualViewport.addEventListener('scroll', syncViewportHeight);
    }
    syncViewportHeight();
  }

  let modalState = { anchor: '', paraIndex: -1 };

  function openNoteModal(anchor, paraIndex) {
    modalState = { anchor, paraIndex };
    $('#modalAnchor').textContent = '「' + anchor + '」';
    $('#modalText').value = '';
    $('#modal').classList.remove('hidden');
    syncViewportHeight();
    setTimeout(() => { syncViewportHeight(); $('#modalText').focus(); }, 60);
  }

  // 手机上软键盘弹出来以后，vh / dvh 不一定变（iOS 上不变），
  // 但 visualViewport.height 一定会变 —— 弹窗要按这个高度摆，才不会被键盘盖住。
  function syncViewportHeight() {
    const vv = window.visualViewport;
    const h = vv ? vv.height : window.innerHeight;
    document.documentElement.style.setProperty('--vh', h + 'px');
  }

  function closeModal() {
    $('#modal').classList.add('hidden');
  }

  // ------------------------------------------- 生成剧情笔记 · 确认弹窗
  // 花钱的事必须先让她看见数字、并自己划一条预算线。
  let genState = { book: null };

  function openGenModal(book) {
    genState.book = book;
    const est = book.noteEstimate || { chapters: 0, cost: 0, peak: false };
    const pending = book.pendingNotes != null ? book.pendingNotes : est.chapters;
    const skip = book.skippedNotes || 0;
    $('#genInfo').textContent =
      '《' + book.title + '》还有 ' + pending + ' 章没写剧情笔记。' +
      '预计花费 ¥' + (est.cost || 0).toFixed(2) +
      '（' + (est.peak ? '当前高峰档' : '当前低谷档') + '价，' +
      '花钱大头是把整章正文发给帮工，输出只有 150-250 字）' +
      (skip ? '　已自动跳过 ' + skip + ' 个附录类章节（版权 / 致谢 / 索引这类没有剧情，写了纯浪费）' : '');
    // 预算默认取「预估向上取整到分」，既不显得武断，也不会低于实际需要
    $('#genBudget').value = Math.max(0.01, Math.ceil((est.cost || 0) * 100) / 100);
    $('#genHint').textContent =
      '填个预算上限，花到就自动停，超出的章节不会开始。也可以先只写前面几章 —— ' +
      '真正的省钱办法是「只给正在读的那几章写笔记」，剩下的等读到了再说。';
    $('#genModal').classList.remove('hidden');
    setTimeout(() => $('#genBudget').focus(), 60);
  }

  function closeGenModal() {
    $('#genModal').classList.add('hidden');
  }

  function turn(dir) {
    if (!current) return;
    if (S.turnMode === 'pager' && current.pages.length > 1) {
      const next = current.pageIndex + dir;
      if (next >= 0 && next < current.pages.length) {
        current.pageIndex = next;
        renderPage();
        $('#readerBody').scrollTop = 0;
        return;
      }
    }
    goChapter(dir);
  }

  function goChapter(dir) {
    if (!current) return;
    const next = current.chapter + dir;
    if (next < 1 || next > (current.book.chapterCount || 1)) return;
    saveProgress();
    setHash('read', current.book.id, next);
    loadChapter(next);
  }

  async function loadServerSettings() {
    if (window.__NOOK_STATIC__) {
      // 静态版没有「服务器设置」这回事 —— 名字和副标题在 site.json 里，跟着仓库走
      const site = window.__NOOK_SITE__ || {};
      const n = site.names || {};
      $('#setPasscode').value = '（静态版改不了）';
      $('#setUserName').value = n.user || '';
      $('#setAiName').value = n.ai || '';
      $('#setSubtitle').value = site.subtitle || '';
      $('#setDeepseekKey').placeholder = '静态版用不到（本地版才有外部帮工）';
      ghTokenChanged();
      return;
    }
    try {
      const s = await api('/api/settings');
      $('#setPasscode').value = s.passcode || '';
      $('#setUserName').value = s.user_name || '';
      $('#setAiName').value = s.ai_name || '';
      $('#setSubtitle').value = s.subtitle || '';
      $('#setDeepseekKey').placeholder = s.hasDeepseekKey ? '已设置（留空则不改）' : '留空则关闭外部 API';
      if (s.deepseek_model) $('#setDeepseekModel').value = s.deepseek_model;
    } catch (e) { /* ignore */ }
  }

  async function saveServerSettings() {
    if (window.__NOOK_STATIC__) {
      toast('静态版改不了这些 —— 名字和副标题在仓库的 site.json 里');
      return;
    }
    const payload = {
      passcode: $('#setPasscode').value.trim(),
      user_name: $('#setUserName').value.trim(),
      ai_name: $('#setAiName').value.trim(),
      subtitle: $('#setSubtitle').value.trim(),
      deepseek_model: $('#setDeepseekModel').value
    };
    const dk = $('#setDeepseekKey').value.trim();
    if (dk) payload.deepseek_api_key = dk;
    try {
      await api('/api/settings', { method: 'POST', json: payload });
      toast('存好了');
    } catch (e) {
      toast('没存上：' + e.message);
    }
  }

  document.addEventListener('DOMContentLoaded', boot);
})();
