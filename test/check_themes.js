'use strict';
// 逐主题自查：变量齐全性 / 外部资源 / 花括号平衡
const fs = require('fs');
const path = require('path');

const VARS = ['--bg', '--bg-2', '--paper', '--ink', '--ink-soft', '--line', '--accent',
  '--hl-mine', '--hl-ai', '--bub-mine', '--bub-ai', '--text-color',
  '--radius', '--radius-sm', '--shadow', '--shadow-sm',
  '--font-serif', '--font-sans', '--deco'];

const dir = path.join(__dirname, '..', 'public', 'themes');
const files = fs.readdirSync(dir).filter(f => f.endsWith('.css')).sort();
let bad = 0;

for (const f of files) {
  const s = fs.readFileSync(path.join(dir, f), 'utf8');
  const slug = f.replace(/\.css$/, '');
  const issues = [];

  for (const mode of ['day', 'night']) {
    const key = 'data-theme="' + slug + '"][data-mode="' + mode + '"';
    const idx = s.indexOf(key);
    if (idx < 0) { issues.push('缺 ' + mode + ' 块'); continue; }
    const end = s.indexOf('}', idx);
    const block = s.slice(idx, end);
    const miss = VARS.filter(v => !block.includes(v + ':'));
    if (miss.length) issues.push(mode + ' 缺变量: ' + miss.join(' '));
  }

  // 外部资源检查：SVG 命名空间 (http://www.w3.org/2000/svg) 是内联的，不算外部
  const withoutNs = s.replace(/http:\/\/www\.w3\.org\/[0-9]+\/svg/g, '');
  const ext = (withoutNs.match(/https?:\/\//g) || []).length;
  if (ext) issues.push('有 ' + ext + ' 处外部 URL');
  if (s.indexOf('@import') >= 0) issues.push('有 @import');
  // url() 只允许 data: 和 #锚点
  const urls = (withoutNs.match(/url\((['"]?)([^)'"]*)\1\)/gi) || []);
  const badUrl = urls.filter(u => {
    const v = u.replace(/^url\(['"]?/i, '').replace(/['"]?\)$/, '').trim();
    return v && !v.startsWith('data:') && !v.startsWith('#');
  });
  if (badUrl.length) issues.push('有非 data-uri 的 url(): ' + badUrl.slice(0, 2).join(' '));

  let d = 0;
  for (const ch of s) { if (ch === '{') d++; else if (ch === '}') d--; }
  if (d !== 0) issues.push('花括号不平衡 ' + d);

  // day/night 是否给了不同的值（同一套皮肤昼夜完全一样就没意义）
  const dayIdx = s.indexOf('data-theme="' + slug + '"][data-mode="day"');
  const nightIdx = s.indexOf('data-theme="' + slug + '"][data-mode="night"');
  if (dayIdx >= 0 && nightIdx >= 0) {
    const dayBlock = s.slice(dayIdx, s.indexOf('}', dayIdx));
    const nightBlock = s.slice(nightIdx, s.indexOf('}', nightIdx));
    if (dayBlock.replace(/\s+/g, '') === nightBlock.replace(/\s+/g, '')) {
      issues.push('昼夜两档完全一样');
    }
  }

  if (issues.length) { bad++; console.log('  x ' + f.padEnd(24) + issues.join(' | ')); }
  else console.log('  OK ' + f.padEnd(24) + s.length + ' B');
}
console.log('');
console.log(bad ? bad + ' 套有问题' : '全部通过');
process.exit(bad ? 1 : 0);
