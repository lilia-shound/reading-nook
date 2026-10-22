'use strict';
/* Validate app.css (and the per-theme stylesheets under public/themes/) against the contract */
const fs = require('fs');
const path = require('path');

const PUB = path.join(__dirname, '..', 'public');
function readCss(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch (e) { return ''; }
}

// 主样式 + themes/ 目录下每个主题文件，拼接后一起校验
const themeDir = path.join(PUB, 'themes');
const themeFiles = fs.existsSync(themeDir)
  ? fs.readdirSync(themeDir).filter((f) => f.endsWith('.css')).sort()
  : [];
const css = readCss(path.join(PUB, 'app.css')) + '\n' +
  themeFiles.map((f) => readCss(path.join(themeDir, f))).join('\n');

const CLASSES = ('app topbar topbar__title topbar__actions icon-btn icon-btn--on main hidden muted empty pill spinner toast toast--show ' +
'login login__card login__title login__input login__hint login__error login__btn ' +
'shelf shelf__hero shelf__title shelf__subtitle shelf__tools book-grid book-card book-card__cover book-card__title ' +
'book-card__meta book-card__actions book-card__progress progress-bar progress-bar__fill upload-drop upload-drop__hint ' +
'btn btn--primary btn--ghost btn--ai btn--sm btn--danger btn-row btn--block ' +
'reader reader__toolbar reader__back reader__title reader__body reader__content reader__footer reader__chapter-title ' +
'para hl hl--mine hl--ai para--hl-mine para--hl-ai reader__tap-left reader__tap-right ' +
'toc toc__head toc__list toc__item toc__item--active toc__close ' +
'sel-bar sel-bar__btn anno-panel anno-panel__head anno-list anno-item anno-item--replied anno-item__meta ' +
'anno-item__anchor anno-item__note bubble bubble--mine bubble--ai bubble__name bubble__text bubble__ts bubble__reply ' +
'modal modal__mask modal__box modal__head modal__title modal__close modal__body modal__foot ' +
'settings settings__group settings__title settings__row settings__label swatches swatch swatch--active swatch__chip ' +
'palette palette__dot palette__dot--active seg seg__item seg__item--active toggle toggle--on field field__input field__textarea ' +
'wb wb__stats stat stat__num stat__label wb__log log-row log-row--err log-row__task log-row__meta wb__notes note-card note-card__ch'
).split(/\s+/).filter(Boolean);

const THEMES = ['cream-dog', 'matcha', 'muxia', 'mono-sweet', 'french-blue', 'clay', 'neumorph', 'glass',
  'liquid-glass', 'skeuomorph', 'bauhaus',
  'material-design', 'neo-brutalism', 'acid-graphics', 'retrofuturism', 'anti-design',
  'brutalism', 'flat-design', 'minimalism'];
const VARS = ['--bg', '--bg-2', '--paper', '--ink', '--ink-soft', '--line', '--accent', '--hl-mine', '--hl-ai',
  '--bub-mine', '--bub-ai', '--text-color', '--radius', '--radius-sm', '--shadow', '--shadow-sm', '--font-serif', '--font-sans', '--deco'];

let missingClasses = [];
for (const c of CLASSES) {
  const re = new RegExp('\\.' + c.replace(/[-_]/g, '\\$&') + '(?![A-Za-z0-9_-])');
  if (!re.test(css)) missingClasses.push(c);
}

let missingThemes = [];
for (const t of THEMES) {
  if (!css.includes('[data-theme="' + t + '"]')) missingThemes.push(t);
}

let missingModes = 0;
for (const t of THEMES) {
  if (!css.includes('[data-theme="' + t + '"][data-mode="day"]') && !css.includes('[data-theme="' + t + '"]')) missingModes++;
}

// 每套主题的变量完整性：抓取该主题的规则块
let varProblems = [];
for (const t of THEMES) {
  const idx = css.indexOf('[data-theme="' + t + '"]');
  if (idx < 0) continue;
  const start = css.lastIndexOf('{', idx);
  const end = css.indexOf('}', idx);
  const block = css.slice(start, end);
  for (const v of VARS) {
    if (!block.includes(v + ':')) varProblems.push(t + ' 缺 ' + v);
  }
}

// 括号平衡
let depth = 0, minDepth = 0;
for (const ch of css) {
  if (ch === '{') depth++;
  if (ch === '}') { depth--; if (depth < minDepth) minDepth = depth; }
}
const balanced = depth === 0 && minDepth === 0;

// 媒体查询
const hasMobile = /@media\s*\(max-width:\s*768px\)/.test(css);
const hasReduced = /prefers-reduced-motion/.test(css);
const hasBackdrop = /backdrop-filter/.test(css);
const hasInset = /inset/.test(css);

console.log('文件大小: ' + css.length + ' 字符, ' + css.split('\n').length + ' 行');
console.log('类名: ' + (CLASSES.length - missingClasses.length) + '/' + CLASSES.length + ' 齐' +
  (missingClasses.length ? '  缺: ' + missingClasses.join(' ') : ''));
console.log('主题: ' + (THEMES.length - missingThemes.length) + '/' + THEMES.length + ' 齐' +
  (missingThemes.length ? '  缺: ' + missingThemes.join(' ') : ''));
console.log('变量缺失: ' + (varProblems.length ? varProblems.join('; ') : '无'));
console.log('花括号平衡: ' + (balanced ? 'OK' : '不平衡 depth=' + depth));
console.log('移动端断点: ' + (hasMobile ? '有' : '无'));
console.log('reduced-motion: ' + (hasReduced ? '有' : '无'));
console.log('backdrop-filter(玻璃): ' + (hasBackdrop ? '有' : '无'));
console.log('inset(新拟物): ' + (hasInset ? '有' : '无'));
const dayCount = (css.match(/\[data-mode="day"\]/g) || []).length;
const nightCount = (css.match(/\[data-mode="night"\]/g) || []).length;
console.log('day 规则块: ' + dayCount + ', night 规则块: ' + nightCount);
process.exit(missingClasses.length || missingThemes.length || varProblems.length || !balanced ? 1 : 0);
