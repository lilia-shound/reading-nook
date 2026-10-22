'use strict';
/**
 * gh-admin.js —— 不用 git，直接用 GitHub API 管理仓库。
 *
 * 零依赖，Node 标准库。
 * token 从环境变量 GH_TOKEN 读，**永远不落盘**。
 *
 *   node tools/gh-admin.js whoami
 *   node tools/gh-admin.js create-repo <name> [--private]
 *   node tools/gh-admin.js put <path> <localFile> [--message "..."]
 *   node tools/gh-admin.js put-text <path> <text> [--message "..."]
 *   node tools/gh-admin.js get <path>
 *   node tools/gh-admin.js list <dir>
 *   node tools/gh-admin.js enable-pages
 *   node tools/gh-admin.js pages-status
 *   node tools/gh-admin.js delete-repo <name>
 *   node tools/gh-admin.js runs
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

const TOKEN = (process.env.GH_TOKEN || '').trim();
if (!TOKEN) {
  console.error('缺少 GH_TOKEN 环境变量');
  process.exit(2);
}

const API = 'https://api.github.com';

function req(method, apiPath, body) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body), 'utf8');
    const headers = {
      'Accept': 'application/vnd.github+json',
      'Authorization': 'Bearer ' + TOKEN,
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'reading-nook-admin',
      'Content-Type': 'application/json'
    };
    if (payload) headers['Content-Length'] = payload.length;
    const u = new URL(apiPath.startsWith('http') ? apiPath : API + apiPath);
    const r = https.request(
      {
        method,
        hostname: u.hostname,
        path: u.pathname + u.search,
        headers
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          let data = null;
          try { data = raw ? JSON.parse(raw) : null; } catch (e) { data = raw; }
          if (res.statusCode >= 200 && res.statusCode < 300) resolve(data);
          else {
            const msg = data && data.message ? data.message : raw.slice(0, 300);
            const e = new Error(res.statusCode + ' ' + msg);
            e.status = res.statusCode;
            e.data = data;
            reject(e);
          }
        });
      }
    );
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}

/** 读某个路径的当前 sha（不存在返回 null） */
async function fileSha(repo, filePath, branch) {
  try {
    const r = await req('GET', '/repos/' + repo + '/contents/' + filePath + '?ref=' + encodeURIComponent(branch));
    return r.sha;
  } catch (e) {
    if (e.status === 404) return null;
    throw e;
  }
}

async function putFile(repo, filePath, content, message, branch) {
  const sha = await fileSha(repo, filePath, branch);
  const body = {
    message: message || ('更新 ' + filePath),
    content: Buffer.from(content, 'utf8').toString('base64'),
    branch: branch
  };
  if (sha) body.sha = sha;
  return req('PUT', '/repos/' + repo + '/contents/' + filePath, body);
}

async function main() {
  const args = process.argv.slice(2);
  const cmd = args.shift();
  const flags = {};
  const rest = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) {
      const k = args[i].slice(2);
      if (i + 1 < args.length && !args[i + 1].startsWith('--')) flags[k] = args[++i];
      else flags[k] = true;
    } else rest.push(args[i]);
  }
  const repo = flags.repo || process.env.GH_REPO || 'lilia-shound/reading-nook';
  const branch = flags.branch || 'main';

  if (cmd === 'whoami') {
    const u = await req('GET', '/user');
    console.log(JSON.stringify({ login: u.login, id: u.id, name: u.name }, null, 2));
    return;
  }

  if (cmd === 'create-repo') {
    const name = rest[0];
    if (!name) throw new Error('用法: create-repo <name> [--private]');
    const body = {
      name: name,
      description: flags.description || '共读小屋 —— 姜来 & 姜去',
      private: !!flags.private,
      auto_init: true,
      has_issues: true,
      has_wiki: false
    };
    try {
      const r = await req('POST', '/user/repos', body);
      console.log('已创建:', r.full_name, r.html_url, 'private=' + r.private);
    } catch (e) {
      if (e.status === 422) {
        console.log('仓库已存在（422），继续用它。');
        const r = await req('GET', '/repos/lilia-shound/' + name);
        console.log(r.full_name, r.html_url, 'private=' + r.private);
      } else throw e;
    }
    return;
  }

  if (cmd === 'put') {
    const filePath = rest[0];
    const local = rest[1];
    if (!filePath || !local) throw new Error('用法: put <path> <localFile>');
    const content = fs.readFileSync(local, 'utf8');
    const r = await putFile(repo, filePath, content, flags.message, branch);
    console.log('已写入', filePath, 'sha=' + r.content.sha, 'url=' + r.content.html_url);
    return;
  }

  if (cmd === 'put-text') {
    const filePath = rest[0];
    const text = rest[1] || '';
    const r = await putFile(repo, filePath, text, flags.message, branch);
    console.log('已写入', filePath, 'sha=' + r.content.sha);
    return;
  }

  if (cmd === 'get') {
    const r = await req('GET', '/repos/' + repo + '/contents/' + rest[0] + '?ref=' + encodeURIComponent(branch));
    if (Array.isArray(r)) {
      console.log(r.map((x) => x.path + '  ' + x.size).join('\n'));
    } else {
      process.stdout.write(Buffer.from(r.content, 'base64').toString('utf8'));
    }
    return;
  }

  if (cmd === 'list') {
    const dir = rest[0] || '';
    const r = await req('GET', '/repos/' + repo + '/contents/' + dir + '?ref=' + encodeURIComponent(branch));
    console.log(r.map((x) => x.type + '  ' + x.path + '  ' + x.size).join('\n'));
    return;
  }

  if (cmd === 'enable-pages') {
    // 1) 打开 Pages 开关
    try {
      const r = await req('POST', '/repos/' + repo + '/pages', { build_type: 'workflow' });
      console.log('Pages 已开启:', JSON.stringify(r));
    } catch (e) {
      if (e.status === 409 || (e.data && e.data.message && /already/i.test(e.data.message))) {
        console.log('Pages 已经开着了。');
      } else {
        console.log('开 Pages 出错（不一定是致命的）:', e.message);
      }
    }
    // 2) 构建类型设为 workflow（用 Actions 部署）
    try {
      const r = await req('PUT', '/repos/' + repo + '/pages', { build_type: 'workflow' });
      console.log('build_type =', r.build_type);
    } catch (e) {
      console.log('设 build_type 出错:', e.message);
    }
    return;
  }

  if (cmd === 'pages-status') {
    const r = await req('GET', '/repos/' + repo + '/pages');
    console.log(JSON.stringify({ url: r.html_url, status: r.status, build_type: r.build_type, source: r.source }, null, 2));
    return;
  }

  if (cmd === 'runs') {
    const r = await req('GET', '/repos/' + repo + '/actions/runs?per_page=10');
    (r.workflow_runs || []).forEach((x) => {
      console.log(x.id, x.name, x.status, x.conclusion, x.created_at, x.html_url);
    });
    return;
  }

  if (cmd === 'delete-file') {
    const filePath = rest[0];
    if (!filePath) throw new Error('用法: delete-file <path>');
    let sha = null;
    try {
      const r = await req('GET', '/repos/' + repo + '/contents/' + filePath + '?ref=' + encodeURIComponent(branch));
      sha = r.sha;
    } catch (e) {
      if (e.status !== 404) throw e;
      console.log('那个文件本来就不在。');
      return;
    }
    const r = await req('DELETE', '/repos/' + repo + '/contents/' + filePath, {
      message: flags.message || ('删除 ' + filePath),
      sha: sha,
      branch: branch
    });
    console.log('已删除', filePath);
    return;
  }

  if (cmd === 'delete-repo') {
    const name = rest[0] || repo.split('/')[1];
    await req('DELETE', '/repos/lilia-shound/' + name);
    console.log('已删除', name);
    return;
  }

  console.log(fs.readFileSync(path.join(__dirname, 'gh-admin.js'), 'utf8').split('*/')[0].replace(/^'use strict';\n\/\*\*\n/, ''));
  console.log('可用命令: whoami / create-repo / put / put-text / get / list / enable-pages / pages-status / runs / delete-repo');
}

main().catch((e) => {
  console.error('失败:', e.message);
  if (e.data) console.error(JSON.stringify(e.data).slice(0, 500));
  process.exit(1);
});
