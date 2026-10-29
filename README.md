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

单个工具 `camofox`，**31 个 action**：

| action | 作用 |
|---|---|
| `open` | 开标签页，返回 `tabId`（可传 `pin:true` 锁定防回收；`reuseTab:true` 复用同组内 URL 相同的标签页，默认新开） |
| `snapshot` | 可交互元素树，元素带 `e1`/`e2` 引用（大页面用 `offset` 分页；被 maxChars 截断时给出按实际展示量算的续读偏移，不会跳丢内容） |
| `text` | **取正文纯文本** —— 读文章、查资料最省 token |
| `click` / `type` / `press` | 用 `ref`（如 `e1`）或 `selector` 交互；三者执行后**自动探测新标签页并追加提醒**（含 tabId/URL/标题） |
| `navigate` | 跳 URL，或用搜索宏（`@google_search` 等 14 个） |
| `scroll` | 滚动（注入原生 `window.scrollBy`，不等 networkidle；可用 `timeoutMs` 控预算，默认 5000ms） |
| `screenshot` | 截图**存盘**并返回路径（不进上下文；`screenshotDir` 留空自动回退 `<cwd>/.camofox-shots`，不再抛 ENOENT） |
| `links` / `evaluate` | 取页面链接 / 在页面里执行 JS（`timeoutMs` 可放宽到 300000ms，长任务不必反复重试） |
| `tabs` / `close` / `reset` | 列出 / 关闭标签页；清空会话（cookie + localStorage） |
| `transcript` | 抓 YouTube 字幕：**yt-dlp 优先，未装则自动降级浏览器兜底**（较慢仍可用） |
| `pin` | 锁定/解锁标签页（免疫空闲回收）；后端无该路由时返回可读错误而非整页 HTML |
| `status` | **查服务健康度、后端能力**（pin / yt-dlp / interactive 模式）与托管归属 |
| `wait` | 等页面网络空闲（SPA 水合首选，替代反复 evaluate 轮询） |
| `refresh` / `back` / `forward` | 刷新 / 后退 / 前进（`refresh` 等 `domcontentloaded`，中断时自动降级 `location.reload()`） |
| `upload` | 上传文件到页面 `<input type="file">`（支持 `ref`/`selector`/自动探测已有输入框）；文件须位于 `~/.camofox/uploads`，目录缺失会自动创建 |
| `console` | 取控制台日志与页面未捕获错误（`types` 过滤级别，`clear` 读后清空） |
| `network` | 查网络 HTTP 请求与响应（`resourceTypes` / `status` 过滤，`clear` 读后清空） |
| `set_cookies` | **直接注入 Cookies**（对象数组或 `"a=1; b=2"` + `domain`），免扫码/免短信登录 |
| `trace` | **动作级监听**：`subAction` 执行前后自动清空并截获该动作触发的 XHR/fetch 与控制台日志，一次调用拿三段结果 |
| `drag` | **原生可信拖拽**：起点用 `start` 坐标或 `handle`（快照 ref / 选择器），终点用 `end` 坐标或 `deltaX`/`deltaY`；`easing`/`jitterPx`/`overshootPx` 控制拟人轨迹 —— **拖滑块验证**主用它。过冲先按视口 4px 钳制，再按可选 `overshootBounds`（验证码容器框）钳制；越界时返回 `overshootClamped:true` |
| `challenge` | **检测验证挑战控件**（reCAPTCHA/hCaptcha/Turnstile/极验/阿里云/腾讯/滑块），滑块会直接给出 `start`+`deltaX`+`overshootBounds` 拖拽建议（需后端启用 `login-guard` 插件） |
| `puzzle_gap` | **滑块缺口计算**：自动分析背景与拼图像素给出 `deltaX` 与拖拽建议；`colorMode`（`luma`/`ycbcr`/`hsv`/`auto`）应对彩色渐变背景，色彩匹配置信度低时自动用 Sobel 边缘兜底（`edgeFallback`，默认开） |
| `dialog` | 查看/设置**原生 JS 弹窗**（alert/confirm/prompt/beforeunload）处置策略 `dismiss`/`accept`/`auto`；传 `domain` 只对某域名生效（通配符至少两段、每标签最多 32 条；`clearDomain`/`clearDomains` 可撤销），并回报最近弹窗（需后端 `login-guard` 插件；beforeunload 恒 accept 以便导航继续） |
| `video` | **视频刷课一等动作**：自动倍速、防后台/暂停的 Keeper 守护（自调度 `setTimeout`，不累积漂移）、片尾自动保存进度、`queryOnly` 查询状态 |
| `capture_element` | **元素级取图**：普通元素截图、原生 canvas / `data:` 原图直出（验证码、拼图），比全屏截图裁剪更精确更省 token |
| `auth_export` / `auth_import` | 一键导出/导入会话登录态（cookies + localStorage），重启后免重复登录 |

典型流程：

```
camofox {action:"open", url:"https://example.com"}      → tabId
camofox {action:"snapshot", tabId:"..."}                → [link "Learn more" e1]
camofox {action:"click", tabId:"...", ref:"e1"}
camofox {action:"text", tabId:"..."}                    → 正文
```

登录验证（滑块 / 弹窗）流程：

```
camofox {action:"challenge", tabId:"..."}
  → { kind:"slider", suggestedDrag:{start:{x,y}, deltaX} }
camofox {action:"drag", tabId:"...", start:{x,y}, deltaX:266, easing:"easeInOut", steps:24, durationMs:900}
camofox {action:"dialog", tabId:"...", domain:"login.example.com", policy:"accept"}  # 只对登录域名放行，先设策略
camofox {action:"click", tabId:"...", ref:"e9"}
```

拼图缺口（彩色/渐变背景）：

```
camofox {action:"puzzle_gap", tabId:"...", colorMode:"auto"}
  → deltaX + method:"edge"/"color" + 建议 drag 指令
```

## 配置

改 `cordis.patch.yml` 里的 `config`，或在 profile 的 `cordis.patch.yml` 里按 `id: dsh-camofox-browser` 覆盖。

| 键 | 默认 | 说明 |
|---|---|---|
| `baseUrl` | `http://127.0.0.1:9377` | 后端地址 |
| `serverDir` | 空 | 源码目录（要有 `server.js`，必填：在 profile 配置里指定） |
| `installDir` | 空 | Camoufox 引擎目录；空 = 用默认位置（**推荐留空**） |
| `tempDir` | 空 | 引擎解压的临时目录；留空 = `os.tmpdir()` |
| `userId` | `dsh` | 会话所有者，决定 cookie/localStorage 分区 |
| `autoStart` | `true` | 第一次调用时自动拉起服务 |
| `screenshotDir` | 空 | 截图落盘目录；留空自动回退到宿主工作目录下 `.camofox-shots` |
| `ytDlpPath` | 空 | yt-dlp 绝对路径（如 `E:\Program Files\yt-dlp\yt-dlp.exe`）。后端只探测 PATH 里的 `yt-dlp`，装而不在 PATH 时配这个键：插件拉服务会把它目录前置进子进程 PATH，字幕才走快路径；`status` 也按它报告 |
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
- **`snapshot` 分页曾静默丢内容**（已修）：后端一窗约 80k 字符、`nextOffset` 是段尾，而插件 `maxChars` 只展示 40k；照抄段尾续读会跳过中间 35k。现在续读提示按**实际展示量**计算，并显式警告勿用后端段尾偏移。
- **冷启动首个 `open` 偶发 500**（已缓解）：浏览器 pre-warm 未完成时后端会回 500。插件对建标签类 500 自动退避重试一次。
- **`pin` 依赖后端支持**：`/tabs/:id/pin` 是 fork 新增路由；上游原版无此路由，`pin` 会 404（`status` 的 pin 能力探测可提前发现）。
- **YouTube 字幕快路径**：yt-dlp 装在非 PATH 目录（如 `E:\Program Files\yt-dlp\`）时，后端探测不到会一直走浏览器兜底；配 `ytDlpPath` 并在插件托管模式下重启服务后生效。
- **`scroll` / `refresh` 曾在视频页硬吃 30s 超时**（已修）：B 站/YouTube 这类页面永远有分片与 WebSocket，驱动层等 networkidle 必然超时。后端现在把滚动改为页面内注入原生 `window.scrollBy({behavior:'instant'})`（不等网络/重绘，实测约 113ms 返回），刷新改为等 `domcontentloaded` 并在 `NS_BINDING_ABORTED` 时降级 `location.reload()`；两者都可用 `timeoutMs` 控制预算。
- **`upload` 曾因目录缺失直接失败**（已优化）：后端现在会自动 `mkdir -p` 建好上传目录；越界路径的报错也会回显期望目录（`Expected path inside: ...`），不再只有一句 `Upload directory is not available`。
- **新标签页曾静默跳出**（已缓解）：国内站点搜索/点击普遍 `target="_blank"`，新页异步注册、当次查询常查不到。插件现在在 `click`/`type`/`press` 后轮询约 1 秒（命中即止），发现新标签页就追加提醒（tabId/URL/标题）。
- **新增 `set_cookies` / `trace`**：前者直接注入凭据免扫码登录（对象数组或 `"a=1; b=2"` + `domain`，单次上限 500 条）；后者一键抓「某动作触发了哪些 XHR 与控制台日志」，取代「clear → 点击 → 查询」三步。

## License

MIT
