'use strict';
/* Validate DeepSeek helper behavior: line-number parsing + thinking-mode defaults */
const ds = require('../lib/deepseek');
const store = require('../lib/store');

let fails = 0;
function check(name, ok, extra) {
  if (!ok) fails++;
  console.log((ok ? '  PASS  ' : '  FAIL  ') + name + (extra !== undefined ? '  -> ' + extra : ''));
}

// ---- 行号解析 ----
check('纯数字行', JSON.stringify(ds.parseLineNumbers('3\n7\n12')) === '[3,7,12]',
  JSON.stringify(ds.parseLineNumbers('3\n7\n12')));

check('带句点/顿号/行字后缀', JSON.stringify(ds.parseLineNumbers('3.\n7、\n12行')) === '[3,7,12]',
  JSON.stringify(ds.parseLineNumbers('3.\n7、\n12行')));

check('夹带解释时只取整行数字（不把「共2处」的 2 当行号）',
  JSON.stringify(ds.parseLineNumbers('行号 3 和 7，共 2 处')) === '[3,7]',
  JSON.stringify(ds.parseLineNumbers('行号 3 和 7，共 2 处')));

check('全是散数字时退回宽松抓取',
  JSON.stringify(ds.parseLineNumbers('3 7 12')) === '[3,7,12]',
  JSON.stringify(ds.parseLineNumbers('3 7 12')));

check('空输出 → 空数组', ds.parseLineNumbers('').length === 0);
check('NONE 之类没有数字 → 空数组', ds.parseLineNumbers('NONE').length === 0);
check('去重', JSON.stringify(ds.parseLineNumbers('3\n3\n7')) === '[3,7]',
  JSON.stringify(ds.parseLineNumbers('3\n3\n7')));

// ---- 思考模式默认关闭（脏活不该烧输出的钱） ----
const config = store.readConfig();
check('默认模型 = deepseek-flash', config.deepseek_model === 'deepseek-flash', config.deepseek_model);

// 通过源码检查 chat() 里 thinking 的默认值与 temperature 门控
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'deepseek.js'), 'utf8');
check('thinking 默认为 false（opt.thinking !== true）',
  /const thinking = opt\.thinking === true;/.test(src));
check('请求体里显式带 thinking 开关',
  /thinking:\s*\{\s*type:\s*thinking\s*\?\s*'enabled'\s*:\s*'disabled'\s*\}/.test(src));
check('temperature 只在非思考模式下才发',
  /if \(useTemp\) \{[\s\S]{0,200}body\.temperature/.test(src) &&
  /const useTemp = !thinking;/.test(src));

// ---- 账本记录里带 thinking 字段，便于审计 ----
check('账本记录 thinking 档位', /thinking:\s*thinking,/.test(src));

// ---- 计价函数对未知模型会回落到默认模型，不会 NaN ----
const c = ds.calcCost({ prompt_tokens: 1000, completion_tokens: 100 }, config, 'some-unknown-model');
check('未知模型不产生 NaN', Number.isFinite(c.cost) && c.cost > 0, String(c.cost));

// ---- 剧情笔记成本预估 ----
const book = { id: 'b_test', title: '测试', chapters: [] };
for (let i = 1; i <= 3; i++) {
  book.chapters.push({ index: i, title: '第' + i + '章', startLine: 0, endLine: 10, charCount: 3000 });
}
const e1 = ds.estimateNotesCost(book, book.chapters, config);
check('预估 3 章：章节数对', e1.chapters === 3, String(e1.chapters));
check('预估 3 章：输入 token 随字数涨', e1.inputTokens > 5000 && e1.inputTokens < 8000, String(e1.inputTokens));
check('预估 3 章：输出 token = 150/章', e1.outputTokens === 450, String(e1.outputTokens));
check('预估 3 章：成本为正且很小（远不到 1 元）', e1.cost > 0 && e1.cost < 0.1, e1.cost.toFixed(6));

const e0 = ds.estimateNotesCost(book, [], config);
check('没有待生成章节 → 0 成本', e0.cost === 0 && e0.chapters === 0, String(e0.cost));

// 成本必须随字数单调递增（长章更贵，不能按章数拍脑袋）
const short = [{ index: 1, title: '短', charCount: 500 }];
const long = [{ index: 1, title: '长', charCount: 5000 }];
const es = ds.estimateNotesCost(book, short, config);
const el = ds.estimateNotesCost(book, long, config);
check('长章比短章贵', el.cost > es.cost * 3, el.cost.toFixed(6) + ' vs ' + es.cost.toFixed(6));

// 峰谷档要体现在预估里
const peak = ds.estimateNotesCost(book, book.chapters, config, new Date(Date.UTC(2026, 9, 21, 2)));
const off = ds.estimateNotesCost(book, book.chapters, config, new Date(Date.UTC(2026, 9, 21, 5)));
check('预估也分峰谷（谷档是峰档的一半）', Math.abs(peak.cost - off.cost * 2) < 0.000001,
  peak.cost.toFixed(6) + ' vs ' + (off.cost * 2).toFixed(6));

// 超长章要按 max_chars 截断，不无限计费
const huge = [{ index: 1, title: '巨章', charCount: 500000 }];
const eh = ds.estimateNotesCost(book, huge, config);
const cap = Number(config.deepseek_note_max_chars) || 12000;
check('超长章按 max_chars 截断计费', eh.inputTokens <= Math.ceil(cap * 0.65) + 1,
  'chars=500000 -> tokens=' + eh.inputTokens + ' (cap=' + cap + ')');

// ---- 返回值契约：writePlotNote / splitChaptersWithAI 必须带 cost ----
// 踩过的坑：这两个函数当初只返回 log 不返回 cost，
// 结果 server 端 `spent += r.cost` 变成 NaN，预算闸门的运行时停止条件直接失效。
const fnSrc = src;
const plotNoteBody = fnSrc.slice(fnSrc.indexOf('async function writePlotNote'), fnSrc.indexOf('function estimateNotesCost'));
const splitBody = fnSrc.slice(fnSrc.indexOf('async function splitChaptersWithAI'), fnSrc.indexOf('function parseLineNumbers'));
check('writePlotNote 返回 cost', /cost:\s*res\.cost/.test(plotNoteBody));
check('splitChaptersWithAI 返回 cost', /cost:\s*res\.cost/.test(splitBody));

const srv = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
check('server 端用 r.cost 累计预算', /spent\s*\+=\s*r\.cost/.test(srv));

// ---- 非正文章节识别（版权/致谢/索引这类不写剧情笔记）----
check('版权信息 → 非正文', ds.isNarrativeChapter('版权信息') === false);
check('致谢 → 非正文', ds.isNarrativeChapter('致谢') === false);
check('地名翻译对照表 → 非正文', ds.isNarrativeChapter('地名翻译对照表') === false);
check('献词 → 非正文', ds.isNarrativeChapter('献词') === false);
check('索引 → 非正文', ds.isNarrativeChapter('索引') === false);
check('普通章节 → 正文', ds.isNarrativeChapter('第一章 铁轨上的清晨') === true);
check('正文标题里带「后记」也要保留（有内容）', ds.isNarrativeChapter('后记：写给十年后的自己') === true);
check('空标题按正文算', ds.isNarrativeChapter('') === true);
check('「版权」两个字在正文中间不算', ds.isNarrativeChapter('第九章 版权生意') === true);
check('「致谢信」这种正文不算附录', ds.isNarrativeChapter('致谢信') === true);
check('「后记」保留（可能有内容）', ds.isNarrativeChapter('后记') === true);
check('「作者手记」保留', ds.isNarrativeChapter('作者手记') === true);
check('带括号的附录标题也认', ds.isNarrativeChapter('致谢（2020）') === false);

console.log('');
console.log(fails === 0 ? 'ALL PASS' : fails + ' FAILED');
process.exit(fails ? 1 : 0);
