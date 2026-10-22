'use strict';
/* Validate the multi-format upload layer: detection + chapter/line mapping + txt regression */
const fs = require('fs');
const path = require('path');
const extract = require('../lib/extract');

let fails = 0;
function check(name, ok, extra) {
  if (!ok) fails++;
  console.log((ok ? '  PASS  ' : '  FAIL  ') + name + (extra !== undefined ? '  -> ' + extra : ''));
}

const FX = path.join(__dirname, '..', '_fixtures');

// ---- 格式识别 ----
check('.txt → txt', extract.detectFormat('a.txt', Buffer.from('x')) === 'txt');
check('.epub → epub', extract.detectFormat('a.epub', Buffer.from('x')) === 'epub');
check('.docx → docx', extract.detectFormat('a.docx', Buffer.from('x')) === 'docx');
check('.fb2 → fb2', extract.detectFormat('a.fb2', Buffer.from('x')) === 'fb2');
check('.mobi → mobi', extract.detectFormat('a.mobi', Buffer.from('x')) === 'mobi');
check('.azw3 → mobi', extract.detectFormat('a.azw3', Buffer.from('x')) === 'mobi');
check('.pdf → pdf', extract.detectFormat('a.pdf', Buffer.from('x')) === 'pdf');
check('大写扩展名也认', extract.detectFormat('A.EPUB', Buffer.from('x')) === 'epub');

// magic bytes：没有扩展名也要认出来
const pdfBuf = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(80)]);
check('PDF magic bytes → pdf', extract.detectFormat('x', pdfBuf) === 'pdf');

const mobiBuf = Buffer.alloc(100);
mobiBuf.write('BOOKMOBI', 60, 'latin1');
check('MOBI magic bytes（偏移 60）→ mobi', extract.detectFormat('x', mobiBuf) === 'mobi');

const epubProbe = Buffer.concat([
  Buffer.from('PK\x03\x04'),
  Buffer.from('application/epub+zip'),
  Buffer.alloc(50)
]);
check('ZIP 里含 epub+zip 标记 → epub', extract.detectFormat('x', epubProbe) === 'epub');

// ---- 章节 → 行号映射 ----
const fin = extract.finalizeChapters(
  [
    { title: '第一章 甲', text: '第一段\n第二段' },
    { title: '第二章 乙', text: '第三段' }
  ],
  '书名',
  'x.epub',
  'epub'
);
check('finalize 成功', fin.ok === true);
check('finalize 章节数 = 2', fin.chapters.length === 2, String(fin.chapters.length));
check('finalize 书名用传入的', fin.title === '书名', fin.title);
check('第一章 startLine = 0', fin.chapters[0].startLine === 0, String(fin.chapters[0].startLine));
check('第一章 endLine = 2（标题+两段）', fin.chapters[0].endLine === 2, String(fin.chapters[0].endLine));
check('第二章 startLine = 3', fin.chapters[1].startLine === 3, String(fin.chapters[1].startLine));
check('第二章 endLine = 4（标题+一段）', fin.chapters[1].endLine === 4, String(fin.chapters[1].endLine));
check('charCount 只算正文不算标题', fin.chapters[0].charCount === 7, String(fin.chapters[0].charCount));

const lines = fin.text.split('\n');
check('拼出的全文行数和 endLine 对得上', lines[fin.chapters[1].endLine] === '第三段', lines[fin.chapters[1].endLine]);
check('正文里没有多余空章', fin.chapters.every((c) => c.endLine >= c.startLine));

// 空章节要被丢掉
const fin2 = extract.finalizeChapters(
  [{ title: '', text: '' }, { title: '有效', text: '有内容' }],
  '', 'x.txt', 'txt'
);
check('空章节被丢掉', fin2.chapters.length === 1, String(fin2.chapters.length));

// ---- txt 回归：行为必须和改动前一致 ----
// 用真实体量的样本（本地拆章器对太短的文本会退回按长度切分）
const tLines = [];
for (let i = 1; i <= 3; i++) {
  tLines.push('第' + '一二三'[i - 1] + '章 标题' + i);
  for (let j = 0; j < 12; j++) tLines.push('这是第' + i + '章的第' + (j + 1) + '段。姜来把书页往下压了压。');
}
const txt = tLines.join('\n');
const rTxt = extract.extractBook(Buffer.from(txt, 'utf8'), 'book.txt');
check('txt 提取成功', rTxt.ok === true, rTxt.error);
check('txt 格式标记 = txt', rTxt.format === 'txt');
check('txt 拆出 3 章', rTxt.chapters.length === 3, String(rTxt.chapters.length));
check('txt 章节标题保留', rTxt.chapters[0].title === '第一章 标题1', rTxt.chapters[0].title);
check('txt 正文原样保留', rTxt.text.includes('姜来把书页往下压了压'));

// ---- 不支持的格式要给出人话提示 ----
const rMobi = extract.extractBook(mobiBuf, 'a.mobi');
check('mobi 给出明确提示而不是崩', rMobi.ok === false && /Calibre/.test(rMobi.error || ''), rMobi.error);
const rPdf = extract.extractBook(pdfBuf, 'a.pdf');
check('pdf 给出明确提示而不是崩', rPdf.ok === false && /TXT|EPUB/.test(rPdf.error || ''), rPdf.error);
const rEmpty = extract.extractBook(Buffer.alloc(0), 'a.txt');
check('空文件报错', rEmpty.ok === false && !!rEmpty.error, rEmpty.error);
const rJunk = extract.extractBook(Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]), 'a.bin');
check('垃圾文件不抛异常，且被判定为非文本', rJunk.ok === false && !!rJunk.error, rJunk.error);
check('二进制乱码不会被当 txt 收下', /不是文本|二进制/.test(rJunk.error || ''), rJunk.error);

// ---- 格式清单要说清楚哪些读不了 ----
const fmts = extract.SUPPORTED_FORMATS;
check('格式清单里有 txt/epub/docx/fb2', ['txt', 'epub', 'docx', 'fb2'].every((e) => fmts.some((f) => f.ext === e && f.ok)));
check('格式清单里 mobi/pdf 标了不支持', ['mobi', 'pdf'].every((e) => fmts.some((f) => f.ext === e && !f.ok)));

// ---- 真实 fixture 的端到端（如果 worker 的解析器已经就位）----
for (const [file, fmt, wantChapters] of [
  ['test-book.epub', 'epub', 3],
  ['test-book.docx', 'docx', 2],
  ['test-book.fb2', 'fb2', 2]
]) {
  const p = path.join(FX, file);
  if (!fs.existsSync(p)) {
    check(file + ' fixture 存在', false, '缺文件');
    continue;
  }
  const r = extract.extractBook(fs.readFileSync(p), file);
  if (!r.ok) {
    check(file + ' 能提取', false, r.error);
    continue;
  }
  check(file + ' 提取成功，格式 = ' + fmt, r.format === fmt, r.format);
  check(file + ' 章节数 = ' + wantChapters, r.chapters.length === wantChapters, String(r.chapters.length));
  check(file + ' 章节标题非空', r.chapters.every((c) => c.title && c.title.length > 0));
  check(file + ' 正文不含 HTML 标签', !/<[a-zA-Z/]/.test(r.text));
  const lines = r.text.split('\n');
  check(file + ' 每章 endLine 都在全文范围内', r.chapters.every((c) => c.endLine < lines.length && c.endLine >= c.startLine));
  check(file + ' 每章正文非空', r.chapters.every((c) => c.charCount > 0));
}

console.log('');
console.log(fails === 0 ? 'ALL PASS' : fails + ' FAILED');
process.exit(fails ? 1 : 0);
