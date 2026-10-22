'use strict';
/**
 * check_gh.js —— 验一下「浏览器免 token 读密文」这条路通不通
 *
 * 要验三件事：
 *   1. raw.githubusercontent.com 认 CORS 吗（Access-Control-Allow-Origin: *）
 *   2. api.github.com 的 contents 接口认 CORS 吗（写回的时候要用）
 *   3. 加了 ?t= 之后能不能绕过 CDN 缓存拿到新内容
 *
 *   node test/check_gh.js
 */

const https = require('https');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const site = require(path.join(ROOT, 'public', 'site.json'));
const RAW = 'https://raw.githubusercontent.com/' + site.owner + '/' + site.repo + '/' + site.branch + '/';

function head(url, extraHeaders) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request(
      {
        method: 'GET',
        hostname: u.hostname,
        path: u.pathname + u.search,
        headers: Object.assign({ 'User-Agent': 'nook-check' }, extraHeaders || {})
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () =>
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8')
          })
        );
      }
    );
    req.on('error', reject);
    req.end();
  });
}

let pass = 0;
let fail = 0;
function ok(name, cond, extra) {
  if (cond) {
    pass++;
    console.log('  ✓ ' + name);
  } else {
    fail++;
    console.log('  ✗ ' + name + (extra ? '  → ' + extra : ''));
  }
}

(async () => {
  console.log('仓库:', site.owner + '/' + site.repo + '@' + site.branch);
  console.log('');
  console.log('[1] raw.githubusercontent.com');
  const raw = await head(RAW + 'public/site.json');
  ok('200', raw.status === 200, 'status=' + raw.status);
  const acao = raw.headers['access-control-allow-origin'];
  ok('CORS: Access-Control-Allow-Origin', acao === '*', String(acao));
  ok('能拿到 site.json 内容', raw.body.indexOf('"mode"') > 0);

  console.log('');
  console.log('[2] raw + 缓存破坏参数');
  const raw2 = await head(RAW + 'public/site.json?t=' + Date.now());
  ok('200', raw2.status === 200, 'status=' + raw2.status);
  ok('内容一致', raw2.body === raw.body);

  console.log('');
  console.log('[3] api.github.com contents（读）');
  const api = await head(
    'https://api.github.com/repos/' + site.owner + '/' + site.repo + '/contents/public/site.json?ref=' + site.branch,
    { Accept: 'application/vnd.github.raw' }
  );
  ok('200（未带 token 也能读公开仓库）', api.status === 200, 'status=' + api.status);
  ok('CORS: Access-Control-Allow-Origin', api.headers['access-control-allow-origin'] === '*', String(api.headers['access-control-allow-origin']));
  ok('raw 形式返回正文', api.body.indexOf('"mode"') > 0);

  console.log('');
  console.log('[4] 不存在的文件应该 404（用来判断「这章有没有批注」）');
  const miss = await head(RAW + 'data/books/nope/annotations/1.json.enc');
  ok('404', miss.status === 404, 'status=' + miss.status);

  console.log('');
  console.log('结果: ' + pass + ' 通过, ' + fail + ' 失败');
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('出错:', e.message);
  process.exit(1);
});
