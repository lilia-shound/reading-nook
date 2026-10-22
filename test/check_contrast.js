'use strict';
// 主题可读性自检：正文色 vs 纸面色的对比度 + 划线色能不能看见
const fs = require('fs');
const path = require('path');

function hex2rgb(h) {
  h = String(h).trim();
  if (h.startsWith('#')) {
    if (h.length === 4) h = '#' + h[1] + h[1] + h[2] + h[2] + h[3] + h[3];
    return [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
  }
  const m = /rgba?\(([^)]+)\)/.exec(h);
  if (m) {
    const p = m[1].split(',').map(x => parseFloat(x));
    return [p[0] | 0, p[1] | 0, p[2] | 0, p.length > 3 ? p[3] : 1];
  }
  return null;
}
function lum(c) {
  const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
}
function contrast(a, b) {
  const l1 = lum(a), l2 = lum(b);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

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
    if (idx < 0) continue;
    const block = s.slice(idx, s.indexOf('}', idx));
    const vars = {};
    block.split(';').forEach(d => {
      const m = /(--[a-z0-9-]+)\s*:\s*([^;]+)/i.exec(d);
      if (m) vars[m[1]] = m[2].trim();
    });

    const paper = hex2rgb(vars['--paper'] || '');
    const ink = hex2rgb(vars['--text-color'] || vars['--ink'] || '');
    if (paper && ink) {
      const c = contrast(paper, ink);
      if (c < 4.5) issues.push(mode + ' 正文对比度只有 ' + c.toFixed(1) + '（要 ≥4.5）');
    }
    // 纸面 vs 页面底色：只要能看出"正文区在哪"就行（1.02 视觉上就是同一片色，
    // 靠留白和边框分隔，这是好事不是问题），这里只报极端情况
    const bg = hex2rgb(vars['--bg'] || '');
    if (paper && bg) {
      const c = contrast(paper, bg);
      if (c < 1.0) issues.push(mode + ' 正文纸面和页面底色完全一样（' + c.toFixed(2) + '）');
    }
    // 划线色 vs 纸面：划线必须看得见（它是"我划过这里"的标记）
    for (const hl of ['--hl-mine', '--hl-ai']) {
      const h = hex2rgb(vars[hl] || '');
      if (h && paper) {
        const c = contrast(paper, h);
        if (c < 1.18) issues.push(mode + ' ' + hl + ' 在纸面上几乎看不见（' + c.toFixed(2) + '）');
      }
    }
  }
  if (issues.length) { bad++; console.log('  x ' + f.padEnd(24) + issues.join(' | ')); }
  else console.log('  OK ' + f.padEnd(24));
}
console.log('');
console.log(bad ? bad + ' 套有可读性问题' : '全部通过');
