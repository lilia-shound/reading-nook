/*!
 * gh-api.js —— 共读小屋 · 浏览器端 GitHub 存储适配器
 *
 * 静态版（GitHub Pages）里，app.js 的 api() 把请求转交给这里：
 *   window.GhApi.handle(path, opt)   → 返回解析好的 JSON
 *
 * 仓库是唯一事实来源，仓库里存的是密文：
 *   读 → raw.githubusercontent.com（免 token，CDN 快）
 *   写 → api.github.com 的 contents 接口（要 token）
 *
 * 三条铁律（跟 _reference/静态版架构.md 一致）：
 *   1. 加密只有一份实现 → public/vault.js（window.Vault），这里绝不复制第二份
 *   2. 密码不落盘 → 派生出来的 CryptoKey 只活在内存里，刷新页面就要重新输
 *   3. token 只进 localStorage['nook.gh.token']，不写进源码、不进仓库
 *
 * 返回值形状照抄 server.js 的 /api/*，前端不用改一行。
 */
(function (global) {
  'use strict';

  var TOKEN_KEY = 'nook.gh.token';
  var GH_API = 'https://api.github.com';
  var GH_RAW = 'https://raw.githubusercontent.com';
  var MAX_RETRY = 3;              // 409 重试上限
  var LIBRARY_PATH = 'data/library.json.enc';

  var S = {
    site: null,          // site.json（故意公开：盐不是秘密，密钥才是）
    sitePending: null,
    key: null,           // 派生出来的 CryptoKey —— 只在内存里
    pending: null,       // {sha, ts, items} —— /api/pending 和 /api/ping 共用
    cache: { gen: 0, files: {}, values: {} }
  };

  // ------------------------------------------------------------ 小工具

  function fail(msg, status) {
    var e = new Error(msg);
    e.status = status || 500;
    throw e;
  }

  function nowIso() {
    return new Date().toISOString();
  }

  function newId(prefix) {
    return prefix + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  function b64encode(str) {
    var s = String(str);
    try { return btoa(s); }
    catch (e) { return btoa(unescape(encodeURIComponent(s))); }
  }

  function b64decode(str) {
    var bin = atob(String(str).replace(/\s+/g, ''));
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder('utf-8').decode(bytes);
  }

  function vault() {
    if (!global.Vault) fail('加密模块没加载（vault.js 要排在 gh-api.js 前面）', 500);
    return global.Vault;
  }

  function needKey() {
    if (!S.key) fail('还没登录，先输密码', 401);
    return S.key;
  }

  // ------------------------------------------------------------ token

  function getToken() {
    if (S.token) return S.token;
    try { S.token = localStorage.getItem(TOKEN_KEY) || ''; }
    catch (e) { S.token = ''; }
    return S.token;
  }

  function setToken(t) {
    S.token = String(t || '').trim();
    try { localStorage.setItem(TOKEN_KEY, S.token); } catch (e) { /* ignore */ }
    return S.token;
  }

  function hasToken() {
    return !!getToken();
  }

  function requireToken() {
    var t = getToken();
    if (!t) fail('还没连上 GitHub：划线要先粘一次 GitHub token', 401);
    return t;
  }

  function logout() {
    S.token = '';
    try { localStorage.removeItem(TOKEN_KEY); } catch (e) { /* ignore */ }
    S.key = null;
    S.pending = null;
    S.cache = { gen: 0, files: {}, values: {} };
  }

  // ------------------------------------------------------------ site.json

  function loadSite(force) {
    if (S.site && !force) return Promise.resolve(S.site);
    if (S.sitePending && !force) return S.sitePending;
    // **优先用内联的那份**（public/site-inline.js，由 tools/gen-site.js 生成）。
    // 理由：site.json 放在 Pages 上，而 Pages 的 CDN 会抖 ——
    // 一抖就读不到配置，连登录框都出不来，整个站点就开不了门。
    // 内联之后，启动时一个网络请求都不用发。
    if (global.NOOK_SITE && global.NOOK_SITE.mode === 'static') {
      S.site = global.NOOK_SITE;
      return Promise.resolve(S.site);
    }
    // 相对路径 —— Pages 部署在 /reading-nook/ 子目录下，写 /site.json 会 404
    S.sitePending = fetch('site.json', { headers: { Accept: 'application/json' } })
      .then(function (res) {
        if (!res.ok) fail('读不到 site.json（' + res.status + '），静态版配置没放好', res.status);
        return res.json();
      })
      .then(function (site) {
        S.site = site;
        S.sitePending = null;
        return site;
      })
      .catch(function (e) {
        S.sitePending = null;
        if (e && e.status) throw e;
        fail('读不到 site.json，静态版配置没放好', 500);
      });
    return S.sitePending;
  }

  function siteInfo() {
    return loadSite().then(function (site) {
      if (!site || site.mode !== 'static') {
        fail('这个页面跑的不是静态版（mode=' + (site && site.mode) + '），静态适配器用不了', 400);
      }
      return site;
    });
  }

  function isStatic() {
    if (!S.site) return true;
    return S.site.mode === 'static';
  }

  // ------------------------------------------------------------ URL / HTTP

  function rawUrl(site, rel) {
    return GH_RAW + '/' + site.owner + '/' + site.repo + '/' + site.branch + '/' + rel;
  }

  function contentsUrl(site, rel, extra) {
    var u = GH_API + '/repos/' + site.owner + '/' + site.repo + '/contents/' + rel +
      '?ref=' + encodeURIComponent(site.branch);
    if (extra) u += '&' + extra;
    return u;
  }

  function commitsUrl(site, path) {
    var u = GH_API + '/repos/' + site.owner + '/' + site.repo + '/commits?per_page=1';
    if (path) u += '&path=' + encodeURIComponent(path);
    return u;
  }

  function rawFetch(url, init) {
    return fetch(url, init).then(function (res) {
      return res.text().then(function (text) {
        var json = null;
        try { json = text ? JSON.parse(text) : null; } catch (e) { json = null; }
        return { status: res.status, ok: res.ok, text: text, json: json };
      });
    }).catch(function (e) {
      // 网络层失败（连接被掐、CDN 抖了一下）——**不是 HTTP 状态码，是 promise 直接 reject**。
      // 这种最常见，所以要变成一个「可重试的响应」，走下面同一套重试 + 换路逻辑。
      return {
        status: 0,
        ok: false,
        text: '',
        json: null,
        networkError: String((e && e.message) || e)
      };
    });
  }

  // ------------------------------------------------------------ 重试
  // GitHub 的 CDN 和限流会**抖**一下：明明前一秒还好好的，突然给你一个 403/429/5xx。
  // 不重试的话，她就会遇到「刚才还好好的，怎么突然打不开书了」—— 而其实重试一次就好。

  // 404 不算「抖」—— 那是一个确定答案（文件不存在），重试只是白等。
  // CDN 同步延迟导致的「该在却不在」，上面有专门的兜底（换新鲜那条路再问一次）。
  // 0 = 网络层失败（fetch 直接 reject）—— 这个**最常见**，必须重试。
  var TRANSIENT = [0, 403, 429, 500, 502, 503, 504];

  function delay(ms) {
    return new Promise(function (r) { setTimeout(r, ms); });
  }

  /**
   * 只对「会抖」的失败重试；别的错误直接返回给上层处理。
   *
   * 网络层失败（status 0）值得**多等一会儿** —— 手机在弱网、地铁、电梯里
   * 可能只是慢，不是断。退避 0.8s / 1.6s / 2.4s，一轮下来差不多 5 秒。
   */
  function withRetry(fn, times) {
    var n = times || 4;
    return fn().then(function (res) {
      if (res && res.ok) return res;
      if (res && TRANSIENT.indexOf(res.status) >= 0 && n > 1) {
        var wait = res.status === 0 ? 800 * (4 - n) : 400 * (3 - n);
        return delay(wait).then(function () { return withRetry(fn, n - 1); });
      }
      return res;
    });
  }

  /**
   * 打 api.github.com。带上 token（有限流优惠），token 失效（401）就退回免 token 再试一次。
   * 注意：token 只发给 api.github.com，raw.githubusercontent.com 那条路绝不带。
   */
  function apiFetch(url, init) {
    var token = getToken();
    if (!token) return rawFetch(url, init);
    var base = init || {};
    var h = {};
    var k;
    var src = base.headers || {};
    for (k in src) if (Object.prototype.hasOwnProperty.call(src, k)) h[k] = src[k];
    h['Authorization'] = 'Bearer ' + token;
    return rawFetch(url, Object.assign({}, base, { headers: h })).then(function (res) {
      if (res.status !== 401) return res;
      var h2 = {};
      for (k in src) if (Object.prototype.hasOwnProperty.call(src, k)) h2[k] = src[k];
      delete h2['Authorization'];
      return rawFetch(url, Object.assign({}, base, { headers: h2 }));
    });
  }

  // ------------------------------------------------------------ 读

  /**
   * 读一个仓库文件（密文）。返回 null = 仓库里没有这个文件。
   * fresh = true → 走 api.github.com 那条路（刚写完要马上读到自己的东西时用，
   *              raw 那条有 CDN 缓存延迟，会读到旧数据）。
   */
  /** 403/429 在 GitHub 上九成是「访问额度用完了」—— 得给看得懂的话，不是干巴巴的 403 */
  function quotaFail(status, what) {
    if (status === 403 || status === 429) {
      fail('GitHub 的访问额度用完了（没连 token 的话，每个 IP 每小时只有 60 次）。'
        + '等几分钟就好；或者去「设置 → GitHub 连接」连上你的 token，额度就变成 5000 次/小时了。'
        + '（刚才要读的是 ' + what + '）', status);
    }
    fail('读仓库失败（' + status + '）：' + what, status);
  }

  function readText(site, rel, fresh) {
    var hit = S.cache.files[rel];
    if (hit && hit.gen === S.cache.gen) return Promise.resolve(hit.text);
    // 缓存里这份已经过期：仓库动过之后，宁可多发一个请求也要拿新鲜的
    var useFresh = !!fresh || !!hit || S.cache.gen > 0;
    var p;
    if (useFresh) {
      p = readFresh(site, rel);
    } else {
      p = withRetry(function () {
        return rawFetch(rawUrl(site, rel), { headers: { Accept: 'text/plain' } });
      }).then(function (res) {
        if (res.status === 404) {
          // 最近仓库动过 → 可能是 CDN 还没同步，走新鲜那条路再试一次
          if (S.cache.gen > 0) return readFresh(site, rel);
          return null;
        }
        if (!res.ok) {
          // raw 抖了（网络失败 / 限流 / 5xx）→ 换新鲜那条路再试一次
          if (TRANSIENT.indexOf(res.status) >= 0) return readFresh(site, rel);
          quotaFail(res.status, rel);
        }
        return res.text;
      });
    }
    return p.then(function (text) {
      S.cache.files[rel] = { text: text, sha: (hit && hit.sha) || null, gen: S.cache.gen };
      return text;
    });
  }

  function readFresh(site, rel) {
    return withRetry(function () {
      return apiFetch(contentsUrl(site, rel), { headers: { Accept: 'application/vnd.github.raw' } });
    }).then(function (res) {
        if (res.status === 404) return null;
        if (!res.ok) quotaFail(res.status, rel);
        return res.text;
      });
  }

  /**
   * 读一个文件的 sha + 内容（写之前要拿 sha）
   *
   * retry404：写文件之前，404 有可能是**假的**（网络抖了一下、CDN 没同步）。
   * 那种情况下拿到的 null 会让后面 PUT 不带 sha → GitHub 报
   * 「"sha" wasn't supplied.」（2026-10-22 姜来踩的就是这个）。
   * 所以写之前宁可多问一次。
   */
  function readMeta(site, rel, retry404) {
    return withRetry(function () {
      return apiFetch(contentsUrl(site, rel), { headers: { Accept: 'application/vnd.github+json' } });
    }).then(function (res) {
        if (res.status === 404) {
          if (retry404) {
            // 再问一次 —— 第一次的 404 可能是网络抖出来的
            return readMeta(site, rel, false);
          }
          return null;
        }
        if (!res.ok) quotaFail(res.status, rel);
        var meta = res.json || {};
        var text = null;
        if (meta.content && meta.encoding === 'base64') {
          try { text = b64decode(meta.content); } catch (e) { text = null; }
        }
        if (text === null) {
          // 大文件（>1MB）contents 接口不给内容，走 raw 那条
          return rawFetch(rawUrl(site, rel), { headers: { Accept: 'text/plain' } }).then(function (r) {
            if (r.status === 404) return null;
            if (!r.ok) fail('读仓库失败（' + r.status + '）：' + rel, r.status);
            return { sha: meta.sha || null, text: r.text };
          });
        }
        return { sha: meta.sha || null, text: text };
      });
  }

  /** 列目录：返回 [{name, type, size, sha}]，目录不存在 → [] */
  function listDir(site, dir) {
    return withRetry(function () {
      return apiFetch(contentsUrl(site, dir), { headers: { Accept: 'application/vnd.github+json' } });
    }).then(function (res) {
        if (res.status === 404) return [];
        if (!res.ok) quotaFail(res.status, dir);
        return Array.isArray(res.json) ? res.json : [];
      });
  }

  /**
   * 第三条路：写不进去时，**改走她自己的电脑代写**。
   *
   * 为什么需要：写仓库必须打 api.github.com（要拿 sha），
   * 而**手机在 5G 上经常连不上 api.github.com**（raw 倒通常通）。
   * 那台电脑的网络是好的 —— 所以让那台电脑替我们写。
   *
   * 隧道地址放在仓库的 data/tunnel.json（加密）里，
   * 由她电脑上的隧道守护进程在地址变化时自动更新。
   *
   * @returns {Promise<Object|null>} 成功返回隧道的响应；走不通返回 null
   */
  async function tryTunnel(site, apiPath, method, payload) {
    try {
      const enc = await readText(site, 'data/tunnel.json.enc', true);
      if (!enc) return null;
      const t = JSON.parse(await vault().decryptText(needKey(), enc));
      if (!t || !t.url) return null;
      const res = await fetch(t.url + apiPath, {
        method: method || 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Cookie': 'rk=' + (S.passcode || '')
        },
        body: JSON.stringify(payload || {})
      });
      const text = await res.text();
      if (!res.ok) return null;
      try { return JSON.parse(text); } catch (e) { return null; }
    } catch (e) {
      // 走不通不是灾难（还有第三条路 / 有更清楚的提示），但要留个痕迹
      if (typeof console !== 'undefined' && console.warn) {
        console.warn('[nook] 改走家里电脑这条路没通：', (e && e.message) || e);
      }
      return null;
    }
  }

  /** 两条路都不通 —— 给人话 */
  function writeFailBoth(err) {
    fail('写不进仓库：GitHub 现在连不上（可能是你当前网络的问题），'
      + '家里电脑那条路也没通。\n'
      + '· 连着家里的 Wi-Fi 时，用电脑上的那版划线最稳\n'
      + '· 或者换个网络再试一次\n'
      + '（' + ((err && err.message) || '不知道怎么了') + '）', 503);
  }

  // ------------------------------------------------------------ 写

  function putFile(site, rel, encText, message, sha) {
    requireToken();
    var body = { message: message, content: b64encode(encText), branch: site.branch };
    if (sha) body.sha = sha;
    return apiFetch(contentsUrl(site, rel), {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/vnd.github+json',
        'User-Agent': 'reading-nook'
      },
      body: JSON.stringify(body)
    }).then(function (res) {
      if (res.ok) {
        var c = res.json && res.json.content ? res.json.content : null;
        return { ok: true, sha: c ? c.sha : null };
      }
      return { ok: false, status: res.status, message: (res.json && res.json.message) || '' };
    });
  }

  /**
   * 密文信封上补一个 mtime（毫秒时间戳）。
   *
   * 加密本身还是 vault.js 那一份（这里只是往信封上加一个字段），
   * 跟 Node 端一个口径：lib/ghbackend.js、tools/push-repo.js 也是这么写的。
   * 两台设备靠它判断「谁更新」—— 没有这个字段，浏览器写的和命令行写的就没法比。
   */
  function stampEnvelope(blob) {
    try {
      var o = JSON.parse(String(blob));
      if (o && typeof o === 'object' && !Array.isArray(o)) {
        o.mtime = Date.now();
        return JSON.stringify(o);
      }
    } catch (e) { /* 不是信封就原样返回 */ }
    return String(blob);
  }

  /**
   * 读 → 合并 → 加密 → 写。
   *
   * 三道保险（都是被真实事故逼出来的）：
   *  1. **409**（有人同时改了）→ 重读、重合并、再写，最多 3 次
   *  2. **422 "sha wasn't supplied"** → 说明「文件其实存在，但我们这次没拿到 sha」
   *     （比如那次 GET 恰好抖了一下返回了 404）→ **专门再去要一次 sha**，再写
   *  3. **写之前本地自检**：把刚加密的东西立刻解回来，对不上就当场拦住 ——
   *     宁可报错，也别把文件写坏（2026-10-22 就出过一回密文被套了两层 JSON 的事故）
   *
   * mergeFn(current) 返回要写进去的新值；defaultValue 是「文件本来就不存在」时的底。
   * 写成功后本地缓存立刻更新 —— 她马上就能看见自己划的线，不用等服务器。
   */
  function writeJson(site, rel, message, mergeFn, defaultValue) {
    requireToken();
    var key = needKey();
    var attempt = 0;

    function round() {
      attempt++;
      var sha = null;
      // 写之前多问一次：404 有可能是网络抖出来的（那次 422 就是这么来的）
      return readMeta(site, rel, true).then(function (cur) {
        if (!cur || !cur.text) return defaultValue;
        sha = cur.sha;
        return Promise.resolve(vault().decryptJson(key, cur.text)).then(function (v) {
          return v;
        }, function () {
          return defaultValue;      // 密文坏了 → 当成空文件重写
        });
      }).then(function (current) {
        var next = mergeFn ? mergeFn(current) : current;
        return Promise.resolve(vault().encryptJson(key, next)).then(function (enc) {
          var blob = stampEnvelope(enc);
          // 写之前本地自检：刚加密的东西立刻解回来，对不上就说明要写出去的是坏的
          return Promise.resolve(vault().decryptJson(key, blob)).then(function (back) {
            if (JSON.stringify(back) !== JSON.stringify(next)) {
              fail('写之前自检没过（加密后的东西解回来对不上），已经拦住，没写出去', 500);
            }
            return putFile(site, rel, blob, message, sha).then(function (res) {
              if (res.ok) {
                S.cache.files[rel] = { text: blob, sha: res.sha, gen: S.cache.gen };
                S.cache.values[rel] = { value: next, gen: S.cache.gen };
                return { ok: true, value: next };
              }
              if (res.status === 409 && attempt < MAX_RETRY) return round();   // 重读重合并再写
              if (res.status === 409) {
                fail('写不进去：仓库里的文件同时被人改了，试了 ' + MAX_RETRY + ' 次都没写上，再试一次', 409);
              }
              // 422 "sha wasn't supplied" → 文件其实在，只是这次没拿到 sha。
              // **重读 + 重合并 + 重写**（不能拿同一个 blob 再写一遍 ——
              // 那会把她原来那条批注弄丢，因为她那份是拿 defaultValue 算出来的）。
              if (res.status === 422 && /sha/i.test(res.message || '') && attempt < MAX_RETRY) {
                return round();
              }
              fail('写不进去：' + (res.message || ('HTTP ' + res.status)), res.status || 500);
              return null;
            });
          });
        });
      });
    }

    return round().then(function (r) { return r && r.value; });
  }

  // ------------------------------------------------------------ 解密

  function decryptJson(site, rel, text) {
    return Promise.resolve().then(function () {
      var key = needKey();
      return Promise.resolve(vault().decryptJson(key, text)).then(function (v) {
        return v;
      }, function () {
        fail('解不开这段密文（密码不对？）：' + rel, 500);
      });
    });
  }

  function decryptText(site, rel, text) {
    return Promise.resolve().then(function () {
      var key = needKey();
      return Promise.resolve(vault().decryptText(key, text)).then(function (v) {
        return v;
      }, function () {
        fail('解不开这段密文（密码不对？）：' + rel, 500);
      });
    });
  }

  // ------------------------------------------------------------ 书架 / 书

  function getLibrary(site) {
    var hit = S.cache.values[LIBRARY_PATH];
    if (hit && hit.gen === S.cache.gen) return Promise.resolve(hit.value);
    return readText(site, LIBRARY_PATH, false).then(function (text) {
      if (text == null) fail('仓库里没有书架文件（' + LIBRARY_PATH + '）', 404);
      return decryptJson(site, LIBRARY_PATH, text).then(function (value) {
        if (!Array.isArray(value)) value = [];
        S.cache.values[LIBRARY_PATH] = { value: value, gen: S.cache.gen };
        return value;
      });
    });
  }

  function getBook(site, bookId) {
    return getLibrary(site).then(function (lib) {
      for (var i = 0; i < lib.length; i++) if (lib[i].id === bookId) return lib[i];
      return null;
    });
  }

  function getBookText(site, bookId) {
    var rel = 'data/books/' + bookId + '/text.txt.enc';
    return readText(site, rel, false).then(function (text) {
      if (text == null) fail('这本书的正文取不到（' + rel + '）', 404);
      return decryptText(site, rel, text);
    });
  }

  function getProgress(site, bookId) {
    var rel = 'data/books/' + bookId + '/progress.json.enc';
    return readText(site, rel, false).then(function (text) {
      if (text == null) return null;
      return decryptJson(site, rel, text).then(function (v) {
        return (v && typeof v === 'object') ? v : null;
      }, function () { return null; });
    });
  }

  function readAnnotations(site, bookId, chapter) {
    var rel = 'data/books/' + bookId + '/annotations/' + chapter + '.json.enc';
    return readText(site, rel, false).then(function (text) {
      if (text == null) return [];
      return decryptJson(site, rel, text).then(function (v) {
        return Array.isArray(v) ? v : [];
      }, function () { return []; });
    });
  }

  // ------------------------------------------------------------ 切段（照抄 server.js）

  /**
   * 和 server.js 的 splitParagraphs 一模一样：
   * 逐行 → 去掉行尾空白 → 空行跳过 → 超长行按句末标点切，每段上限 320 字。
   *
   * 唯一区别：server.js 用 /(?<=[。！？…；])/ 切句，
   * 这里改成手写的等价切法 —— lookbehind 在老 Safari 上是语法错误，
   * 一个字符写错整个文件就加载不了。行为由 test/check_ghapi.js 逐字比对保证一致。
   */
  function splitParagraphs(text) {
    var lines = String(text || '').split(/\r?\n/);
    var paras = [];
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i].replace(/[ \t　]+$/g, '').trim();
      if (!line) continue;
      if (line.length > 500) {
        // 超长行按句末标点切，避免一页塞爆
        var pieces = splitBySentenceEnd(line);
        var buf = '';
        for (var j = 0; j < pieces.length; j++) {
          var p = pieces[j];
          if ((buf + p).length > 320 && buf) {
            paras.push(buf);
            buf = '';
          }
          buf += p;
        }
        if (buf) paras.push(buf);
      } else {
        paras.push(line);
      }
    }
    return paras;
  }

  /** 等价于 line.split(/(?<=[。！？…；])/) */
  function splitBySentenceEnd(line) {
    var pieces = [];
    var buf = '';
    for (var i = 0; i < line.length; i++) {
      var ch = line.charAt(i);
      buf += ch;
      if (ch === '。' || ch === '！' || ch === '？' || ch === '…' || ch === '；') {
        pieces.push(buf);
        buf = '';
      }
    }
    if (buf) pieces.push(buf);
    return pieces;
  }

  // ------------------------------------------------------------ 剧情章判断

  // 抄自 lib/deepseek.js 的 isNarrativeChapter —— 只为让 pendingNotes / skippedNotes
  // 和本地版算出来的一样（版权页、目录、索引这类章不算剧情章）
  var NON_NARRATIVE_RE = new RegExp(
    '^(' + [
      '版权信息', '版权页', '版权声明', '献词', '致谢', '鸣谢', '格言',
      '目录', '索引', '索引表', '译名对照表', '译名翻译对照表', '译名表', '地名翻译对照表',
      '勘误', '勘误表', '声明', '书名页', '扉页', '年表', '出版信息', '出版说明',
      '内容简介', '书介', '推荐语', '插图目录', '图片说明', '地图集'
    ].join('|') + ')(\\s*[（(][^）)]*[）)])?$'
  );

  function isNarrativeChapter(title) {
    var t = String(title || '').trim();
    if (!t) return true;
    return !NON_NARRATIVE_RE.test(t);
  }

  // ------------------------------------------------------------ 资料库

  function parseFrontMatter(text) {
    var meta = {};
    var m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
    if (!m) return { meta: meta, body: text };
    m[1].split(/\r?\n/).forEach(function (line) {
      var kv = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line.trim());
      if (!kv) return;
      var v = kv[2].trim();
      if (v.startsWith('[') && v.endsWith(']')) {
        v = v.slice(1, -1).split(',').map(function (x) {
          return x.trim().replace(/^["']|["']$/g, '');
        }).filter(Boolean);
      } else {
        v = v.replace(/^["']|["']$/g, '');
      }
      meta[kv[1]] = v;
    });
    return { meta: meta, body: text.slice(m[0].length) };
  }

  function docUpdatedAt(site, path) {
    return apiFetch(commitsUrl(site, path), { headers: { Accept: 'application/vnd.github+json' } })
      .then(function (res) {
        if (!res.ok || !Array.isArray(res.json) || !res.json.length) return null;
        var c = res.json[0];
        var d = (c.commit && c.commit.committer && c.commit.committer.date) ||
          (c.commit && c.commit.author && c.commit.author.date) || '';
        return d || null;
      }, function () { return null; });
  }

  // ------------------------------------------------------------ 待回批注

  function latestCommit(site) {
    return apiFetch(commitsUrl(site), { headers: { Accept: 'application/vnd.github+json' } })
      .then(function (res) {
        if (!res.ok) fail('连不上仓库（' + res.status + '）', res.status);
        var list = res.json;
        if (!Array.isArray(list) || !list.length) return { sha: '', ts: 0 };
        var c = list[0];
        var date = (c.commit && c.commit.committer && c.commit.committer.date) ||
          (c.commit && c.commit.author && c.commit.author.date) || '';
        return { sha: c.sha || '', ts: date ? Date.parse(date) : 0 };
      });
  }

  /**
   * /api/pending 和 /api/ping 共用这一份结果：
   * 一轮轮询只发 1 个请求（commits?per_page=1），sha 没变就直接用缓存。
   */
  function pendingState(site) {
    return latestCommit(site).then(function (commit) {
      if (S.pending && S.pending.sha === commit.sha) return S.pending;
      S.cache.gen++;                       // 仓库动过了 → 缓存里的都过期了
      return computePending(site).then(function (items) {
        S.pending = { sha: commit.sha, ts: commit.ts, items: items };
        return S.pending;
      });
    });
  }

  function computePending(site) {
    var items = [];
    return getLibrary(site).then(function (lib) {
      return listDir(site, 'data/books').then(function (dirs) {
        var chain = Promise.resolve();
        dirs.forEach(function (d) {
          if (d.type !== 'dir') return;
          chain = chain.then(function () {
            var book = null;
            for (var i = 0; i < lib.length; i++) if (lib[i].id === d.name) book = lib[i];
            return listDir(site, 'data/books/' + d.name + '/annotations').then(function (files) {
              var chain2 = Promise.resolve();
              files.forEach(function (f) {
                if (f.type !== 'file') return;
                var m = /^(.+)\.json\.enc$/.exec(f.name);
                if (!m) return;
                var chapter = Number(m[1]);
                if (!isFinite(chapter)) return;
                chain2 = chain2.then(function () {
                  return readAnnotations(site, d.name, chapter).then(function (list) {
                    var meta = null;
                    if (book && book.chapters) {
                      for (var j = 0; j < book.chapters.length; j++) {
                        if (book.chapters[j].index === chapter) meta = book.chapters[j];
                      }
                    }
                    list.forEach(function (a) {
                      if (a.who !== 'user') return;
                      if (a.replies && a.replies.length) return;
                      items.push({
                        bookId: d.name,
                        bookTitle: book ? book.title : d.name,
                        chapter: chapter,
                        chapterTitle: meta ? meta.title : ('第 ' + chapter + ' 章'),
                        annotationId: a.id,
                        anchor: a.anchor,
                        note: a.note,
                        ts: a.ts
                      });
                    });
                  });
                });
              });
              return chain2;
            });
          });
        });
        return chain.then(function () {
          items.sort(function (x, y) { return String(x.ts).localeCompare(String(y.ts)); });
          return items;
        });
      });
    });
  }

  // ------------------------------------------------------------ 登录

  function login(site, body) {
    var passcode = String((body && body.passcode) || '').trim();
    if (!passcode) fail('密码不能为空', 400);
    return Promise.resolve().then(function () {
      return vault().deriveKey(passcode, site.kdf.salt, site.kdf.iter);
    }).then(function (key) {
      // 密码只活在内存里（不落盘、不进 localStorage）。
      // 留着它是为了「走家里电脑代写」那条兜底路 —— 隧道那边的 cookie 就是密码。
      S.passcode = passcode;
      // 解密书架 → 成功才算密码对（这是唯一的判据，比比哈希可靠）
      return readText(site, LIBRARY_PATH, true).then(function (enc) {
        if (enc == null) fail('仓库里没有书架文件（' + LIBRARY_PATH + '），先让姜去推一次', 404);
        return Promise.resolve(vault().decryptJson(key, enc)).then(function () {
          S.key = key;
          S.cache.values = {};      // 换密码了，解出来的缓存全部作废
          return {
            ok: true,
            user_name: (site.names && site.names.user) || '姜来',
            ai_name: (site.names && site.names.ai) || '姜去',
            subtitle: site.subtitle || '',
            login_hint: site.login_hint || ''
          };
        }, function () {
          fail('密码不对，再想想', 401);
        });
      });
    });
  }

  // ------------------------------------------------------------ 书架摘要

  function bookSummary(b, p) {
    var notes = b.notes || {};
    var noteCount = Object.keys(notes).length;
    var chapters = b.chapters || [];
    var allPending = chapters.filter(function (m) { return !notes[String(m.index)]; });
    var pendingMetas = allPending.filter(function (m) { return isNarrativeChapter(m.title); });
    return {
      id: b.id,
      title: b.title,
      filename: b.filename,
      addedAt: b.addedAt,
      encoding: b.encoding,
      chapterCount: b.chapterCount,
      pattern: b.pattern,
      hasNotes: !!noteCount,
      noteCount: noteCount,
      pendingNotes: pendingMetas.length,
      skippedNotes: allPending.length - pendingMetas.length,
      // 静态版算不出花费（那是本地版按 DeepSeek 价目表算的）→ 填 0
      noteEstimate: { chapters: 0, cost: 0, peak: false },
      progress: p ? { chapter: p.chapter, ratio: p.ratio || 0, updatedAt: p.updatedAt } : null
    };
  }

  // ------------------------------------------------------------ 支持的格式

  var FORMATS = [
    { ext: 'txt', label: 'TXT 文本', ok: true, note: '支持 UTF-8 / GBK / GB18030 / UTF-16' },
    { ext: 'epub', label: 'EPUB 电子书', ok: true, note: '按目录（spine）分章，章节标题取自目录' },
    { ext: 'docx', label: 'DOCX 文档', ok: true, note: '按「标题 1」样式分章' },
    { ext: 'fb2', label: 'FB2 书稿', ok: true, note: '每个 section 一章' },
    {
      ext: 'mobi', label: 'MOBI / AZW3', ok: false,
      note: '用 Calibre 打开它另存为 EPUB（或导出 TXT）再传进来，一步的事'
    },
    {
      ext: 'pdf', label: 'PDF', ok: false,
      note: 'PDF 里是排版后的字，抽出来容易乱，先转成 TXT 或 EPUB'
    }
  ];

  // ------------------------------------------------------------ 删目录

  function deleteTree(site, rel) {
    return apiFetch(contentsUrl(site, rel), { headers: { Accept: 'application/vnd.github+json' } })
      .then(function (res) {
        if (res.status === 404) return null;
        if (!res.ok) fail('删文件失败（' + res.status + '）：' + rel, res.status);
        var items = res.json;
        if (!Array.isArray(items)) {
          return apiFetch(contentsUrl(site, rel, 'message=' + encodeURIComponent('删除文件')), {
            method: 'DELETE',
            headers: { Accept: 'application/vnd.github+json' }
          }).then(function (d) {
            if (!d.ok && d.status !== 404) fail('删文件失败（' + d.status + '）：' + rel, d.status);
            return null;
          });
        }
        var chain = Promise.resolve();
        items.forEach(function (it) {
          chain = chain.then(function () {
            var child = rel + '/' + it.name;
            if (it.type === 'dir') return deleteTree(site, child);
            return apiFetch(contentsUrl(site, child, 'message=' + encodeURIComponent('删除文件')), {
              method: 'DELETE',
              headers: { Accept: 'application/vnd.github+json' }
            }).then(function (d) {
              if (!d.ok && d.status !== 404) fail('删文件失败（' + d.status + '）：' + child, d.status);
              return null;
            });
          });
        });
        return chain;
      });
  }

  // ------------------------------------------------------------ 路由

  async function handle(path, opt) {
    opt = opt || {};
    var method = String(opt.method || 'GET').toUpperCase();
    var body = (opt.json !== undefined && opt.json !== null) ? opt.json : {};

    var site = await siteInfo();

    // ---------------------------------------------- 静态版不支持的

    if (path === '/api/books' && method === 'POST') {
      fail('静态版不能上传图书，回电脑上用本地版上传', 501);
    }
    if (path === '/api/ai/auto') {
      fail('静态版不能自动回批注 —— 姜去直接写仓库', 501);
    }
    if (path === '/api/ai/reply') {
      fail('静态版不能在这里回批注 —— 姜去直接写仓库', 501);
    }
    if (path === '/api/ai/endpoint') {
      fail('静态版没有 AI 接口配置', 501);
    }
    if (path === '/api/tasks/notes') {
      fail('静态版不能生成剧情笔记 —— 姜去那边生成', 501);
    }
    if (path === '/api/workbench') {
      fail('静态版没有工作台', 501);
    }
    if (/^\/api\/books\/[^/]+\/resplit$/.test(path)) {
      fail('静态版不能重新拆章', 501);
    }

    // ---------------------------------------------- 免登录的

    if (path === '/api/health') {
      return { ok: true, time: nowIso(), login_hint: site.login_hint || '' };
    }

    if (path === '/api/login') {
      if (method !== 'POST') fail('登录只接受 POST', 405);
      return login(site, body);
    }

    if (path === '/api/formats') {
      return { formats: FORMATS.map(function (f) { return Object.assign({}, f); }) };
    }

    if (path === '/api/settings') {
      // 静态版的设置全在前端 localStorage，服务端这份不用
      return {};
    }

    // ---------------------------------------------- 书架

    if (path === '/api/library') {
      var lib = await getLibrary(site);
      var books = [];
      for (var i = 0; i < lib.length; i++) {
        var p = await getProgress(site, lib[i].id);
        books.push(bookSummary(lib[i], p));
      }
      return {
        books: books,
        user_name: (site.names && site.names.user) || '姜来',
        ai_name: (site.names && site.names.ai) || '姜去'
      };
    }

    var bookMatch = path.match(/^\/api\/books\/([^/]+)$/);
    if (bookMatch) {
      var bookId = decodeURIComponent(bookMatch[1]);
      var book = await getBook(site, bookId);
      if (!book) fail('book not found', 404);
      if (method === 'GET') return { book: book };
      if (method === 'DELETE') {
        requireToken();
        await writeJson(site, LIBRARY_PATH, '删书：' + book.title, function (current) {
          return (Array.isArray(current) ? current : []).filter(function (x) { return x.id !== bookId; });
        }, []);
        await deleteTree(site, 'data/books/' + bookId);
        return { ok: true };
      }
      fail('这个接口只接受 GET 或 DELETE', 405);
    }

    // ---------------------------------------------- 章节

    var chMatch = path.match(/^\/api\/books\/([^/]+)\/chapter\/(\d+)$/);
    if (chMatch) {
      var cid = decodeURIComponent(chMatch[1]);
      var chapter = Number(chMatch[2]);
      var bk = await getBook(site, cid);
      if (!bk) fail('book not found', 404);
      var meta = null;
      var chapters = bk.chapters || [];
      for (var ci = 0; ci < chapters.length; ci++) if (chapters[ci].index === chapter) meta = chapters[ci];
      if (!meta) fail('chapter not found', 404);
      var text = await getBookText(site, bk.id);
      var lines = text.split(/\r?\n/);
      var chapterBody = lines.slice(meta.startLine, meta.endLine + 1).join('\n');
      return {
        index: chapter,
        title: meta.title,
        paragraphs: splitParagraphs(chapterBody),
        totalChapters: bk.chapterCount
      };
    }

    // ---------------------------------------------- 批注

    var annoMatch = path.match(/^\/api\/books\/([^/]+)\/annotations\/(\d+)$/);
    if (annoMatch) {
      var aid = decodeURIComponent(annoMatch[1]);
      var ach = Number(annoMatch[2]);
      var abk = await getBook(site, aid);
      if (!abk) fail('book not found', 404);
      if (method === 'GET') {
        var list = await readAnnotations(site, aid, ach);
        return { annotations: list };
      }
      if (method === 'POST') {
        var payload = body || {};
        if (!payload.anchor && !payload.note) fail('没东西可存：划线和批注都是空的', 400);
        var item = {
          id: newId('a'),
          anchor: String(payload.anchor || ''),
          note: String(payload.note || ''),
          who: 'user',
          paraIndex: Number.isFinite(Number(payload.paraIndex)) ? Number(payload.paraIndex) : -1,
          ts: nowIso(),
          replies: []
        };
        try {
          var merged = await writeJson(site, 'data/books/' + aid + '/annotations/' + ach + '.json.enc',
            '划线：' + (abk.title || aid) + ' 第 ' + ach + ' 章', function (current) {
              var list2 = Array.isArray(current) ? current.slice() : [];
              list2.push(item);
              return list2;
            }, []);
          return { annotation: merged[merged.length - 1] };
        } catch (e) {
          // 写不进仓库 → 可能是她当前网络连不上 GitHub → 改走家里电脑代写
          var via = await tryTunnel(site, '/api/books/' + aid + '/annotations/' + ach, 'POST', payload);
          if (via && via.annotation) return via;
          writeFailBoth(e);
        }
      }
      fail('这个接口只接受 GET 或 POST', 405);
    }

    // ---------------------------------------------- 阅读进度

    var progMatch = path.match(/^\/api\/books\/([^/]+)\/progress$/);
    if (progMatch) {
      var pid = decodeURIComponent(progMatch[1]);
      var pbk = await getBook(site, pid);
      if (!pbk) fail('book not found', 404);
      if (method === 'GET') {
        var pr = await getProgress(site, pid);
        return { progress: pr };
      }
      if (method === 'POST') {
        var patch = body || {};
        try {
          var next = await writeJson(site, 'data/books/' + pid + '/progress.json.enc',
            '阅读进度：' + (pbk.title || pid), function (current) {
              var cur = (current && typeof current === 'object' && !Array.isArray(current))
                ? current : { chapter: 1, paraIndex: 0, ratio: 0 };
              var out = Object.assign({}, cur, patch);
              out.updatedAt = nowIso();
              return out;
            }, { chapter: 1, paraIndex: 0, ratio: 0 });
          return { progress: next };
        } catch (e) {
          // 同划线：GitHub 连不上 → 改走家里电脑代写
          var via2 = await tryTunnel(site, '/api/books/' + pid + '/progress', 'POST', patch);
          if (via2 && via2.progress) return via2;
          writeFailBoth(e);
        }
      }
      fail('这个接口只接受 GET 或 POST', 405);
    }

    // ---------------------------------------------- 剧情笔记

    var noteMatch = path.match(/^\/api\/books\/([^/]+)\/notes\/(\d+)$/);
    if (noteMatch) {
      var nid = decodeURIComponent(noteMatch[1]);
      var nch = Number(noteMatch[2]);
      var nbk = await getBook(site, nid);
      if (!nbk) fail('book not found', 404);
      var nrel = 'data/books/' + nid + '/notes/' + nch + '.md.enc';
      var ntext = await readText(site, nrel, false);
      if (ntext == null) fail('note not found', 404);
      var nraw = await decryptText(site, nrel, ntext);
      var nout = nraw.replace(/^# .*\n+/, '').trim();
      if (!nout) fail('note not found', 404);
      var nmeta = null;
      var nchs = nbk.chapters || [];
      for (var ni = 0; ni < nchs.length; ni++) if (nchs[ni].index === nch) nmeta = nchs[ni];
      return { chapter: nch, title: nmeta ? nmeta.title : '', text: nout };
    }

    // ---------------------------------------------- 资料库

    if (path === '/api/docs') {
      var items = await listDir(site, 'data/docs');
      var docs = [];
      for (var di = 0; di < items.length; di++) {
        var it = items[di];
        if (it.type !== 'file') continue;
        var dm = /^(.+)\.md\.enc$/.exec(it.name);
        if (!dm) continue;
        var drel = 'data/docs/' + it.name;
        var dtext = await readText(site, drel, false);
        if (dtext == null) continue;
        var draw = await decryptText(site, drel, dtext);
        var fm = parseFrontMatter(draw);
        docs.push({
          id: dm[1],
          file: dm[1] + '.md',
          title: fm.meta.title || dm[1],
          summary: fm.meta.summary || '',
          tags: Array.isArray(fm.meta.tags) ? fm.meta.tags : (fm.meta.tags ? [fm.meta.tags] : []),
          chars: fm.body.length,
          updatedAt: await docUpdatedAt(site, drel)
        });
      }
      docs.sort(function (a, b) { return String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')); });
      return { docs: docs };
    }

    if (path.indexOf('/api/docs/') === 0) {
      var did = decodeURIComponent(path.slice('/api/docs/'.length)).replace(/[^A-Za-z0-9._-]/g, '');
      var drel2 = 'data/docs/' + did + '.md.enc';
      var dtext2 = await readText(site, drel2, false);
      if (dtext2 == null) fail('doc not found: ' + did, 404);
      var draw2 = await decryptText(site, drel2, dtext2);
      var fm2 = parseFrontMatter(draw2);
      var bodyText = fm2.body.trim();
      return {
        id: did,
        title: fm2.meta.title || did,
        summary: fm2.meta.summary || '',
        tags: Array.isArray(fm2.meta.tags) ? fm2.meta.tags : (fm2.meta.tags ? [fm2.meta.tags] : []),
        body: bodyText,
        text: bodyText,          // 契约里写的是 text，本地版给的是 body，两个都给
        chars: fm2.body.length
      };
    }

    // ---------------------------------------------- 待回 / 动静

    if (path === '/api/pending') {
      var st = await pendingState(site);
      return { items: st.items.map(function (x) { return Object.assign({}, x); }) };
    }

    if (path === '/api/ping') {
      var st2 = await pendingState(site);
      return { ts: st2.ts, pending: st2.items.length };
    }

    fail('no such api: ' + path, 404);
  }

  // ------------------------------------------------------------ 出口

  global.GhApi = {
    handle: handle,
    login: function (passcode) {
      return siteInfo().then(function (site) {
        return login(site, { passcode: passcode });
      });
    },
    logout: logout,
    hasToken: hasToken,
    setToken: setToken,
    getToken: getToken,
    isStatic: isStatic,
    splitParagraphs: splitParagraphs
  };
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
