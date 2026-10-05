# dsh-camofox-browser

把 [camofox-browser](https://github.com/jo-inc/camofox-browser)（基于 [Camoufox](https://camoufox.com) 的反检测浏览器）接成 **DSH 原生工具**。

一个工具 `camofox`，一个被托管的本地服务。DSH 不需要常驻浏览器进程 —— 第一次调用工具时插件才把后端拉起来，插件卸载时带走。

```
DSH ──调用 camofox 工具──▶ 插件（宿主半边）
                              │  懒启动 / 回收
                              ▼
                        camofox-browser REST 服务 :9377
                              │
                              ▼
                        Camoufox（Firefox 分支，C++ 层指纹伪装）
```

## 为什么不是「再包一层 Playwright」

camofox-browser 已经把引擎服务化，并且定义了 11 个工具的权威契约（`mcp/lib/tool-contracts.mjs`，MCP server 与 OpenClaw 插件共用同一份）。本插件不重写那套契约，只做三件 DSH 特有的事：

1. **翻译成一个 action-based 工具**，而不是往工具表里塞 11 个名字（DSH 的工具描述全部进 system prompt，按名字膨胀是真实成本）；
2. **托管服务生命周期** —— 懒启动 + 卸载回收，DSH 启动时不常驻浏览器服务；
3. **接管两类 DSH 语义的收尾** —— 截图落盘而不是塞进上下文、失败时把服务日志一起带出来。

## 安装

### 一键（推荐）

```powershell
git clone https://github.com/lemonhall/dsh-camofox-browser E:\development\dsh-camofox-browser
cd E:\development\dsh-camofox-browser
.\install.ps1 -Proxy http://127.0.0.1:7897
```

`install.ps1` 是**幂等**的，依次做六件事：检查 Node ≥ 22 → clone camofox-browser → 装依赖（跳过会触发 node-gyp 编译的 `better-sqlite3`）→ 下载 Camoufox 引擎（约 500MB）→ 注册 DSH 插件 → 跑自测。

| 参数 | 用途 |
|---|---|
| `-Proxy http://127.0.0.1:7897` | 下载引擎走代理（国内基本必填） |
| `-SkipEngine` | 后端已装好、只想注册插件 |
| `-SkipPlugin` | 只装后端，不碰 DSH |
| `-ServerDir <路径>` | 换后端落地目录 |

### 手动安装

四步。每一步都有坑，坑写在对应位置。

**第 1 步：camofox-browser 本体**

```powershell
git clone https://github.com/jo-inc/camofox-browser E:\development\camofox-browser
cd E:\development\camofox-browser
npm install --omit=dev --ignore-scripts
```

> `--ignore-scripts` 是**故意的**：`better-sqlite3` 只有单元测试引用它（`tests/unit/nativeBinding.test.js`），生产代码零引用，而它在 Windows 上会触发 node-gyp 编译。跳过它不影响服务。
>
> 如果你已经撞上 node-gyp 报错 —— 那是这条依赖的锅，不是你的环境。

**第 2 步：Camoufox 引擎（约 500MB）**

```powershell
cd E:\development\camofox-browser
$env:HTTPS_PROXY='http://127.0.0.1:7897'   # 按需；要能到 GitHub
$env:NODE_USE_ENV_PROXY='1'                 # 关键：camoufox-js 用 fetch，默认不读代理变量
node lib/camoufox-download.js
```

> **`NODE_USE_ENV_PROXY=1` 不能省**。camoufox-js 用 Node 内置 `fetch`（undici），它**默认忽略** `HTTP_PROXY`/`HTTPS_PROXY`，少了这个变量就是静默超时。
>
> 引擎默认装到 `%LOCALAPPDATA%\camoufox\camoufox\Cache`。**建议就用默认位置**：它的安装目录变量是 `CAMOUFOX_INSTALL_DIR`（带 U），和 camofox-browser 自己的 `CAMOFOX_` 前缀不是一套 —— 一旦漏设，camoufox-js 会当作「没装」然后**静默重下 500MB**。

**第 3 步：注册 DSH 插件**

```powershell
dsh plugin --profile desktop add link:E:\development\dsh-camofox-browser
```

装完宿主半边**热生效**，本会话工具表立刻多出 `camofox`，不用重启应用。

**第 4 步：验证**

```
camofox {action:"open", url:"https://example.com"}
```

首次调用会顺带把后端服务拉起来（冷启动 3-8 秒）。返回 `tabId` 就是通了。

## 工具

单个工具 `camofox`，15 个 action：

| action | 作用 |
|---|---|
| `open` | 开标签页，返回 `tabId` |
| `snapshot` | 可交互元素树，元素带 `e1`/`e2` 引用（大页面用 `offset` 分页） |
| `text` | **取正文纯文本** —— 读文章、查资料最省 token |
| `click` / `type` / `press` | 用 `ref`（如 `e1`）或 `selector` 交互 |
| `navigate` | 跳 URL，或用搜索宏（`@google_search` 等 14 个） |
| `scroll` | 滚动 |
| `screenshot` | 截图**存盘**并返回路径（不进上下文；要看图再用 `read_image`） |
| `links` / `evaluate` | 取页面链接 / 在页面里执行 JS |
| `tabs` / `close` / `reset` | 列出 / 关闭标签页；清空会话（cookie + localStorage） |
| `transcript` | 抓 YouTube 字幕（走 yt-dlp，无需 API key） |

典型流程：

```
camofox {action:"open", url:"https://example.com"}      → tabId
camofox {action:"snapshot", tabId:"..."}                → [link "Learn more" e1]
camofox {action:"click", tabId:"...", ref:"e1"}
camofox {action:"text", tabId:"..."}                    → 正文
```

## 配置

改 `cordis.patch.yml` 里的 `config`，或在 profile 的 `cordis.patch.yml` 里按 `id: dsh-camofox-browser` 覆盖。

| 键 | 默认 | 说明 |
|---|---|---|
| `baseUrl` | `http://127.0.0.1:9377` | 后端地址 |
| `serverDir` | `E:\development\camofox-browser` | 源码目录（要有 `server.js`） |
| `installDir` | 空 | Camoufox 引擎目录；空 = 用默认位置（**推荐留空**） |
| `tempDir` | `E:\caches\tmp` | 引擎解压的临时目录（默认会占 C 盘约 600MB 峰值） |
| `userId` | `dsh` | 会话所有者，决定 cookie/localStorage 分区 |
| `autoStart` | `true` | 第一次调用时自动拉起服务 |
| `screenshotDir` | `<仓库>/shots` | 截图落盘目录 |
| `maxChars` | `40000` | 单次回给模型的文本上限 |
| `proxy` | `enabled:false` | 浏览器代理；打开后 Camoufox 用 GeoIP 按出口 IP 对齐时区/语言 |

## 实测（2026-10-05，Windows 11 / 直连 / 无代理）

**被动指纹检测过了。** [bot.sannysoft.com](https://bot.sannysoft.com/)：

| 检测项 | 结果 |
|---|---|
| WebDriver | `missing (passed)` |
| WebDriver Advanced | `passed` |
| Plugins Length | `5` |
| Permissions | `prompt` |
| WebGL Vendor | `Google Inc. (AMD)` ← 被伪装 |
| WebGL Renderer | `ANGLE (AMD, Radeon HD 3200 ...)` ← 被伪装 |
| screen | `3840x1080` ← 被伪装 |

`navigator.webdriver` 缺失、WebGL 与屏幕参数在 JS 拿到之前就已替换 —— 这正是 C++ 层伪装与 JS shim 的区别。

**主动挑战没过。** [nowsecure.nl](https://nowsecure.nl/) 停在 Cloudflare 的交互式验证（"Verify you are human" 复选框）。这类挑战考的是**行为**不是指纹，指纹再干净也代替不了像人的操作节奏。需要过这种页面，用 camofox-browser 的 VNC 模式人工过一次，再导出登录态给 agent 复用。

**Google 实际能用，但项目的成功判定会误报。** 直接访问 `https://www.google.com/search?q=...` 能拿到真实结果页（标题、条目、相关问题都在），但 camofox 返回 `googleResultsAvailable: false`、`ok: false`；后果是 `@google_search` 宏会**白白回退**到 DuckDuckGo（返回里带 `fallbackFrom: "google"`）。页面没问题，是它的结果解析器不认 `google.com.hk`／新版页面结构。

**YouTube 字幕**依赖 yt-dlp；没装会退化到较慢的浏览器内拦截方式。没有字幕的视频会如实返回 `No captions available`。

## 已知坑

- **`CAMOUFOX_INSTALL_DIR` vs `CAMOFOX_INSTALL_DIR`**：前者（带 U）是 camoufox-js 的，后者是 camofox-browser 的。写错不报错，直接重下 500MB。
- **`POST /tabs` 必须带 `sessionKey`**：README 的示例只给了 `userId`，照抄会得到 `{"error":"userId and sessionKey required"}`。
- **`npm install` 会卡**：这台机器上 npm 全局 `proxy` 指向本地代理，连国内镜像也绕一圈（`npm ping` 9.87s vs 直连 0.53s）；改用 `--ignore-scripts` 并跳过 devDependencies（`openclaw` + jest + typescript 与跑服务无关）。
- **截图不要塞进上下文**：base64 一张 1280×983 的 PNG 约 900KB。本插件一律落盘。

## License

MIT
