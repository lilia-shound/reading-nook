# 共读小屋 · API 路由表

> 给伴读 AI（云端那位）用。**全表** —— 你上次问的就是这个。
> 写的是 2026-10-22 实际跑着的代码，不是设计稿。

---

## 0. 基址与认证

```
基址（局域网）  http://192.168.2.7:8231        ← 只在家里能用
基址（公网）    <隧道地址>                     ← 隧道地址会变，见 data/tunnel.json
```

**所有 `/api/*` 都要带 cookie，除了 `/api/health` 和 `/api/login`：**

```bash
-H 'Cookie: rk=06090823'
```

这个 cookie **就是密码本身**（0609 + 0823，两个人的生日相加）。
同一个 IP 连着错 5 次会锁 30 分钟 —— 别试错。

## 1. 全表

| 方法 | 路径 | 请求体 | 返回 | 备注 |
|---|---|---|---|---|
| GET | `/api/health` | — | `{ok, time, login_hint}` | **免登录**。拿密码提示语用 |
| POST | `/api/login` | `{passcode}` | `{ok, user_name, ai_name, subtitle, login_hint}` + `Set-Cookie` | **免登录**。错密码返回 401 |
| GET | `/api/library` | — | `{books:[…], user_name, ai_name}` | 书架。books 里是**缩略版**（没有 chapters） |
| POST | `/api/books` | 原始文件体 + `X-Filename` 头 | `{book:{id,title,chapterCount,format}}` | **上传书**（txt/epub/docx/fb2）。静态版没有这个 |
| GET | `/api/books/{id}` | — | `{book}` | **完整书对象（含 chapters 数组）** |
| DELETE | `/api/books/{id}` | — | `{ok:true}` | 删书 |
| GET | `/api/books/{id}/chapter/{n}` | — | `{index, title, paragraphs[], totalChapters}` | 章节正文。paragraphs 是切好的段 |
| GET | `/api/books/{id}/notes/{n}` | — | `{chapter, title, text}` | **这一章的剧情笔记**（单独取） |
| GET | `/api/books/{id}/annotations/{n}` | — | `{annotations:[…]}` | **这一章的全部批注**（回过的也在里面） |
| POST | `/api/books/{id}/annotations/{n}` | `{anchor, note, paraIndex}` | `{annotation}` | 划线 / 写想法 |
| GET | `/api/books/{id}/progress` | — | `{progress}` | 阅读进度 |
| POST | `/api/books/{id}/progress` | `{chapter, paraIndex, ratio}` | `{progress}` | 记进度 |
| POST | `/api/books/{id}/resplit` | — | `{ok, chapterCount}` | 用 AI 重新拆章（要 DeepSeek key） |
| GET | `/api/docs` | — | `{docs:[{id,title,summary,tags,chars}]}` | 资料库列表 |
| GET | `/api/docs/{id}` | — | `{id,title,summary,tags,body,chars}` | 资料库全文 |
| GET | `/api/pending` | — | `{items:[…]}` | **待回队列**（见下） |
| GET | `/api/ping` | — | `{ts, pending}` | 「有没有新动静」。ts 变了 = 有人回过批注 |
| POST | `/api/ai/reply` | `{bookId, chapter, anchorId, text}` | `{ok, saved:{annotationId, reply}}` | **回批注**（你用这个） |
| POST | `/api/ai/auto` | `{bookId, chapter, annotationId}` | `{ok, text}` | 服务器自己调 LLM 回批注 |
| GET | `/api/ai/endpoint` | — | `{mode, hasBase, hasKey, model, base}` | 看 AI 端点配了没 |
| GET | `/api/workbench` | — | `{stats, logs, pricing, books}` | 工作台统计 |
| POST | `/api/tasks/notes` | `{bookId, maxCost}` | — | 生成剧情笔记（花钱，要先看数字） |
| GET | `/api/formats` | — | `{formats:[…]}` | 支持哪些格式 |
| GET | `/api/settings` | — | `{passcode, port, subtitle, login_hint, user_name, ai_name, ai_mode, deepseek_model, hasDeepseekKey}` | |
| POST | `/api/settings` | 同上字段 | 同上 | 改设置 |

## 2. 你上次问的三个

### 2.1 「已回批注的列表」→ `GET /api/books/{bookId}/annotations/{chapter}`

**你后来自己找到了，就是这个。** ✅

```bash
curl -H 'Cookie: rk=06090823' <基址>/api/books/b_mvhx4hgqqddcvb/annotations/5
```

返回该章**全部**批注（回过的也在里面）：

```json
{
  "annotations": [
    {
      "id": "a_mvi458bebc363u",
      "anchor": "小路是一条灰色雪巷",
      "note": "",
      "who": "user",
      "paraIndex": 12,
      "ts": "2026-10-21T…",
      "replies": [
        { "who": "ai", "text": "你划的是这一句，我盯了它好一会儿。……", "ts": "…" }
      ]
    }
  ]
}
```

**`id` 就是 anchorId** —— 回批注时原样传。

> ⚠️ **没有「只列已回过的」这个端点**。上面的接口是全量，
> 要自己看 `replies` 数组有没有内容来分。
> 你试过的 `/api/annotations`、`/api/annos`、`/api/marks` —— **这三个本来就不存在**，404 是对的。

### 2.2 「剧情笔记单独取」→ `GET /api/books/{bookId}/notes/{chapter}`

```bash
curl -H 'Cookie: rk=06090823' <基址>/api/books/b_mvhx4hgqqddcvb/notes/5
```

```json
{ "chapter": 5, "title": "第5章 ……", "text": "这一章的剧情笔记正文……" }
```

《古道》有 19 份（第 4–22 章）。**回批注前先读它**，能一眼想起这一章发生了什么。

### 2.3 「待回队列」→ `GET /api/pending`

```bash
curl -H 'Cookie: rk=06090823' <基址>/api/pending
```

```json
{
  "items": [
    {
      "bookId": "b_mvhx4hgqqddcvb",
      "bookTitle": "古道",
      "chapter": 5,
      "chapterTitle": "第5章 ……",
      "annotationId": "a_mvhyfuroua9xxk",
      "anchor": "她划的那句原文",
      "note": "她写的想法",
      "ts": "…",
      "context": "……她划的那句前后 400 字……",
      "plotNote": "……这一章的剧情笔记全文……"
    }
  ]
}
```

> **`context` 和 `plotNote` 是新加的**（2026-10-22 下午）。
> 我之前那封「接口速查」里说这两个字段本来就有 —— **那是错的**，
> 以前只有 CLI（`nook.js pending`）有，HTTP 这边漏了。现在补上了。

## 3. 常用 id 对照

| | |
|---|---|
| 《古道》 bookId | `b_mvhx4hgqqddcvb`（24 章，19 份剧情笔记） |
| 《示例书-铁轨与黑猫》 bookId | `b_mvhr8d7llh963h` |
| 「万物都在书写自己的历史」（题眼） | `a_mvhyfuroua9xxk` |
| 「小路是一条灰色雪巷」 | `a_mvi458bebc363u` |
| 「山鹑的足迹好似箭头」 | `a_mvi4dj0nkqaj3l` |

## 4. 回批注的标准动作

```bash
# 1. 看有什么等你回（带上下文和剧情笔记）
curl -H 'Cookie: rk=06090823' <基址>/api/pending

# 2. 回一条 —— anchorId 原样传 pending 里的 annotationId
curl -X POST -H 'Cookie: rk=06090823' -H 'Content-Type: application/json' \
  -d '{"bookId":"b_mvhx4hgqqddcvb","chapter":5,"anchorId":"a_mvi458bebc363u","text":"你的回话"}' \
  <基址>/api/ai/reply

# 3. 验证：读回这一章，看 replies 里有没有你的话
curl -H 'Cookie: rk=06090823' <基址>/api/books/b_mvhx4hgqqddcvb/annotations/5
```

**⚠️ 坑（你上次担心得对）：`anchorId` 传错会静默回错地方。**
`lib/store.js` 的 `addReply`：传了 id 就 `find(id)`，找不到 → 退到「第一条没被回过的」→ 再退到「最后一条」，**全程不报错**。
所以第 3 步的验证别省。

**命令行版**（在她电脑上，中文必须走 `--file`）：

```bash
node nook.js pending
node nook.js reply <bookId> <ch> --anno <annoId> --file 回应.txt
```

## 5. 静态版（GitHub Pages）那边的说明

`https://lilia-shound.github.io/reading-nook/` 是**浏览器**用的，
它不暴露上面这些 HTTP 接口 —— 浏览器直接读 GitHub 仓库（密文）。
**你走隧道这条路就行**，那台电脑现在用的也是同一个仓库当数据源，
所以你回的话，她手机上照样看得到。

仓库：`lilia-shound/reading-nook`（公开，但 `data/` 下全是密文）
配套文档：`静态版说明.md`（密文方案）、`_reference/静态版架构.md`（实现契约）
