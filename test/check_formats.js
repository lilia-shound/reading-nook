'use strict';
/* 校验 epub / docx / fb2 三个解析器（样本在 _fixtures/，由测试脚本外的临时脚本生成） */
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const { parseEpub } = require('../lib/epub');
const { parseDocx } = require('../lib/docx');
const { parseFb2 } = require('../lib/fb2');

const FX = path.join(__dirname, '..', '_fixtures');

const EPUB_CHAPTERS = ['第一章 铁轨上的清晨', '第二章 停靠港的第七夜', '第三章 无人认领的行李'];
const DOCX_CHAPTERS = ['第一章 铁轨上的清晨', '第二章 停靠港的第七夜'];
const KEY_SENTENCE = '姜来把书页往下压了压';

let fails = 0;
let total = 0;

function check(name, fn) {
  total++;
  let ok = true;
  let extra = '';
  try {
    fn();
  } catch (err) {
    ok = false;
    extra = err && err.message ? err.message : String(err);
  }
  if (!ok) fails++;
  console.log((ok ? '  PASS  ' : '  FAIL  ') + name + (extra ? '  -> ' + extra : ''));
}

/** 调解析器，出错也算失败（要求永远不抛异常）。 */
function parseSafe(fn, buf) {
  let res = null;
  try {
    res = fn(buf);
  } catch (err) {
    assert.fail('解析器抛异常了：' + (err && err.message ? err.message : String(err)));
  }
  assert.ok(res && typeof res === 'object', '解析器没有返回对象');
  return res;
}

/* ------------------------------------------------------------------ epub */

const epub = parseSafe(parseEpub, fs.readFileSync(path.join(FX, 'test-book.epub')));

check('EPUB 解析成功', () => assert.strictEqual(epub.ok, true, epub.error));
check('EPUB 书名 = 测试之书·铁轨与黑猫', () => assert.strictEqual(epub.title, '测试之书·铁轨与黑猫'));
check('EPUB 章节数 = 3', () => assert.strictEqual(epub.chapters.length, 3));
check('EPUB 章节标题正确且顺序正确', () => {
  assert.deepStrictEqual(epub.chapters.map((c) => c.title), EPUB_CHAPTERS);
});
check('EPUB 第一章正文含关键句', () => {
  assert.ok(epub.chapters[0].text.includes(KEY_SENTENCE), epub.chapters[0].text);
});
check('EPUB 正文不含 HTML 标签', () => {
  for (const c of epub.chapters) {
    assert.ok(!/</.test(c.text), '正文里还有 < : ' + c.text);
    assert.ok(!c.text.includes('<p'), '正文里还有 <p');
    assert.ok(!c.text.includes('<html'), '正文里还有 <html');
    assert.ok(!c.text.includes('</'), '正文里还有 </');
  }
});
check('EPUB 第一章正文不含章节标题本身', () => {
  assert.ok(!epub.chapters[0].text.includes('第一章 铁轨上的清晨'), epub.chapters[0].text);
});
check('EPUB 每章都有标题和正文', () => {
  for (const c of epub.chapters) {
    assert.strictEqual(typeof c.title, 'string');
    assert.ok(c.title.length > 0, '章节标题是空的');
    assert.strictEqual(typeof c.text, 'string');
    assert.ok(c.text.trim().length > 0, '章节正文是空的');
  }
});
check('EPUB 正文用 \\n 换行且没有裸 \\r', () => {
  for (const c of epub.chapters) {
    assert.ok(!c.text.includes('\r'), '正文里有裸 \\r');
  }
});

/* ------------------------------------------------------------------ docx */

const docx = parseSafe(parseDocx, fs.readFileSync(path.join(FX, 'test-book.docx')));

check('DOCX 解析成功', () => assert.strictEqual(docx.ok, true, docx.error));
check('DOCX 书名是字符串（没有 core.xml 时为空串）', () => {
  assert.strictEqual(typeof docx.title, 'string');
});
check('DOCX 章节数 = 2', () => assert.strictEqual(docx.chapters.length, 2));
check('DOCX 章节标题正确且顺序正确', () => {
  assert.deepStrictEqual(docx.chapters.map((c) => c.title), DOCX_CHAPTERS);
});
check('DOCX 第一章正文含关键句', () => {
  assert.ok(docx.chapters[0].text.includes(KEY_SENTENCE), docx.chapters[0].text);
});
check('DOCX 正文不含标签', () => {
  for (const c of docx.chapters) {
    assert.ok(!/</.test(c.text), '正文里还有 < : ' + c.text);
    assert.ok(!c.text.includes('w:t'), '正文里还有 w:t');
  }
});
check('DOCX 第一章正文不含章节标题本身', () => {
  assert.ok(!docx.chapters[0].text.includes('第一章 铁轨上的清晨'), docx.chapters[0].text);
});

/* ------------------------------------------------------------------- fb2 */

const fb2 = parseSafe(parseFb2, fs.readFileSync(path.join(FX, 'test-book.fb2')));

check('FB2 解析成功', () => assert.strictEqual(fb2.ok, true, fb2.error));
check('FB2 书名 = 测试之书·铁轨与黑猫', () => assert.strictEqual(fb2.title, '测试之书·铁轨与黑猫'));
check('FB2 章节数 = 2', () => assert.strictEqual(fb2.chapters.length, 2));
check('FB2 章节标题正确且顺序正确', () => {
  assert.deepStrictEqual(fb2.chapters.map((c) => c.title), DOCX_CHAPTERS);
});
check('FB2 第一章正文含关键句', () => {
  assert.ok(fb2.chapters[0].text.includes(KEY_SENTENCE), fb2.chapters[0].text);
});
check('FB2 正文不含标签', () => {
  for (const c of fb2.chapters) {
    assert.ok(!/</.test(c.text), '正文里还有 < : ' + c.text);
  }
});
check('FB2 第一章正文不含章节标题本身', () => {
  assert.ok(!fb2.chapters[0].text.includes('第一章 铁轨上的清晨'), fb2.chapters[0].text);
});

/* --------------------------------------------------------------- 实体解码 */

const ENTITIES_XML = [
  '<?xml version="1.0" encoding="utf-8"?>',
  '<FictionBook xmlns="http://www.gribuser.ru/xml/fictionbook/2.0">',
  '<description><title-info><book-title>实体 &amp; 测试</book-title></title-info></description>',
  '<body><section><title><p>第&#49;章 &lt;标记&gt;</p></title>',
  '<p>Tom &amp; Jerry &lt;tag&gt; &quot;q&quot; &apos;a&apos; &#65; &#x42; &nbsp;结尾</p>',
  '</section></body></FictionBook>',
].join('\n');

const ent = parseSafe(parseFb2, Buffer.from(ENTITIES_XML, 'utf8'));

check('FB2 实体解码：书名里的 &amp;', () => {
  assert.strictEqual(ent.ok, true, ent.error);
  assert.ok(ent.title.includes('实体 &'), ent.title);
});
check('FB2 实体解码：正文里的 & < > " \' 数字实体', () => {
  const t = ent.chapters[0].text;
  assert.ok(t.includes('Tom & Jerry'), t);
  assert.ok(t.includes('<tag>'), t);
  assert.ok(t.includes('"q"'), t);
  assert.ok(t.includes("'a'"), t);
  assert.ok(t.includes('A B'), t);
});
check('FB2 实体解码：章节标题里的数字实体', () => {
  assert.ok(ent.chapters[0].title.includes('第1章'), ent.chapters[0].title);
});
check('FB2 实体解码：&nbsp; 变成普通空格', () => {
  const t = ent.chapters[0].text;
  assert.ok(t.indexOf('\u00a0') < 0, '正文里还有不换行空格');
  assert.ok(t.includes('结尾'), t);
});

/* ------------------------------------------------------------------ 容错 */

const JUNK = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0xff, 0xfe, 0x00, 0x01, 0x99, 0x42]);

check('空 Buffer → ok:false 且有中文 error（三个解析器）', () => {
  for (const fn of [parseEpub, parseDocx, parseFb2]) {
    const r = parseSafe(fn, Buffer.alloc(0));
    assert.strictEqual(r.ok, false);
    assert.strictEqual(typeof r.error, 'string');
    assert.ok(r.error.length > 0, 'error 是空的');
  }
});
check('乱码 Buffer → ok:false 且不抛异常（三个解析器）', () => {
  for (const fn of [parseEpub, parseDocx, parseFb2]) {
    const r = parseSafe(fn, JUNK);
    assert.strictEqual(r.ok, false);
    assert.ok(typeof r.error === 'string' && r.error.length > 0, 'error 是空的');
  }
});
check('null / undefined 输入 → ok:false 且不抛异常', () => {
  for (const fn of [parseEpub, parseDocx, parseFb2]) {
    for (const bad of [null, undefined]) {
      const r = parseSafe(fn, bad);
      assert.strictEqual(r.ok, false);
      assert.ok(typeof r.error === 'string' && r.error.length > 0, 'error 是空的');
    }
  }
});
check('docx 里没有 word/document.xml 时给出明确错误', () => {
  const r = parseSafe(parseDocx, Buffer.from(JUNK));
  assert.strictEqual(r.ok, false);
  assert.ok(r.error.length > 0);
});
check('非 fb2 的 XML → 明确错误', () => {
  const r = parseSafe(parseFb2, Buffer.from('<?xml version="1.0"?><root><a/></root>', 'utf8'));
  assert.strictEqual(r.ok, false);
  assert.ok(r.error.indexOf('fb2') >= 0, r.error);
});

console.log('');
console.log(fails === 0 ? 'ALL PASS' : fails + ' FAILED');
console.log(total + ' checks');
process.exit(fails ? 1 : 0);
