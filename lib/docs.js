'use strict';
/**
 * 共读小屋 · 资料库（伴读 AI 可读的文档）
 *
 * 为什么要有这个：
 *   批注和剧情笔记是"一本书的内容"，但有些东西不属于任何一本书 ——
 *   比如《古道》的全书脉络、共读小屋的设计说明、我们两个的分工约定。
 *   这些东西云端那位也要读，所以给它们一个正式的入口，
 *   而不是靠"把文件传到 drive"这种绕路。
 *
 * 约定：
 *   data/docs/*.md   放文档（纯 markdown）
 *   文档可以 front-matter 写 title/summary
 *
 * 零依赖，跟 store.js 一个风格。
 *
 * 【2026-10-22】改走 vfs：路径变成相对 data/ 的 POSIX 路径（'docs/xxx.md'），
 * 换到 GitHub 后端时同一批文档就在仓库的 data/docs/ 里（存的是密文）。
 */

const vfs = require('./vfs');

const DOCS = 'docs';

// 极简 front-matter 解析：只认 key: value 和 key: [a, b]
function parseFrontMatter(text) {
  const meta = {};
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!m) return { meta, body: text };
  m[1].split(/\r?\n/).forEach((line) => {
    const kv = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line.trim());
    if (!kv) return;
    let v = kv[2].trim();
    if (v.startsWith('[') && v.endsWith(']')) {
      v = v.slice(1, -1).split(',').map((x) => x.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
    } else {
      v = v.replace(/^["']|["']$/g, '');
    }
    meta[kv[1]] = v;
  });
  return { meta, body: text.slice(m[0].length) };
}

function ensureDocsDir() {
  try {
    vfs.mkdirSync(DOCS);
  } catch (e) { /* ignore */ }
}

// 列出所有文档（不读全文，只读 front-matter 摘要）
function listDocs() {
  ensureDocsDir();
  const out = [];
  for (const f of vfs.readdirSync(DOCS)) {
    if (!f.endsWith('.md')) continue;
    let raw = '';
    try { raw = vfs.readFileSync(DOCS + '/' + f); } catch (e) { continue; }
    const { meta, body } = parseFrontMatter(raw);
    const st = vfs.statSync(DOCS + '/' + f);
    out.push({
      id: f.replace(/\.md$/, ''),
      file: f,
      title: meta.title || f.replace(/\.md$/, ''),
      summary: meta.summary || '',
      tags: Array.isArray(meta.tags) ? meta.tags : (meta.tags ? [meta.tags] : []),
      chars: body.length,
      updatedAt: st && st.mtime ? new Date(st.mtime).toISOString() : null
    });
  }
  out.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
  return out;
}

// 读一篇文档全文
function readDoc(id) {
  ensureDocsDir();
  const safe = String(id).replace(/[^A-Za-z0-9._-]/g, '');
  if (!safe || safe.indexOf('..') >= 0) return null;
  const rel = DOCS + '/' + safe + '.md';
  // 路径穿越必须挡住 —— 这东西跑在公网上
  if (rel.slice(0, DOCS.length + 1) !== DOCS + '/') return null;
  if (!vfs.existsSync(rel)) return null;
  let raw = '';
  try { raw = vfs.readFileSync(rel); } catch (e) { return null; }
  const { meta, body } = parseFrontMatter(raw);
  return {
    id: safe,
    title: meta.title || safe,
    summary: meta.summary || '',
    tags: Array.isArray(meta.tags) ? meta.tags : (meta.tags ? [meta.tags] : []),
    body: body.trim(),
    chars: body.length
  };
}

module.exports = { DOCS, ensureDocsDir, listDocs, readDoc };
