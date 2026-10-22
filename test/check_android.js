'use strict';
/**
 * 安卓长按路径的逻辑测试（不依赖真机）
 *
 * 关键：iPad(iOS) 和安卓是两套机制。
 *   iOS  长按 → 系统弹「复制/粘贴」气泡，-webkit-touch-callout:none 能关掉
 *   安卓 长按 → 系统弹**浮动工具条**（复制/分享/全选），
 *              -webkit-touch-callout 对它无效，只能靠 contextmenu preventDefault；
 *              而且它弹在选区**上方**，我们的工具条必须放**下方**才不被压住。
 *
 * 这里测的是安卓分支的三条规则：
 *   1) 平台判定：安卓 UA 认得出来，iPad 认不出来
 *   2) 策略：auto = 等系统选词（延后到 520ms）；self = 我们自己取词（380ms）
 *   3) 工具条位置：安卓固定放下方（避开系统工具条）
 */

const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');

function extract(name) {
  const m = new RegExp('(?:async\\s+)?function\\s+' + name + '\\s*\\([^)]*\\)\\s*\\{').exec(src);
  if (!m) { console.error('app.js 里找不到 ' + name); process.exit(1); }
  let i = m.index + m[0].length - 1, depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) break; }
  }
  return src.slice(m.index, i + 1);
}

let pass = 0, fail = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log('  PASS  ' + name + '  ->  ' + JSON.stringify(got)); }
  else { fail++; console.log('  FAIL  ' + name + '  ->  got ' + JSON.stringify(got) + ', want ' + JSON.stringify(want)); }
}

// ---- 1) 平台判定
// 注意：new Function(...) 返回的**就是**那个函数本身（IIFE 已经执行过了），
// 所以这里不能再调一次 —— 否则会把 navigator 当成它的参数传进去。
function makeIsAndroid(ua) {
  const f = new Function('navigator',
    'return (function () {\n' + extract('isAndroidLike') + '\nreturn isAndroidLike;\n})();');
  const fn = f({ userAgent: ua });
  return fn();          // ← 真正调用
}
const isAndroid = makeIsAndroid('Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36');
const isIPad = makeIsAndroid('Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1');
const isIPhone = makeIsAndroid('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1');
const isDesktop = makeIsAndroid('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36');

check('安卓 UA 认得出来', isAndroid, true);
check('iPad 不算安卓', isIPad, false);
check('iPhone 不算安卓', isIPhone, false);
check('桌面不算安卓', isDesktop, false);

// ---- 2) 策略
function makeStrategy(S) {
  const f = new Function('S',
    'return (function () {\n' + extract('lpStrategy') + '\nreturn lpStrategy;\n})();');
  return f(S)();
}
check('默认策略是 auto', makeStrategy({}), 'auto');
check('可以设成 self', makeStrategy({ lpStrategy: 'self' }), 'self');

// ---- 3) 工具条位置：安卓放下方，iPad 放不下时翻上去
function makePlace(isAndroidFlag) {
  // placeSelBar 里用了 isAndroidLike()，这里直接替换掉
  const body = extract('placeSelBar').replace('isAndroidLike()', JSON.stringify(isAndroidFlag));
  const bar = {
    className: '',
    style: {},
    offsetWidth: 160,
    offsetHeight: 44,
    classList: { remove() {}, add() {} }
  };
  const doc = { getElementById: () => bar };
  const $ = (sel) => (sel === '#selBar' ? bar : null);
  const win = { innerWidth: 400, innerHeight: 800 };
  const f = new Function('$', 'window', 'isAndroidLike', 'document',
    'return (function () {\n' + body + '\nreturn placeSelBar;\n})();');
  return { place: f($, win, isAndroidFlag, doc), bar };
}

{
  const { place, bar } = makePlace(true);
  // 选区在屏幕上半部分：安卓必须放在下方（rect.bottom + 10）
  place({ top: 100, bottom: 130, left: 100, width: 120 });
  check('安卓：工具条放选区下方', parseFloat(bar.style.top), 140);
}
{
  const { place, bar } = makePlace(false);
  place({ top: 100, bottom: 130, left: 100, width: 120 });
  check('非安卓：工具条也放下方（放不下才翻上）', parseFloat(bar.style.top), 140);
}
{
  // 选区贴着屏幕底部：下方放不下 → 翻到上面
  const { place, bar } = makePlace(true);
  place({ top: 700, bottom: 780, left: 100, width: 120 });
  check('安卓：下方放不下就翻到上面', parseFloat(bar.style.top), 700 - 44 - 10);
}
{
  // 横向夹在屏幕内
  const { place, bar } = makePlace(true);
  place({ top: 100, bottom: 130, left: 5, width: 20 });
  check('安卓：工具条左边不跑出屏幕', parseFloat(bar.style.left) >= 8, true);
  place({ top: 100, bottom: 130, left: 390, width: 20 });
  check('安卓：工具条右边不跑出屏幕', parseFloat(bar.style.left) <= 400 - 8, true);
}

console.log('');
console.log(fail ? 'ALL FAIL' : 'ALL PASS');
console.log(pass + ' checks');
process.exit(fail ? 1 : 0);
