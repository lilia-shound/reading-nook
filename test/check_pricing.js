'use strict';
/* Validate the DeepSeek pricing engine (peak/off-peak + cache hit/miss) */
const ds = require('../lib/deepseek');
const store = require('../lib/store');

let fails = 0;
function check(name, ok, extra) {
  if (!ok) fails++;
  console.log((ok ? '  PASS  ' : '  FAIL  ') + name + (extra !== undefined ? '  -> ' + extra : ''));
}

// 2026-10-21 是周三。北京时间 = UTC+8
const wed = (utcHour) => new Date(Date.UTC(2026, 9, 21, utcHour, 0));
const sat = (utcHour) => new Date(Date.UTC(2026, 9, 24, utcHour, 0));

check('周三 09:00 北京 = 峰', ds.isPeakTime(wed(1)) === true);
check('周三 11:59 北京 = 峰', ds.isPeakTime(wed(3)) === true);
check('周三 12:00 北京 = 谷（高峰结束）', ds.isPeakTime(wed(4)) === false);
check('周三 14:00 北京 = 峰', ds.isPeakTime(wed(6)) === true);
check('周三 17:59 北京 = 峰', ds.isPeakTime(wed(9)) === true);
check('周三 18:00 北京 = 谷', ds.isPeakTime(wed(10)) === false);
check('周六 10:00 北京 = 谷（周末全天）', ds.isPeakTime(sat(2)) === false);

const config = store.readConfig();
check('默认模型 = deepseek-flash', config.deepseek_model === 'deepseek-flash', config.deepseek_model);

const table = ds.pricingTable(config);
check('计价表含 deepseek-flash', !!table['deepseek-flash']);
check('计价表含 deepseek-v4-pro', !!table['deepseek-v4-pro']);
check('高峰档 = 低谷档的两倍（flash 输入未命中）',
  Math.abs(table['deepseek-flash'].peak.cache_miss - table['deepseek-flash'].offpeak.cache_miss * 2) < 0.001,
  table['deepseek-flash'].peak.cache_miss + ' vs ' + table['deepseek-flash'].offpeak.cache_miss * 2);

// 计价：缓存命中/未命中分开算
const usage = {
  prompt_tokens: 100000,
  completion_tokens: 10000,
  prompt_cache_hit_tokens: 40000,
  prompt_cache_miss_tokens: 60000
};
const off = ds.calcCost(usage, config, 'deepseek-flash', wed(2)); // 北京 10:00 → 峰
const off2 = ds.calcCost(usage, config, 'deepseek-flash', wed(5)); // 北京 13:00 → 谷
check('谷档成本 = 峰档的一半', Math.abs(off.cost - off2.cost * 2) < 0.0001,
  'peak=' + off.cost.toFixed(6) + ' offpeak=' + off2.cost.toFixed(6));
check('峰档标记正确', off.peak === true && off2.peak === false);

const expected = (40000 / 1e6) * 0.04 + (60000 / 1e6) * 2 + (10000 / 1e6) * 8;
check('按命中/未命中分别计价算得对', Math.abs(off.cost - expected) < 0.000001,
  off.cost.toFixed(6) + ' vs ' + expected.toFixed(6));

// 没有 cache_miss 字段时用 prompt_tokens - hit 兜底
const r = ds.calcCost({ prompt_tokens: 1000, completion_tokens: 100 }, config, 'deepseek-flash', wed(2));
check('缺 cache_miss 时能兜底', r.cacheMissTokens === 1000 && r.cacheHitTokens === 0, JSON.stringify(r));

// 自定义覆盖
const custom = Object.assign({}, config, { deepseek_pricing: { 'deepseek-flash': { peak: { output: 1 } } } });
const t2 = ds.pricingTable(custom);
check('config 里的自定义价能覆盖', t2['deepseek-flash'].peak.output === 1 && t2['deepseek-flash'].offpeak.output === 4,
  'peak=' + t2['deepseek-flash'].peak.output + ' offpeak=' + t2['deepseek-flash'].offpeak.output);

// 官方价原样锁定，防止以后再被汇率换算改坏
const OFFICIAL = {
  'deepseek-flash': { peak: [0.04, 2, 8], offpeak: [0.02, 1, 4] },
  'deepseek-v4-pro': { peak: [0.3, 9.0, 27.0], offpeak: [0.15, 4.5, 13.5] }
};
for (const m of Object.keys(OFFICIAL)) {
  const row = table[m];
  const p = OFFICIAL[m].peak, o = OFFICIAL[m].offpeak;
  check(m + ' 官方价（高峰/低谷 × 命中/未命中/输出）一致',
    row.peak.cache_hit === p[0] && row.peak.cache_miss === p[1] && row.peak.output === p[2] &&
    row.offpeak.cache_hit === o[0] && row.offpeak.cache_miss === o[1] && row.offpeak.output === o[2],
    JSON.stringify(row));
  check(m + ' 峰=谷×2 不变量', Math.abs(row.peak.cache_miss - row.offpeak.cache_miss * 2) < 0.0001 &&
    Math.abs(row.peak.output - row.offpeak.output * 2) < 0.0001 &&
    Math.abs(row.peak.cache_hit - row.offpeak.cache_hit * 2) < 0.0001);
}

console.log('');
console.log(fails === 0 ? 'ALL PASS' : fails + ' FAILED');
process.exit(fails ? 1 : 0);
