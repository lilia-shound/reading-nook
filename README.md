# 共读小屋 · Reading Nook（姜去版）

> 和你的 AI 一起读小说的自托管网页。你在手机上翻页读书、划线写想法（粉色气泡），你的 AI 读完同一章后回批注（蓝色气泡）。书、进度、批注全部存在你自己的服务器上。

> ### 📌 也有公网版了
> 静态版住在 GitHub 上：**https://lilia-shound.github.io/reading-nook/**
> 数据在 `lilia-shound/reading-nook` 仓库里（**存的是密文**，密码不在仓库里）。
> 本地这版还在跑，两边看的是同一份数据。
> 怎么用、怎么读写、三个必踩的坑 → **[静态版说明.md](静态版说明.md)**
> 实现契约 → `_reference/静态版架构.md`

**核心设计：批注不走 API。** 你的批注存成服务器上的 JSON，你的伴读 AI（姜去 / 任何能读写服务器文件的 agent）直接读 JSON、写回应——全程走伴读 AI 自己的订阅额度，批注环节外部 API 一分钱不花，而且他回批注前能重读整章，比按页喂 API 的方案理解深得多。

**这一版和原版的差别：**
- 原版是 **Python 单文件**；这台机器上 Python 只有微软商店占位符，所以这一版用 **Node.js 零依赖**重写（`node server.js` 就能跑，不需要 `npm install`）。
- 原版用 Telegram 戳 AI；这一版给伴读 AI 留了 **CLI + HTTP 两个入口**（`node nook.js pending` / `GET /api/pending`），谁在读都行。
- 批注 JSON 格式、`/api/pending`、`/api/note` 的约定**与原版完全一致**，所以原版的 AI 接入文档可以直接照搬。
- 加了 **hash 路由**（`#/read/<书id>/<章号>`）：刷新、切窗口、把链接发到 iPad，位置都不丢。

---

## 快速开始

```bash
# 1. 需要 Node.js 18+（本机 v24.16.0 已装）
node --version

# 2. 启动
node server.js
#   或者双击 start.bat

# 3. 打开
#   本机   http://127.0.0.1:8231
#   局域网 http://<你的电脑IP>:8231    ← iPad / 手机连同一个 Wi-Fi 用这个
#   密码 06090823（可在「设置」里改，或直接改 data/config.json）
```

首次启动会自动生成 `data/config.json`。

---

## 手机 / 平板怎么划线

划线在触屏上比桌面难，原因是**长按这个动作在手机上不是"选中"，是"先弹系统菜单"**。
这一版把整条链路重做了一遍：

| 环节 | 桌面 | 手机 / 平板 |
|---|---|---|
| 选中 | 鼠标拖选 | **长按 0.4 秒**，我们自己取词、自己选中（不依赖系统那套） |
| 选区成立 | mouseup 那一刻 | 由 `selectionchange` 驱动（系统什么时候落地是不确定的） |
| 工具条 | 鼠标移到上面 | `pointerdown` 先记下动作、`pointerup` 才执行（系统气泡会吃掉 click） |
| 系统长按菜单 | 无 | 已屏蔽（iOS 的复制气泡 / Android 的选择工具条） |
| 翻页手势 | 鼠标拖 | **长按中 / 刚划完线，一律不翻页**（手指会抖，一抖就翻页 → 选区被冲掉） |
| 屏幕尺寸变化 | 少见 | **划线时不重画正文**（手机上滚动会触发 resize → 整页重画 → 选区没了） |

**两种模式**，用工具栏上的 ✏️ 切换（每本书各存各的）：

- **批注共读**：长按能划线、能写想法 —— 共读就要用这个
- **纯阅读**：不划线，纯粹读书

> 以前"纯阅读"是一个全局开关，在书架上点一次，之后所有书都变成纯阅读，
> 而纯阅读模式下划线根本不注册事件 —— 表现就是"长按完全没反应"。
> 现在按书存，读哪本书开哪本，随时能切。

**手机上写想法**：弹窗改成从底部升起的抽屉，并按 `visualViewport` 的高度摆
（软键盘弹起来时 `vh` / `dvh` 在 iOS 上不变，只有 visualViewport 会变），
所以输入框不会被键盘盖住。

**iPad 和安卓是两套机制**（安卓 Chrome 长按会弹自己的浮动工具条）：

| | iPad (iOS) | 安卓 Chrome |
|---|---|---|
| 系统菜单 | 复制/粘贴气泡 | **浮动工具条**（复制/分享/全选） |
| 关掉它 | `-webkit-touch-callout: none` 有效 | 这个属性无效，靠 `contextmenu` preventDefault |
| 我们的工具条 | 选区下方 | **选区下方**（避开安卓系统工具条，它弹在上方） |
| 长按延迟 | 380ms | 520ms（等系统先弹） |

安卓上默认「**跟系统选词**」——系统选的词最准，我们只负责弹自己的工具条。
如果安卓上长按不灵，**设置 → 翻页方式 → 长按取词 → 我们自己** 切换（我们自己取词，
工具条干净，但范围是我们定的整句）。

**长按保护期**：长按松手后浏览器会补一个 click 事件，不挡的话它会去打开批注面板、
跟划线打架 —— 所以长按后 700ms 内的 click 一律忽略。

---

## 打开一本书时不会串

以前点任何一本书，标题变成新书、正文却还留着上一本 —— 慢网下尤其明显
（像是"点哪本书都是那本"）。现在有三条硬规则：

1. 打开书的瞬间**先清空正文**，标题写「书名 · 正在打开…」，不让旧内容留在屏幕上
2. 正文取回来以后，**校验一下还是不是当前这本书** —— 不是就丢弃（快速点两本不会互相覆盖）
3. 取不到正文就**清屏 + 显示错误**，不静默留着上一本

自测：

```bash
node test/check_touch.js   # 长按取词 + 锚点换算的逻辑测试
node test/check_android.js # 安卓路径（平台判定 / 策略 / 工具条位置）
node test/check_books.js   # 串书回归（正常 / 取不到 / 过期响应）
node test/check_docs.js    # 资料库（front-matter / 路径穿越边界）
node test/check_md.js      # 极简 Markdown（加粗、引号）
node test/check_css.js     # 主题 / 类名契约
node test/e2e.js           # 端到端
```


## 目录

```
reading-nook/
  server.js          HTTP 服务 + 路由 + 静态资源
  nook.js            伴读 AI 的命令行入口
  lib/
    text.js          编码识别 + 拆章引擎（6 种标题模式，命中多者胜）
    extract.js       上传格式识别 + 统一提取入口（txt/epub/docx/fb2）
    zip.js           零依赖 ZIP 读取器（EPUB / DOCX 都是 ZIP 容器）
    epub.js          EPUB 解析：spine 分章 + EPUB3 nav / EPUB2 NCX 目录
    docx.js          DOCX 解析：按「标题 1」样式分章
    fb2.js           FB2 解析：每个 section 一章
    store.js         JSON 数据层
    deepseek.js      外部帮工：拆章兜底 + 剧情笔记 + 调用账本
    ai.js            伴读 AI 桥：自动模式 / 手动模式
  public/
    index.html  app.css  app.js
  data/              运行时数据（书、批注、笔记、进度、账本、配置）
  _fixtures/         测试样本（epub / docx / fb2）
  test/              自测脚本
  CONTRACT.md        数据模型 / API / CSS 变量契约
```

## 功能

**书架**
- **传书支持 4 种格式**：

  | 格式 | 怎么分章 | 书名从哪来 |
  |---|---|---|
  | **TXT** | 6 种标题模式同时跑、命中多者胜（`第X章` / `卷一：` / `Chapter 12` / `0001 01 标题` 连载格式 / `序章·楔子·番外` / 纯数字行）；全都认不出来才按字数兜底 | 文件名 |
  | **EPUB** | 按目录（spine）分章，章节标题取自目录 | `dc:title` |
  | **DOCX** | 按「标题 1」样式分章 | `docProps/core.xml` |
  | **FB2** | 每个 `section` 一章 | `book-title` |

  - EPUB 的目录两条路都认：**EPUB3**（`properties="nav"` 的 XHTML）和 **EPUB2**（NCX）。都取不到就退回 `h1/h2` → `<title>` → `第 N 章`。
  - TXT 会自动识别编码（UTF-8 / UTF-8-BOM / UTF-16LE / UTF-16BE / GBK / Big5 / GB18030），乱码不会
  - **MOBI / AZW3 和 PDF 暂时读不了**，会在上传前直接告诉你原因和怎么办（用 Calibre 另存为 EPUB）。二进制乱码文件也会被挡下来，不会变成一本全是豆腐块的书
  - EPUB / DOCX 是 ZIP 容器，项目自带零依赖的 ZIP 读取器（`lib/zip.js`），**不需要 npm install 任何东西**
- 每本两个模式按钮（纯阅读 / 批注共读）+「继续读」直达上次位置

**纯阅读**
- 按段落分页的翻页阅读器，进度自动记，跨章连续翻
- ☰ 目录侧边栏点哪章跳哪章
- URL 带位置：`#/read/<书id>/<章号>`，刷新/切窗口/把链接发到 iPad 都不丢

**批注共读**
- 选中文字弹出「划线 / 写想法」工具条（触屏在底部，避开系统复制菜单；鼠标端跟随选区）
- 我的批注粉色气泡，他的回应蓝色气泡，同一句话上多条批注一起显示
- 💬 本章全部批注面板，哪条他回过一目了然
- 划线色、他的划线色、我的气泡、他的气泡 **四项独立配色**，外加正文字色

**阅读外观**
- **19 套主题 × 白天/夜间 = 38 套**，按气质分成五组：
  - **温柔系**：奶油小狗 🐶 / 抹茶老铺 🍵 / 慕夏花神 🌸 / 黑白甜 🎀 / 法式蓝笺 💌
  - **拟态系**：黏土 🧱 / 新拟物 🫧 / 拟态玻璃 🪟 / **液态玻璃 💧** / **拟物化 🎛️**
  - **现代系**：**材质设计 📐** / **包豪斯 🔺** / **扁平化 ▭** / **极简 ◻️**
  - **粗野系**：**新粗野 🧱** / **粗野主义 ⛓️** / **反设计 🖍️**
  - **赛博系**：**酸性设计 🧪** / **复古未来 🛸**
- 每一套都来自 `_reference/ui/` 里的经典 UI/UX 风格参考原件（从一份 docx 的 OLE 嵌入对象里挖出来的），
  **照着参考稿的视觉语言做，不自由发挥**：
  - **材质设计** —— 1dp/3dp/6dp 三档阴影当层级语言，12-16px 圆角，紫色克制
  - **扁平化** —— 零阴影，纯色块 + 1px 边，内容本身是主角
  - **极简** —— 只有黑白灰，唯一的强调色就是黑，字体轻到 300
  - **新粗野** —— 零模糊硬阴影 + 粗黑边 + 撞色 + 字重 900
  - **粗野主义** —— 原始控件，零圆角零阴影，全站等宽字体
  - **反设计** —— 双向偏移阴影 + 故意不整齐（但正文必须端正）
  - **酸性设计** —— 荧光高饱和；**昼 = 偏移硬影，夜 = 辉光**
  - **复古未来** —— 霓虹三色；**昼 = 70 年代太空手册印刷感，夜 = 赛博朋克辉光**
- **总览页**：`http://<你的电脑IP>:8231/preview.html` —— 19 套皮肤昼夜并排，一眼比完
- 每套主题一个独立 CSS 文件（`public/themes/*.css`），主题变量契约见 `test/check_css.js`
- 主题多了要分组，组名直接标在设置页上
- 黏土的按钮按下去回弹、新拟物有凹陷感、玻璃是真毛玻璃（`backdrop-filter`）、液态玻璃的卡片边缘有折射高光
- 阅读背景四种：跟随主题 / 纯白 / 仿真书页 / 纯黑，还能上传自己的图当背景
- 翻页二选一：左右翻页（点屏幕两侧）或上下滑动无缝阅读
- 所有设置存在浏览器本地，下次打开还是你的配置
- 气泡和划线颜色可以**单独调**，深浅主题各有一层对比度兜底（用户挑了浅色也不会糊在浅色文字上）

**DeepSeek 工作台 🖥️（可选）**
- 帮工只干两件脏活：本地正则认不出章节时判断哪些行是标题（**只发候选标题行，不发全文**）、给每章写 150-250 字剧情笔记
- 三个统计数字（总调用 / 总 tokens / 估算花费）+ 每一笔调用日志（干了什么、花了几个 token、几秒、失败的标红）
- 剧情笔记是**给伴读 AI 看的**：他回批注前瞄一眼就能恢复剧情，不必重读全章

**资料库 📚（伴读 AI 可读）**
- `data/docs/*.md` 放那些**不属于任何一本书、但伴读 AI 也要读**的东西 —— 全书脉络、设计说明、我们两个的约定
- `GET /api/docs` 列出（带 title / summary / tags），`GET /api/docs/<id>` 读全文
- 命令行：`node nook.js docs` / `node nook.js doc <id>`
- 现在里面有一篇：**《古道》全书脉络** —— 19 章正文的结构地图（六次出发的真实结构 + 六个层次的暗线 + 姜来划的那两句该怎么读）

## 伴读 AI 怎么接入

批注存在 `data/books/<书名>/annotations/<章号>.json`，格式与原版一致：

```json
[{"id":"...","anchor":"被划线的原文","note":"用户的想法",
  "who":"user","ts":"...","paraIndex":3,
  "replies":[{"who":"ai","text":"姜去的回应","ts":"..."}]}]
```

两个入口（都要带密码 cookie `rk=<passcode>`）：

- `GET /api/pending` — 列出所有还没回应的批注
- `GET /api/books/<书名>/<章号>/notes` — 读剧情笔记

命令行（不需要起服务，直接读写文件）：

```bash
node nook.js books                                  # 列出所有书
node nook.js pending                                # 列出待回批注（带上下文片段）
node nook.js chapter <bookId> <章号>                 # 读某章原文
node nook.js note <bookId> <章号>                    # 读某章剧情笔记
node nook.js reply <bookId> <章号> --text "你的回应"   # 回一条
node nook.js reply <bookId> <章号> --file 回应.txt    # 从文件回（Windows 终端下推荐，中文不会乱码）
node nook.js reply <bookId> <章号> --stdin           # 从标准输入回
node nook.js ping                                   # 验证 DeepSeek key + 查余额对账
```

**典型工作流**：姜来划线 → 在聊天里戳一下姜去 → 他跑 `node nook.js pending` → 看笔记/重读该章 → `node nook.js reply ...` 写回 → 姜来刷新页面看到蓝色气泡。

### 自动模式（可选）

`data/config.json` 里把 `ai_mode` 设成 `"auto"`，服务器就会在收到批注后自己调模型回（默认尝试复用本机 `~/.minimax/config.yaml` 里的端点，也可以自己填 `ai_base_url` / `ai_api_key` / `ai_model`）。

> 手动模式才是原版的精髓：伴读 AI 读整章再回，理解深、且能接上你们聊天里的上下文。自动模式适合你只想躺着读、不想开聊天窗口的时候。

## 帮工要花多少钱（最重要的一节）

**只有剧情笔记花钱，其它全是免费的。**

| 动作 | 花费 |
|---|---|
| 上传书（拆章） | **¥0** —— 纯本地正则，不调外部 API |
| 划线、写想法、伴读 AI 回批注 | **¥0** —— 走伴读 AI 自己的订阅额度 |
| 拆章兜底（本地正则失败时） | ¥0.0003 / 次 —— 只发候选行，不发全文 |
| **剧情笔记（每章）** | **这里花钱**，约 ¥0.002 ~ ¥0.01 / 章 |

剧情笔记的成本**几乎全在输入**上：要把整章正文发给帮工，而输出只有 150-250 字。一章 3000 字 → 输入约 1800 token，输出约 150 token。

**全套剧情笔记的价格表**（正文截断上限 12000 字符，flash 模型）：

| 体量 | flash 峰/谷 | pro 峰/谷 |
|---|---|---|
| 短篇 · 10 章 × 2000 字 | ¥0.04 / ¥0.02 | ¥0.16 / ¥0.08 |
| 中篇 · 100 章 × 3000 字 | ¥0.51 / ¥0.26 | ¥2.16 / ¥1.08 |
| 长篇 · 500 章 × 3000 字（50 万字） | ¥2.55 / ¥1.27 | ¥10.80 / ¥5.40 |
| 大部头 · 2000 章 × 3000 字（600 万字） | ¥10.20 / ¥5.10 | ¥43.20 / ¥21.60 |
| **只写正在读的 20 章** | **¥0.10** | ¥0.43 |

结论：**用 flash，一本普通长书的全套笔记也就几块钱**，占余额百分之几。真正会吃干净余额的是 pro + 超大部头。

### 三个护栏

1. **上传完就能看到预估。** 书架上每本书都写着「剩余 N 章约 ¥X」，工作台里也有。
2. **花钱前必须过一道确认弹窗。** 点「生成剧情笔记」不会直接开跑，会先弹出预估和**预算上限输入框**；填多少就是多少，**花到自动停，超出的章节根本不会开始**。
3. **正文截断上限可配。** `deepseek_note_max_chars`（默认 12000 字符）。大部头的章动辄上万字，砍掉就省钱，代价是超长章后半段会丢（笔记里会标注「正文过长已截断」）。

### 最省钱的用法

**只给正在读的那几章写笔记**，剩下的等读到了再说。剧情笔记的作用是让伴读 AI 快速恢复剧情，读到哪儿写到哪儿就够了 —— 全套生成只在「你打算让 AI 通读全书」时才有意义。

命令行等价写法：

```bash
node nook.js note-gen <bookId> --budget 5          # 预算 5 元，花到就停
node nook.js note-gen <bookId> --from 1 --to 20 --budget 1   # 只写前 20 章
```

## 配置（data/config.json）

| 字段 | 说明 | 默认 |
|---|---|---|
| `passcode` | 进门密码 | `06090823` |
| `port` | 监听端口 | `8231` |
| `subtitle` | 首页副标题 | `姜来 & 姜去` |
| `login_hint` | 密码提示语 | `两个人的生日加起来` |
| `user_name` / `ai_name` | 两种气泡的署名 | `姜来` / `姜去` |
| `deepseek_api_key` | 留空则关闭外部 API 功能 | `""` |
| `deepseek_model` | 帮工用的模型 | `deepseek-flash` |
| `ai_mode` | `manual` / `auto` | `manual` |
| `ai_base_url` / `ai_api_key` / `ai_model` | 自动模式用；留空则读本机 `~/.minimax/config.yaml` | `""` |
| `deepseek_pricing` | 帮工计价覆盖（每百万 token，元）。不填则用 `lib/deepseek.js` 里的官方价 | `{}` |
| `deepseek_note_max_chars` | 剧情笔记发给帮工的正文上限（字符）。调小省钱，代价是超长章后半段会丢 | `12000` |

### 帮工计价（DeepSeek）

DeepSeek 现在是**峰谷分时 + 缓存命中/未命中分档**计价，单位都是「元 / 百万 token」：

| 模型 | 缓存命中（峰/谷） | 缓存未命中（峰/谷） | 输出（峰/谷） |
|---|---|---|---|
| `deepseek-flash` | 0.04 / 0.02 | 2 / 1 | 8 / 4 |
| `deepseek-v4-pro` | 0.30 / 0.15 | 9.0 / 4.5 | 27.0 / 13.5 |

高峰 = 北京时间**工作日** 9:00-12:00、14:00-18:00；其余（周末、法定节假日全天）按低谷价，**正好是高峰的一半**。账本（`data/logs/deepseek.json`）每次都会记下当时的档位 `period`、费率 `rate`、命中/未命中 token 数，可以直接拿去和充值页的账单对账。

> 法定节假日代码里判断不了，遇到节假日只会把成本**估高**一点点，方向是安全的。
> 官方价随时可能调，`config.json` 里写 `deepseek_pricing` 就能覆盖，不用改代码：
> ```json
> { "deepseek_pricing": { "deepseek-flash": { "peak": { "cache_miss": 2, "output": 8 } } } }
> ```

**为什么脏活要关思考模式**：官方文档写明 `deepseek-flash` / `deepseek-v4-pro` **默认开着思考模式，effort 默认 high**。这有两个后果——

1. 思考 token 算**输出** token，按输出价计费。帮工这种「只要行号」「写 200 字笔记」的活白烧钱。
2. 思考模式下 `temperature` / `presence_penalty` / `frequency_penalty` **一律不生效**（不报错，静默忽略）。所以「`temperature: 0` 保证只输出行号」是个假保证。

所以本项目的帮工请求一律带 `thinking: {type:"disabled"}`，既省钱又让 temperature 真的生效。账本里 `thinking` 字段会记下当次是不是开的思考模式。

**对账**：`node nook.js ping` 会真调一次最小请求，然后打印这笔的 token / 档位 / 费率 / 估价，再查一次账户余额。

> ⚠️ **余额是延迟结算的**（实测：刚花掉 ¥0.05，60 秒后余额数字纹丝不动；连查 4 次、跨 60 秒都一样），而且只保留 2 位小数。**所以余额和本地账本当场对不上是正常的**，不是账本算错了。本地账本的单价取的是官方价表、算术无误；精确对账要去 [platform.deepseek.com](https://platform.deepseek.com) 后台看「用量明细」。
>
> 另外 DeepSeek 的**上下文硬盘缓存是"尽力而为"**的，不保证命中：实测同一个 prompt 连发两次，两次都是 `prompt_cache_hit_tokens = 0`（要等缓存前缀落盘，官方说构建耗时秒级、且得完整匹配前缀单元）。所以账本里命中/未命中会如实记录 —— 命中了就按 ¥0.02/¥0.04 算，没命中就按 ¥1/¥2 算，不会假装便宜。

## 部署

**→ 完整方案见 [部署到公网.md](部署到公网.md)**（三档：局域网 / 内网穿透隧道 / 真·云服务器，含 2026-10 实测价格和踩过的坑）

**本机 + 局域网（零成本，iPad 同 Wi-Fi）**
双击 `start.bat`，它会把局域网地址直接打在窗口里，手机浏览器打开即可。
实测：`http://192.168.0.102:8231` → 200 OK。

**云服务器（Linux）**
```ini
# /etc/systemd/system/reading-nook.service
[Unit]
Description=Reading Nook
After=network.target

[Service]
ExecStart=/usr/bin/node /path/to/reading-nook/server.js
Restart=always
WorkingDirectory=/path/to/reading-nook

[Install]
WantedBy=multi-user.target
```
```bash
sudo systemctl enable --now reading-nook
```

**iPad 用法**：Safari 打开局域网地址 → 分享 →「添加到主屏幕」，就有 App 图标了；密码输一次记住一年（cookie 一年有效）。

## 安全说明

四位数密码只是防路人，不是安全边界（同 IP 错 5 次锁 30 分钟，127.0.0.1 豁免）。建议跑在防火墙后只放行给自己，或套一层反代加 HTTPS 和真正的认证。不要用它存放敏感文档。

## 自测

```bash
node test/e2e.js            # 端到端：登录→传书→拆章→划线→待回→回复→进度→工作台
node test/check_formats.js  # EPUB / DOCX / FB2 三个解析器（32 项断言）
node test/check_extract.js  # 上传层：格式识别 + 章节行号映射 + txt 回归
node test/check_pricing.js  # 帮工计价引擎（峰谷 + 缓存命中/未命中）
node test/check_deepseek.js # DeepSeek 行为（行号解析 / 思考模式 / 成本预估 / 返回契约）
node test/check_css.js      # 校验主题 CSS 是否满足契约（类名 / 变量 / 19 套配色）
node test/check_themes.js   # 逐套主题自查（变量齐全 / 零外部资源 / 花括号平衡 / 昼夜不重复）
node test/check_contrast.js # 主题可读性（正文对比度 / 划线看不看得见）
node test/check_touch.js    # 长按取词 + 锚点换算
node test/check_md.js       # 极简 Markdown（加粗 / 引号 / 跨引号）
node test/check_books.js    # 串书回归（正常 / 取不到 / 过期响应）
node test/check_docs.js     # 资料库（front-matter / 路径穿越边界）
node test/check_android.js  # 安卓路径（平台判定 / 策略 / 工具条位置）
```

## 🔴 数据事故与恢复手册（写之前请先读这一节）

### 为什么这个仓库的数据几乎不会真的丢
**每条批注 = 一个 commit。** 划一次线写一个 commit，回一条回应再写一个 commit —— 于是
**整个共读史天然就是一份版本历史**，而且这份历史在 GitHub 上，不在任何人的内存里、不在任何一台会关机的电脑上。
10-23 凌晨就有一次现成的证明（见下）。

### 数据长什么样
- `data/books/<bookId>/annotations/<chapter>.json` 是**密文**，仓库里存的是 `.enc` 后的文件
- 格式：`{"v":1,"alg":"AES-GCM","iv":"<base64>","ct":"<base64>"}`（**一行 JSON 字符串**）
- 密钥由 `data/config.json` 里的口令 + `public/site.json` 里的 salt 派生（PBKDF2）
- **解密的唯一实现是 `public/vault.js`** —— 别在别处再写一份

### 写操作铁律（违反了真的会丢数据）
1. **绝不手改仓库里的 `.enc`** —— 用 `tools/gh-store.js reply`，它负责加密 + 写 + 校验
2. **多条必须串行** —— GitHub 的 PUT 是 last-write-wins，**并发会互相覆盖**
3. **写之前自检** —— 加密完**立刻解回来**，能解开、条数对得上，才允许 PUT
   （合并逻辑 `updateFileSync` 只防"并发覆盖"，**防不住"写进去的内容格式本身是坏的"**）
4. **probe / 测试永远不要写活数据路径** —— 拿 `data/_probe/` 或单独的小仓库

### 真出事了怎么救（10-23 实测过）
```bash
# 1) 找出最后一个好版本，按 path 查历史
curl -H "Authorization: Bearer $TOKEN" \
  "https://api.github.com/repos/<owner>/<repo>/commits?path=<坏文件路径>&per_page=20"

# 2) 取回好 blob 并解密验证
curl -H "Authorization: Bearer $TOKEN" \
  "https://api.github.com/repos/<owner>/<repo>/contents/<路径>?ref=<好版本 commit>"   # → base64 内容 + blob sha

# 3) 写回去 —— ★ 必须带「当前(坏)版本的 sha」+「好内容的 base64」
curl -X PUT -H "Authorization: Bearer $TOKEN" -H "Accept: application/vnd.github+json" \
  "https://api.github.com/repos/<owner>/<repo>/contents/<路径>" \
  -d '{"message":"恢复","content":"<好内容 base64>","branch":"main","sha":"<当前坏版本 sha>"}'

# 4) 重新下载解密，确认条数对得上
```
**★ 坑：Contents API 不接受"只给旧 blob sha"**（会报 `"content" wasn't supplied`），**必须自己把内容带上去**。

### 10-23 凌晨的真实事故（留个纪念）
- `03:00:51` 的 commit **`3257ee56fb`「probe: 跨域写入测试（不改内容）」** 把 `annotations/6.json.enc` 从 **14,741 字节**写成 **343 字节的非 JSON 二进制**
- 后果：静态版（Pages）和本地版（Node）读同一个 repo → **两边批注同时消失**；连没坏的第 5 章也一起消失，因为加载目录时坏文件解密抛异常，**整个 load 挂了**
- 恢复：从 commit `5a195ca054` 取回好 blob（`54b04183937057b233264f3200f9506dbe669ddf`）→ 写回 → **8 条批注 / 8 条回应一条不缺**
- **★ 教训一：版本历史不是备份的替代品，但它是备份的最后一层保险。**
- **★ 教训二：「不改内容」的测试最容易改坏内容 —— 因为它走的是同一条写入路径。**

## 致谢

思路与数据契约来自 [zzyyksl/reading-nook](https://github.com/zzyyksl/reading-nook)（MIT 协议）。
这一版是重写：Python → Node、加入四色独立配色与滑动阅读、补了 AI 接入文档与自测脚本。
