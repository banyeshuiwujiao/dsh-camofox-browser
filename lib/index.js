/**
 * dsh-camofox-browser —— 宿主半边：把 camofox-browser 的反检测浏览器接成 DSH 原生工具。
 *
 * 为什么不是「再写一个 Playwright 封装」：
 *   camofox-browser 把 Camoufox（Firefox 的 C++ 层指纹伪装分支）包成 REST 服务，
 *   并且已经定义了 11 个工具的权威契约（mcp/lib/tool-contracts.mjs）。本插件不重写
 *   那套契约，只做三件 DSH 特有的事：
 *     1. 把 REST 端点翻译成一个 action-based 的 DSH 工具（不往工具表里塞 11 个名字）；
 *     2. 按需拉起后端服务（DSH 启动时不该常驻一个浏览器服务，第一次调用再起）；
 *     3. 接管两类「DSH 语义」的收尾 —— 图片落盘而不是塞进上下文、错误信息可读。
 *
 * 三个刻意的取舍，都写在对应位置：截图/快照图**落盘**（见 screenshot action）、
 * 服务进程由插件托管（见 ensureServer）、浏览器代理默认关闭（见 DEFAULTS.proxy）。
 */

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { delimiter, dirname, join } from 'node:path'

/** 全部旋钮；bundle patch 里写同样的默认值。 */
const DEFAULTS = {
  baseUrl: 'http://127.0.0.1:9377',
  /** camofox-browser 源码目录（含 server.js）。必填：留空由 profile 指定。 */
  serverDir: '',
  /**
   * Camoufox 引擎安装目录。留空 = 用 camoufox-js 的默认位置
   * （Windows: %LOCALAPPDATA%\camoufox\camoufox\Cache）。
   *
   * ⚠️ 变量名是 CAMOUFOX_INSTALL_DIR（含 U）。camoufox-js 认得的是这个；
   * camofox-browser 自己那批环境变量才是 CAMOFOX_ 前缀。写错不报错 ——
   * camoufox-js 会当作「没装」然后**静默重下 500MB**，所以默认留空最安全。
   */
  installDir: '',
  /** 引擎解压前的临时目录；留空 = os.tmpdir()。 */
  tempDir: '',
  nodePath: '',
  /**
   * yt-dlp 可执行文件的绝对路径（本机 profile 里配置：'E:\\Program Files\\yt-dlp\\yt-dlp.exe'）。
   * 两个用途：
   *   1. status 探测"字幕快路径是否可用"（后端只认 PATH 里的 yt-dlp，装而不在 PATH = 永远走浏览器兜底，
   *      status 会把这种情况显式指出来）；
   *   2. 拉起服务时把它的目录前置进子进程 PATH，让后端的 detectYtDlp 能命中（它只试候选名/固定路径）。
   * 留空 = 只按后端默认探测。
   */
  ytDlpPath: '',
  /** 会话所有者：决定 cookie/localStorage 分区（camofox 会按 userId 哈希落盘）。 */
  userId: 'dsh',
  sessionKey: 'default',
  /** true：第一次调用工具时若服务没在跑就自动拉起。 */
  autoStart: true,
  startTimeoutMs: 120000,
  requestTimeoutMs: 90000,
  /** 截图落盘目录；空则用 DSH 会话工作区下的 .camofox-shots。 */
  screenshotDir: '',
  /** 浏览器代理。默认关闭：直连时 Camoufox 不声明地理位置，身份更中性。 */
  proxy: { enabled: false, host: '127.0.0.1', port: '7897', username: '', password: '', protocol: 'http' },
  /** 单次返回给模型的文本上限，防止一次快照吃掉整个上下文。 */
  maxChars: 40000,
  /**
   * ⚠️ 全局 UA 覆盖（注入 CAMOFOX_USER_AGENT）。**默认留空并保持留空。**
   * Camoufox 的反检测建立在"一致的 Firefox"上：Firefox 引擎配 Chrome UA 本身
   * 就是 UA/引擎不匹配的指纹，反而更容易被识破。只在冒烟/临时排障时用；
   * 真正需要时用 camofox 工具 action=open 的 userAgent 参数，**只给那一个会话**。
   */
  userAgent: '',
  /**
   * ⚠️ 主世界执行（注入 CAMOFOX_ALLOW_MAIN_WORLD）。**默认 false。**
   * 开启后 run(evaluate) 可读页面自定义全局（window.player 等），但会关掉
   * Camoufox 的世界隔离（disableWorldIsolation），反检测变弱；且只建议为
   * 需要操作页面全局的站点单独部署。与 userAgent 一样，非必要不全局开。
   */
  allowMainWorld: false,
  env: {},
}

/** camofox 自带遥测默认是开的（往项目 GitHub 自动报 issue）。这里默认关掉。 */
const CAMOFOX_ENV = {
  CAMOFOX_CRASH_REPORT_ENABLED: 'false',
  /** 只监听回环：这个服务没有任何鉴权时可以被本机任意程序驱动。 */
  CAMOFOX_BIND_HOST: '127.0.0.1',
  NODE_OPTIONS: '--max-old-space-size=512',
}

/** 可以被 action 直接透传成 REST 的字段。 */
const SEARCH_MACROS = [
  '@google_search', '@youtube_search', '@amazon_search', '@reddit_search',
  '@reddit_subreddit', '@wikipedia_search', '@twitter_search', '@yelp_search',
  '@spotify_search', '@netflix_search', '@linkedin_search', '@instagram_search',
  '@tiktok_search', '@twitch_search',
]

function clip(text, max) {
  const value = String(text === undefined || text === null ? '' : text)
  const limit = Number(max) > 0 ? Number(max) : 0
  if (!limit || value.length <= limit) return value
  return `${value.slice(0, limit)}\n... [已截断，显示前 ${limit} / 共 ${value.length} 字符] ...`
}

/** run 提供的页面内工具（前置于用户 steps 之前执行一次）。 */
const RUN_PRELUDE = `const sleep = ms => new Promise(r => setTimeout(r, ms));
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const wait = async (sel, ms = 8000) => {
  const t = Date.now() + ms;
  while (Date.now() < t) { const el = $(sel); if (el) return el; await sleep(100); }
  throw new Error('run.wait 超时: ' + sel);
};
const waitUntil = async (fn, ms = 8000, label = 'condition') => {
  const t = Date.now() + ms;
  while (Date.now() < t) { const v = fn(); if (v) return v; await sleep(100); }
  throw new Error('run.waitUntil 超时: ' + label);
};
const setValue = (target, v) => {
  const el = typeof target === 'string' ? $(target) : target;
  if (!el) throw new Error('run.setValue: 未找到目标元素: ' + target);
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, 'value');
    if (desc && desc.set) {
      desc.set.call(el, v);
    } else {
      el.value = v;
    }
  } else if ('value' in el) {
    el.value = v;
  } else if (el.isContentEditable) {
    el.textContent = v;
  } else {
    throw new Error('run.setValue: 目标元素不支持 value 设置 (tag: <' + el.tagName + '>, class: ' + (el.className || '') + ')');
  }
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return el;
};
const clickByText = (text, root = document) => {
  const el = [...root.querySelectorAll('a,button,[role=button],input[type=submit]')].find(e => (e.innerText || e.value || '').includes(text));
  if (!el) throw new Error('run.clickByText 未找到: ' + text);
  el.click();
  return el;
};
const scrollIntoViewClick = (target, opts = {}) => {
  const el = typeof target === 'string' ? $(target) : target;
  if (!el) throw new Error('run.scrollIntoViewClick 未找到: ' + String(target));
  el.scrollIntoView({ block: opts.block || 'center', inline: opts.inline || 'nearest' });
  if (opts.click !== false) el.click();
  return el;
};
// 等某个 XHR/fetch 返回（用 PerformanceObserver 抓，返回 {url,status,body?}）。
// 必须在触发请求**之前**调用（先 await waitResponse(...) 的 Promise，再点按钮）。
const waitResponse = (pattern, opts = {}) => {
  const ms = Number(opts.timeout) || 15000;
  const useRegex = pattern instanceof RegExp;
  const match = (url) => (useRegex ? pattern.test(url) : String(url).includes(String(pattern)));
  return new Promise((resolve, reject) => {
    const entries = [];
    const obs = new PerformanceObserver((list) => { for (const e of list.getEntries()) entries.push(e); });
    try { obs.observe({ type: 'resource', buffered: false }); } catch (e) { reject(new Error('waitResponse: PerformanceObserver 不可用 ' + e.message)); return; }
    const started = Date.now();
    const timer = setInterval(() => {
      if (Date.now() - started > 1000 * 30) { clearInterval(timer); obs.disconnect(); reject(new Error('waitResponse 超时(30s 上限): ' + pattern)); return; }
      const hit = entries.find((e) => match(e.name));
      if (hit) {
        clearInterval(timer); obs.disconnect();
        // PerformanceResourceTiming 不含 body；这里只给 url/耗时/大小，body 需再 fetch
        resolve({ url: hit.name, durationMs: Math.round(hit.duration), transferSize: hit.transferSize, status: hit.responseStatus || null });
      }
    }, 100);
  });
};
// 在页面里触发下载（<a download> / blob / dataURL），返回文件名与大小（内容不落浏览器盘）。
const download = (urlOrOpts, maybeName) => {
  const o = typeof urlOrOpts === 'string' ? { url: urlOrOpts, filename: maybeName } : (urlOrOpts || {});
  const a = document.createElement('a');
  a.href = o.url || o.href;
  if (!a.href) throw new Error('run.download 需要 url');
  if (o.filename) a.download = o.filename;
  a.rel = 'noopener';
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
  return { triggered: a.href.slice(0, 200), filename: o.filename || null };
};`

/**
 * 把用户写的一段 async 流程包成可在页面主世界执行的表达式。
 * steps 是“函数体”（不含外层 async () => { }），可以 return 任意可 JSON 序列化的值。
 */
function buildRunExpression(steps) {
  const body = String(steps || '')
  return `(async () => {
${RUN_PRELUDE}
${body}
})()`
}

/** 必须带 tabId 的 action。前置统一校验，否则会先报出别的缺参，误导调用方。 */
const NEEDS_TAB = new Set([
  'snapshot', 'click', 'type', 'press', 'navigate', 'scroll',
  'screenshot', 'links', 'evaluate', 'run', 'text', 'close', 'pin',
  'wait', 'refresh', 'back', 'forward',
  'upload', 'console', 'network', 'trace',
  'drag', 'challenge', 'dialog', 'video', 'capture_element', 'puzzle_gap',
])

/** userAgent 家族（与后端 lib/user-agent.js 的判定保持一致，用于提前报错）。 */
function uaFamily(ua) {
  if (!ua) return 'firefox'
  return /chrome\//i.test(String(ua)) ? 'chrome' : 'firefox'
}

/** 按点路径取值：select="a.b.0.c" → obj.a?.b?.[0]?.c；取不到返回 undefined。 */
export function pickPath(obj, path) {
  if (obj === undefined || obj === null) return undefined
  const parts = String(path).split('.').map((s) => s.trim()).filter(Boolean)
  let cur = obj
  for (const p of parts) {
    if (cur === undefined || cur === null) return undefined
    cur = Array.isArray(cur) && /^\d+$/.test(p) ? cur[Number(p)] : cur[p]
  }
  return cur
}

/**
 * 精简 run 的返回值：支持 select（单字段或多字段，空则全量）与 maxChars。
 * 非对象值原样交给 clip。
 */
export function projectRunResult(value, { select, maxChars } = {}) {
  let picked = value
  if (select !== undefined && select !== null && String(select).trim()) {
    const fields = String(select).split(',').map((s) => s.trim()).filter(Boolean)
    if (fields.length === 1) {
      picked = pickPath(value, fields[0])
    } else {
      const out = {}
      for (const f of fields) {
        const leaf = f.split('.').filter(Boolean).pop()
        // 叶子名冲突时回退到完整路径，避免互相覆盖
        const key = leaf in out ? f : leaf
        out[key] = pickPath(value, f)
      }
      picked = out
    }
  }
  if (picked === undefined) return '(select 未命中，原结果里没有该字段；去掉 select 可看全量)'
  if (typeof picked === 'string') return clip(picked, maxChars)
  return clip(JSON.stringify(picked, null, 2), maxChars)
}

/** 每个 action 的 REST 规格。纯函数 —— 自测脚本直接断言它，不碰网络。 */
export function buildCall(args, opts = DEFAULTS) {
  const action = String((args && args.action) || '').toLowerCase()
  const userId = args.userId || opts.userId
  const sessionKey = args.sessionKey || opts.sessionKey
  const q = (extra = {}) => new URLSearchParams({ userId, ...extra }).toString()
  if (NEEDS_TAB.has(action) && !args.tabId) {
    throw new Error(`${action} 需要 tabId（先用 action=open 拿一个）`)
  }
  const tab = () => encodeURIComponent(String(args.tabId))

  switch (action) {
    case 'open':
      if (!args.url) throw new Error('open 需要 url')
      return {
        method: 'POST',
        path: '/tabs',
        body: {
          url: args.url,
          userId,
          sessionKey,
          ...(args.pin !== undefined ? { pin: Boolean(args.pin) } : {}),
          ...(args.userAgent ? { userAgent: String(args.userAgent) } : {}),
          // 默认 false：open 就是新开一个标签页。传 true 才复用同会话组里 URL 相同的标签页
          //（匹配忽略末尾斜杠/默认端口，但 path/query/hash 有区分）。
          ...(args.reuseTab === true ? { reuseTab: true } : {}),
        },
        kind: 'json',
      }

    case 'snapshot':
      // includeScreenshot 默认关：截图会以 base64 塞进 JSON，等于把几 MB 字符串
      // 送进上下文。要图就用 action=screenshot（落盘）。
      return {
        method: 'GET',
        path: `/tabs/${tab()}/snapshot?${q(args.offset ? { offset: String(args.offset) } : {})}`,
        kind: 'snapshot',
      }

    case 'click':
      if (!args.ref && !args.selector && !args.text) throw new Error('click 需要 ref（如 e1）或 selector 或 text')
      if (!args.ref && !args.selector && args.text) {
        return {
          method: 'POST',
          path: `/tabs/${tab()}/evaluate`,
          body: {
            userId,
            expression: `(() => {
              const text = ${JSON.stringify(args.text)};
              const all = [...document.querySelectorAll('a, button, [role=button], input[type=submit], input[type=button], div, span, li, p')];
              const hit = all.find(e => (e.innerText || e.value || '').trim() === text) || all.find(e => (e.innerText || e.value || '').includes(text));
              if (!hit) throw new Error('click: 未找到包含文本的元素: ' + text);
              hit.scrollIntoView({ block: 'center' });
              hit.click();
              return { ok: true, clicked: text, tag: hit.tagName };
            })()`,
          },
          kind: 'json',
        }
      }
      return {
        method: 'POST',
        path: `/tabs/${tab()}/click`,
        body: { userId, ...(args.ref ? { ref: args.ref } : { selector: args.selector }) },
        kind: 'json',
      }

    case 'type':
      if (typeof args.text !== 'string') throw new Error('type 需要 text')
      if (!args.ref && !args.selector) throw new Error('type 需要 ref（如 e2）或 selector')
      return {
        method: 'POST',
        path: `/tabs/${tab()}/type`,
        body: {
          userId,
          text: args.text,
          pressEnter: Boolean(args.pressEnter),
          ...(args.ref ? { ref: args.ref } : { selector: args.selector }),
        },
        kind: 'json',
      }

    case 'press':
      if (!args.key) throw new Error('press 需要 key（如 Enter / Escape）')
      return { method: 'POST', path: `/tabs/${tab()}/press`, body: { userId, key: args.key }, kind: 'json' }

    case 'navigate':
      if (!args.url && !args.macro) throw new Error('navigate 需要 url 或 macro')
      return {
        method: 'POST',
        path: `/tabs/${tab()}/navigate`,
        body: {
          userId,
          ...(args.macro ? { macro: args.macro, query: args.query || '' } : { url: args.url }),
        },
        kind: 'json',
      }

    case 'scroll':
      return {
        method: 'POST',
        path: `/tabs/${tab()}/scroll`,
        body: { userId, direction: args.direction || 'down', ...(args.amount ? { amount: Number(args.amount) } : {}) },
        kind: 'json',
      }

    case 'drag': {
      // 原生可信拖拽：滑块验证的核心。起点用 start 坐标或 handle（快照 ref / CSS 选择器），
      // 终点用 end 坐标或 deltaX/deltaY；easing/jitterPx/overshootPx 控制拟人轨迹。
      const hasStart = args.start || args.handle
      if (!hasStart) throw new Error('drag 需要 start 坐标或 handle（快照 ref / CSS 选择器）')
      const hasEnd = args.end || args.deltaX !== undefined || args.deltaY !== undefined
      if (!hasEnd) throw new Error('drag 需要 end 坐标或 deltaX/deltaY')
      const body = { userId }
      if (args.start) body.start = args.start
      if (args.handle) body.handle = String(args.handle)
      if (args.end) body.end = args.end
      if (args.deltaX !== undefined) body.deltaX = Number(args.deltaX)
      if (args.deltaY !== undefined) body.deltaY = Number(args.deltaY)
      if (args.steps !== undefined) body.steps = Number(args.steps)
      if (args.durationMs !== undefined) body.durationMs = Number(args.durationMs)
      if (args.button) body.button = String(args.button)
      if (args.easing) body.easing = String(args.easing)
      if (args.jitterPx !== undefined) body.jitterPx = Number(args.jitterPx)
      if (args.overshootPx !== undefined) body.overshootPx = Number(args.overshootPx)
      // 控件级过冲钳制：把 challenge/puzzle_gap 返回的验证码容器框传进来，
      // 过冲峰值会被限制在该框内（视口钳制仍然生效）。
      if (args.overshootBounds && typeof args.overshootBounds === 'object') {
        const b = args.overshootBounds
        const bounds = {
          x: Number(b.x || 0),
          y: Number(b.y || 0),
          width: Number(b.width),
          height: Number(b.height),
        }
        if (!(Number.isFinite(bounds.width) && bounds.width > 0 && Number.isFinite(bounds.height) && bounds.height > 0)) {
          throw new Error('overshootBounds 需要 width/height 为正数')
        }
        body.overshootBounds = bounds
      }
      return { method: 'POST', path: `/tabs/${tab()}/drag`, body, kind: 'json' }
    }

    case 'challenge':
      // 检测页面里的验证挑战控件（reCAPTCHA/hCaptcha/Turnstile/极验/阿里云/腾讯/滑块）。
      // 需后端加载 login-guard 插件，否则 404。
      return {
        method: 'POST',
        path: '/verification/challenge',
        body: { userId, tabId: String(args.tabId) },
        kind: 'json',
      }

    case 'dialog': {
      // 查看/设置原生 JS 弹窗（alert/confirm/prompt/beforeunload）处置策略。
      // 传 domain 可只对该域名生效（避免 accept 把全站所有确认框都放行）。
      const body = { userId, tabId: String(args.tabId) }
      if (args.policy) body.policy = String(args.policy)
      if (args.domain) body.domain = String(args.domain)
      if (args.clearDomain) body.clearDomain = String(args.clearDomain)
      if (args.clearDomains === true || args.clearDomains === 'true') body.clearDomains = true
      if (args.reset === true || args.reset === 'true') body.reset = true
      return { method: 'POST', path: '/verification/dialog', body, kind: 'json' }
    }

    case 'screenshot':
      // kind='image'：拿二进制自己落盘，绝不进上下文。
      return { method: 'GET', path: `/tabs/${tab()}/screenshot?${q()}`, kind: 'image' }

    case 'links':
      return { method: 'GET', path: `/tabs/${tab()}/links?${q()}`, kind: 'json' }

    case 'evaluate':
      if (!args.expression) throw new Error('evaluate 需要 expression')
      return {
        method: 'POST',
        path: `/tabs/${tab()}/evaluate`,
        body: {
          userId,
          expression: args.expression,
          ...(args.timeoutMs || args.timeout ? { timeoutMs: Number(args.timeoutMs || args.timeout) } : {}),
        },
        kind: 'json',
      }

    case 'run':
      // 一次调用跑完整段 async 流程（省 token 的 oneshot）：等待→点击→填表→读结果都在
      // 同一段 JS 里完成，避免「click→看快照→fill→看快照」逐步回传。函数体由 args.steps 提供。
      // 内置 sleep/$/$$/wait/waitUntil/setValue/clickByText/scrollIntoViewClick/waitResponse/download。
      // mainWorld:true 时走 /evaluate-main（需后端 CAMOFOX_ALLOW_MAIN_WORLD=1），能摸到页面全局。
      // select/maxChars 在 shapeResult 里裁返回值（不是页面侧），保持 steps 可控。
      if (!args.steps) throw new Error('run 需要 steps（一段 async 函数体，可用 await sleep/$/$$/wait/waitUntil/setValue/clickByText/scrollIntoViewClick/waitResponse/download）')
      return {
        method: 'POST',
        path: `/tabs/${tab()}/${args.mainWorld ? 'evaluate-main' : 'evaluate'}`,
        body: {
          userId,
          expression: buildRunExpression(args.steps),
          ...(args.timeoutMs || args.timeout ? { timeoutMs: Number(args.timeoutMs || args.timeout) } : {}),
        },
        kind: 'json',
      }

    case 'video': {
      // 视频播放一等动作（自动倍速、防暂停 Keeper 守护、片尾自动保存进度、进度查询）
      const rate = Number(args.rate) > 0 ? Number(args.rate) : 16
      const keepAlive = args.keepAlive !== false
      const autoSave = args.autoSave !== undefined ? args.autoSave : false
      const muted = args.muted !== false
      const queryOnly = Boolean(args.queryOnly || args.statusOnly)
      const seek = args.seek !== undefined ? Number(args.seek) : null

      const script = `(async () => {
        const sleep = ms => new Promise(r => setTimeout(r, ms));
        let v = null;
        for (let i = 0; i < 20; i++) {
          v = document.querySelector('video');
          if (v && Number.isFinite(v.duration) && v.duration > 0) break;
          await sleep(250);
        }
        if (!v) {
          const vs = [...document.querySelectorAll('video')];
          return { ok: false, error: '未找到就绪的 video 元素', videoCount: vs.length, url: location.href };
        }
        const targetRate = ${rate};
        const doKeepAlive = ${keepAlive};
        const autoSaveTarget = ${JSON.stringify(autoSave)};
        const isQueryOnly = ${queryOnly};
        const seekTarget = ${seek === null ? 'null' : seek};
        const doMute = ${muted};
        const keeperAlive = () => !!(window.__camofox_video_keeper_state && window.__camofox_video_keeper_state.alive);

        if (isQueryOnly) {
          return {
            ok: true,
            dur: Math.round(v.duration || 0),
            t: Math.round(v.currentTime || 0),
            pct: v.duration ? +((v.currentTime / v.duration) * 100).toFixed(1) : 0,
            rate: v.playbackRate,
            paused: v.paused,
            ended: v.ended,
            muted: v.muted,
            saved: !!window.__camofox_video_saved,
            keeperInstalled: keeperAlive(),
            videoCount: document.querySelectorAll('video').length,
          };
        }

        if (doMute) v.muted = true;
        if (seekTarget !== null && Number.isFinite(seekTarget)) {
          v.currentTime = seekTarget;
          await sleep(200);
        }

        if (autoSaveTarget) {
          window.__camofox_video_save_btn = autoSaveTarget;
          if (!window.__camofox_video_save_handler) {
            window.__camofox_video_save_handler = () => {
              try {
                const target = window.__camofox_video_save_btn;
                const btns = [...document.querySelectorAll('button, a, input[type=button], [role=button]')];
                const hit = btns.find(b => {
                  const txt = (b.innerText || b.value || '').trim();
                  return typeof target === 'string'
                    ? (txt.includes(target) || (b.matches && b.matches(target)))
                    : (/保存.*进度|保存学习|学习进度/.test(txt));
                });
                if (hit) {
                  hit.scrollIntoView({ block: 'center' });
                  hit.click();
                  window.__camofox_video_saved = true;
                }
              } catch (e) {}
            };
          }
        }

        if (doKeepAlive) {
          // Self-scheduling timer instead of setInterval: every tick re-arms
          // itself against an absolute cadence clock. A slow tick (heavy page)
          // or a throttled background tab therefore cannot accumulate a queue
          // of overdue callbacks that then fire in a burst.
          const KEEPER_MS = 300;
          if (window.__camofox_video_keeper) clearTimeout(window.__camofox_video_keeper);
          if (window.__camofox_video_keeper_state) window.__camofox_video_keeper_state.alive = false;
          const keeperState = { alive: true, ticks: 0, nextAt: Date.now() + KEEPER_MS };
          window.__camofox_video_keeper_state = keeperState;

          const keeperTick = () => {
            if (!keeperState.alive) return;
            keeperState.ticks += 1;
            try {
              const curV = document.querySelector('video');
              if (curV) {
                if (curV.playbackRate !== targetRate) {
                  try { curV.playbackRate = targetRate; } catch (e) {}
                }
                if (curV.paused && !curV.ended) {
                  curV.play().catch(() => {});
                }
                if (window.__camofox_video_save_handler && !window.__camofox_video_saved) {
                  const ratio = curV.duration ? curV.currentTime / curV.duration : 0;
                  if (curV.ended || ratio >= 0.98) {
                    window.__camofox_video_save_handler();
                  }
                }
              }
            } catch (e) {}
            // Absolute cadence: if this tick ran late (throttled tab), resync
            // rather than firing a burst of catch-up callbacks.
            keeperState.nextAt += KEEPER_MS;
            const now = Date.now();
            if (keeperState.nextAt < now) keeperState.nextAt = now + KEEPER_MS;
            window.__camofox_video_keeper = setTimeout(keeperTick, Math.max(60, keeperState.nextAt - now));
          };
          window.__camofox_video_keeper = setTimeout(keeperTick, KEEPER_MS);
        } else if (window.__camofox_video_keeper_state) {
          window.__camofox_video_keeper_state.alive = false;
          if (window.__camofox_video_keeper) clearTimeout(window.__camofox_video_keeper);
        }

        try { v.playbackRate = targetRate; } catch (e) {}
        await v.play().catch(() => {});
        await sleep(300);

        return {
          ok: true,
          dur: Math.round(v.duration || 0),
          t: Math.round(v.currentTime || 0),
          pct: v.duration ? +((v.currentTime / v.duration) * 100).toFixed(1) : 0,
          rate: v.playbackRate,
          paused: v.paused,
          ended: v.ended,
          muted: v.muted,
          saved: !!window.__camofox_video_saved,
          keeperInstalled: keeperAlive(),
          videoCount: document.querySelectorAll('video').length,
        };
      })()`

      return {
        method: 'POST',
        path: `/tabs/${tab()}/${args.mainWorld ? 'evaluate-main' : 'evaluate'}`,
        body: {
          userId,
          expression: script,
          ...(args.timeoutMs || args.timeout ? { timeoutMs: Number(args.timeoutMs || args.timeout) } : {}),
        },
        kind: 'json',
      }
    }

    case 'capture_element':
      if (!args.ref && !args.selector) throw new Error('capture_element 需要 ref（如 e1）或 selector')
      return { action: 'capture_element', kind: 'composite' }

    case 'puzzle_gap':
      return {
        method: 'POST',
        path: '/verification/puzzle-gap',
        body: {
          userId,
          tabId: String(args.tabId),
          ...(args.bgSelector ? { bgSelector: String(args.bgSelector) } : {}),
          ...(args.pieceSelector ? { pieceSelector: String(args.pieceSelector) } : {}),
          ...(args.handleSelector ? { handleSelector: String(args.handleSelector) } : {}),
          // 色彩空间：auto 会依次尝试 luma/ycbcr/hsv 取最可分的结果；渐变/彩色背景
          // 用 ycbcr 或 hsv。edgeFallback 默认开，色彩匹配置信度低时改用 Sobel 边缘匹配。
          ...(args.colorMode ? { colorMode: String(args.colorMode) } : {}),
          ...(args.edgeFallback !== undefined ? { edgeFallback: args.edgeFallback !== false } : {}),
        },
        kind: 'json',
      }

    case 'auth_export':
      return {
        method: 'GET',
        path: `/sessions/${encodeURIComponent(userId)}/storage_state`,
        kind: 'auth_export',
      }

    case 'auth_import':
      return { action: 'auth_import', kind: 'composite' }

    case 'text': {
      // 读文章/读区块：innerText 比 a11y 快照省得多。args.selector 只取该区块，
      // 未提供取整页。返回 {title,url,selector,text}。
      const sel = args.selector ? String(args.selector) : null
      const expr = sel
        ? `(() => {
  const el = document.querySelector(${JSON.stringify(sel)});
  if (!el) return { title: document.title, url: location.href, selector: ${JSON.stringify(sel)}, found: false, text: '' };
  return { title: document.title, url: location.href, selector: ${JSON.stringify(sel)}, found: true, text: (el.innerText || el.textContent || '') };
})()`
        : '(() => { const t = document.body ? document.body.innerText : ""; return { title: document.title, url: location.href, text: t }; })()'
      return {
        method: 'POST',
        path: `/tabs/${tab()}/evaluate`,
        body: { userId, expression: expr },
        kind: 'json',
      }
    }

    case 'tabs':
      return { method: 'GET', path: `/tabs?${q()}`, kind: 'json' }

    case 'close':
      return { method: 'DELETE', path: `/tabs/${tab()}?${q()}`, kind: 'json' }

    case 'pin':
      return {
        method: 'POST',
        path: `/tabs/${tab()}/pin`,
        body: { userId, pinned: args.pin !== false },
        kind: 'json',
      }

    case 'reset':
      // 关掉该 userId 的所有标签并清掉持久化的 cookie/localStorage。
      return { method: 'DELETE', path: `/sessions/${encodeURIComponent(userId)}`, kind: 'json' }

    case 'transcript': {
      if (!args.url) throw new Error('transcript 需要 url（YouTube 视频地址）')
      return {
        method: 'POST',
        path: '/youtube/transcript',
        body: { url: args.url, ...(args.languages ? { languages: args.languages } : {}) },
        kind: 'json',
      }
    }

    case 'status':
      return { method: 'GET', path: '/health', kind: 'json' }

    case 'session':
      // 查会话现状：{userAgent, tabCount, ...}，省得靠 409 user_agent_mismatch 去猜。
      return { method: 'GET', path: `/sessions/${encodeURIComponent(userId)}`, kind: 'json' }

    case 'wait': {
      const body = { userId, ...(args.timeout ? { timeout: Number(args.timeout) } : {}) }
      if (args.waitForNetwork !== undefined) body.waitForNetwork = Boolean(args.waitForNetwork)
      if (args.dismissConsent !== undefined) body.dismissConsent = Boolean(args.dismissConsent)
      return { method: 'POST', path: `/tabs/${tab()}/wait`, body, kind: 'json' }
    }

    case 'refresh':
      return { method: 'POST', path: `/tabs/${tab()}/refresh`, body: { userId }, kind: 'json' }

    case 'back':
      return { method: 'POST', path: `/tabs/${tab()}/back`, body: { userId }, kind: 'json' }

    case 'forward':
      return { method: 'POST', path: `/tabs/${tab()}/forward`, body: { userId }, kind: 'json' }

    case 'upload':
      if (!args.path) throw new Error('upload 需要 path（目标文件绝对路径）')
      return {
        method: 'POST',
        path: `/tabs/${tab()}/upload`,
        body: {
          userId,
          path: args.path,
          ...(args.ref ? { ref: args.ref } : {}),
          ...(args.selector ? { selector: args.selector } : {}),
          ...(args.timeout ? { timeout: Number(args.timeout) } : {}),
        },
        kind: 'json',
      }

    case 'console': {
      const extra = {}
      if (args.limit) extra.limit = String(args.limit)
      if (args.types) extra.types = String(args.types)
      if (args.clear === true || args.clear === 'true') extra.clear = 'true'
      return {
        method: 'GET',
        path: `/tabs/${tab()}/console?${q(extra)}`,
        kind: 'json',
      }
    }

    case 'network': {
      const extra = {}
      if (args.limit) extra.limit = String(args.limit)
      if (args.resourceTypes) extra.resourceTypes = String(args.resourceTypes)
      if (args.status) extra.status = String(args.status)
      if (args.clear === true || args.clear === 'true') extra.clear = 'true'
      return {
        method: 'GET',
        path: `/tabs/${tab()}/network?${q(extra)}`,
        kind: 'json',
      }
    }

    case 'set_cookies': {
      if (!args.cookies) throw new Error('set_cookies 需要 cookies（数组或 cookie 字符串）')
      let list = []
      if (Array.isArray(args.cookies)) {
        list = args.cookies
      } else if (typeof args.cookies === 'string') {
        list = args.cookies.split(';').map(pair => {
          const idx = pair.indexOf('=')
          if (idx === -1) return null
          return {
            name: pair.slice(0, idx).trim(),
            value: pair.slice(idx + 1).trim(),
            domain: args.domain,
            path: '/',
          }
        }).filter(Boolean)
      } else if (typeof args.cookies === 'object' && args.cookies) {
        list = [args.cookies]
      }
      if (args.domain) {
        list = list.map(c => ({ domain: args.domain, path: '/', ...c, value: String(c.value ?? '') }))
      } else {
        list = list.map(c => ({ ...c, value: String(c.value ?? '') }))
      }
      return {
        method: 'POST',
        path: `/sessions/${encodeURIComponent(userId)}/cookies`,
        body: { cookies: list },
        kind: 'json',
      }
    }

    case 'trace':
      if (!args.subAction) throw new Error('trace 需要 subAction（如 click / press / type / navigate / evaluate）')
      return { action: 'trace', kind: 'composite' }

    default:
      throw new Error(
        `未知 action：${(args && args.action) || '(空)'}。可用：` +
          'open/snapshot/text/click/type/press/navigate/scroll/screenshot/links/evaluate/run/video/capture_element/puzzle_gap/auth_export/auth_import/tabs/close/reset/pin/status/wait/refresh/back/forward/transcript/upload/console/network/set_cookies/trace/drag/challenge/dialog',
      )
  }
}

/** 把 REST 的 JSON 结果压成一段给模型看的文本。 */
export function shapeResult(action, payload, opts = DEFAULTS, ctx = {}) {
  if (payload === null || payload === undefined) return '(空响应)'
  if (typeof payload === 'string') return clip(payload, opts.maxChars)

  if (action === 'session' && payload && typeof payload === 'object') {
    const ua = payload.userAgent || ''
    const fam = uaFamily(ua)
    const uaLine = ua ? `${ua}\n  （引擎家族：${fam === 'chrome' ? 'Chrome UA（注意引擎仍是 Firefox）' : 'Firefox'}）` : 'Firefox（默认）'
    return [
      `会话 userId=${payload.userId ?? opts.userId}`,
      `标签页数：${payload.tabCount ?? 0}`,
      `userAgent：${uaLine}`,
      `说明：UA 只能在会话创建时设定；已有标签页时若要换 UA，请先 action=reset 再 open。`,
    ].join('\n')
  }

  if (action === 'pin' && payload && typeof payload === 'object') {
    return `标签页 ${payload.tabId || ''} 状态：${payload.pinned ? '已锁定 (pinned: true，免疫 5 分钟空闲自动回收)' : '已解除锁定 (pinned: false)'}`
  }

  if (action === 'set_cookies' && payload && typeof payload === 'object') {
    return `成功导入 ${payload.count ?? (Array.isArray(payload) ? payload.length : '所选')} 条 Cookies 到会话 (userId: ${payload.userId || opts.userId})！`
  }

  if (action === 'video' && payload && typeof payload === 'object') {
    const data = payload.result && typeof payload.result === 'object' ? payload.result : payload
    if (data.ok === false) {
      return `[视频控制失败] ${data.error || '未知错误'} (页面共 ${data.videoCount || 0} 个 video 元素)`
    }
    const status = data.paused ? '已暂停' : (data.ended ? '已结束' : '播放中')
    const keeper = data.keeperInstalled ? 'Keeper守护已开启' : '关闭'
    const saved = data.saved ? '已触发' : '未触发'
    return `[视频状态] 进度: ${data.t}/${data.dur}s (${data.pct}%) | 状态: ${status} | 倍速: ${data.rate}x | 自动保存: ${saved} | ${keeper} (页面视频数: ${data.videoCount || 1})`
  }

  if (action === 'puzzle_gap' && payload && typeof payload === 'object') {
    if (payload.ok === false) {
      return `[滑块缺口计算失败] ${payload.error || '无法识别缺口'}`
    }
    const s = payload.suggestedDrag
    const bg = payload.bgBox
    const bounds = bg ? `, overshootBounds={x:${bg.x},y:${bg.y},width:${bg.width},height:${bg.height}}` : ''
    const suggest = s
      ? `\n建议拖拽指令: action="drag", handle="${s.handle || ''}", start={x:${s.start?.x},y:${s.start?.y}}, deltaX=${s.deltaX}, easing="${s.easing}", jitterPx=${s.jitterPx}, overshootPx=${s.overshootPx}, durationMs=${s.durationMs}${bounds}`
      : ''
    return `[滑块缺口计算] 识别到缺口偏移 deltaX: ${payload.deltaX}px (置信度: ${Math.round((payload.confidence || 0) * 100)}%; 方法: ${payload.method || 'color'}${payload.colorMode ? `/${payload.colorMode}` : ''})${suggest}`
  }

  if (action === 'auth_export' && payload && typeof payload === 'object') {
    const cCount = Array.isArray(payload.cookies) ? payload.cookies.length : 0
    const oCount = Array.isArray(payload.origins) ? payload.origins.length : 0
    return `[登录态已成功导出] 共 ${cCount} 条 Cookies, ${oCount} 个 Origin 的 localStorage 数据。`
  }

  if (action === 'evaluate' && payload && typeof payload === 'object') {
    if (typeof payload.result === 'string' && /^[\{\[]/.test(payload.result.trim())) {
      try {
        const parsed = JSON.parse(payload.result)
        return clip(JSON.stringify(parsed, null, 2), opts.maxChars)
      } catch {}
    }
  }

  if (action === 'text' && payload && typeof payload === 'object') {
    const data = (payload.result && typeof payload.result === 'object') ? payload.result : payload
    if (data.found === false) {
      return `未找到选择器 ${data.selector}（页面 ${data.url}）`
    }
    if ('text' in data) {
      const scope = data.selector ? `区块 ${data.selector}\n` : ''
      const head = `${data.title ? `标题：${data.title}\n` : ''}${data.url ? `URL：${data.url}\n` : ''}${scope}${data.title || data.url || scope ? '\n' : ''}`
      return clip(head + String(data.text || ''), opts.maxChars)
    }
  }

  if (action === 'run' && payload && typeof payload === 'object') {
    // 后端 evaluate 返回 { ok, result }；取 result 再按 select/maxChars 精简，
    // 这是 run "真正省 token" 的一步（只回传关心的字段）。
    const value = 'result' in payload ? payload.result : payload
    return projectRunResult(value, { select: ctx.select, maxChars: ctx.maxChars ?? opts.maxChars })
  }

  if (action === 'snapshot') {
    const snap = payload.snapshot ?? payload
    const reqOffset = Number((ctx && ctx.offset) || 0)
    const isStringSnap = typeof snap === 'string'
    const text = isStringSnap ? snap : JSON.stringify(snap, null, 2)
    const limit = Number(opts.maxChars) > 0 ? Number(opts.maxChars) : 0
    // 续点必须按「本次实际展示量」算，不能照抄后端 nextOffset：后端一整段 ~80k，
    // 插件 maxChars 只给 40k，照抄 nextOffset 会把中间 40k 静默跳丢。
    // reserve 按比例自适应：上限 260，但不超过 limit 的 25%，保证小 limit 时也有足够 budget
    const reserve = limit ? Math.min(260, Math.floor(limit * 0.25)) : 0
    const budget = limit ? Math.max(0, limit - reserve) : text.length
    const shown = Math.min(text.length, budget > 0 ? budget : limit)
    const clipped = limit > 0 && shown < text.length
    const extra = []
    if (payload && payload.hasMore) {
      const backendNext = Number(payload.nextOffset)
      // 仅在快照为纯文本时计算字符展示量偏移；若 snap 是对象，字符计数与后端 yaml offset 不一致，直接沿用 backendNext
      const cont = isStringSnap ? reqOffset + shown : backendNext
      if (isStringSnap && clipped && Number.isFinite(backendNext) && cont < backendNext) {
        if (shown > 0) {
          extra.push(`（本段被 maxChars 截断：用 offset=${cont} 续读；别用后端段尾的 offset=${backendNext}，那会跳过 ${backendNext - cont} 字符）`)
        } else {
          extra.push(`（窗口过小未能展示内容：建议调大 maxChars；或用 offset=${backendNext} 继续）`)
        }
      } else {
        extra.push(`（还有更多内容：用 offset=${backendNext} 继续）`)
      }
    }
    if (payload && payload.url) extra.push(`URL：${payload.url}`)
    const body = clipped ? `${text.slice(0, shown)}\n... [已截断，本请求显示 ${shown} / ${text.length} 字符] ...` : text
    return [...extra, body].join('\n')
  }

  if (action === 'transcript' && payload && typeof payload === 'object') {
    if (payload.status === 'error') {
      const hint = payload.code === 403 || payload.code === 429 || (payload.message && (payload.message.includes('bot') || payload.message.includes('sign-in') || payload.message.includes('Sign in')))
        ? '\n（排障建议：YouTube 触发了反爬验证或需要登录，建议配置 YouTube cookies 后重试）'
        : ''
      return clip(`[YouTube 字幕提取失败: ${payload.code || 500}] ${payload.message || '未知错误'}${hint}\n视频地址：${payload.video_url || ''}`, opts.maxChars)
    }
    if (payload.transcript) {
      return clip(
        [payload.video_title ? `标题：${payload.video_title}` : '', payload.transcript].filter(Boolean).join('\n\n'),
        opts.maxChars,
      )
    }
  }

  if (action === 'upload' && payload && typeof payload === 'object') {
    const attached = Array.isArray(payload.attached) ? payload.attached.join(', ') : (payload.attached || '')
    return `文件上传成功 (via: ${payload.via || 'input'})：已挂载 ${attached}`
  }

  if (action === 'console' && payload && typeof payload === 'object') {
    const logs = Array.isArray(payload.logs) ? payload.logs : []
    const summary = `控制台日志 (共 ${payload.total ?? logs.length} 条${payload.count !== undefined && payload.count !== payload.total ? `，本次返回 ${payload.count} 条` : ''})：`
    if (logs.length === 0) {
      return `${summary} (暂无匹配日志)`
    }
    const formatted = logs.map((l) => {
      const time = l.timestamp ? new Date(l.timestamp).toISOString().slice(11, 23) : ''
      const loc = l.location && l.location.url ? ` (${l.location.url}:${l.location.lineNumber || 0})` : ''
      return `[${time}] [${String(l.type || 'log').toUpperCase()}] ${l.text || ''}${loc}`
    }).join('\n')
    return clip(`${summary}\n${formatted}`, opts.maxChars)
  }

  if (action === 'network' && payload && typeof payload === 'object') {
    const reqs = Array.isArray(payload.requests) ? payload.requests : []
    const summary = `网络请求 (共 ${payload.total ?? reqs.length} 条${payload.count !== undefined && payload.count !== payload.total ? `，本次返回 ${payload.count} 条` : ''})：`
    if (reqs.length === 0) {
      return `${summary} (暂无匹配请求)`
    }
    const formatted = reqs.map((r) => {
      const dur = r.durationMs != null ? `${r.durationMs}ms` : 'pending'
      const status = r.failure ? `FAILED: ${r.failure}` : (r.status || '...')
      return `[${r.method || 'GET'}] ${r.url || ''} -> ${status} (${dur})`
    }).join('\n')
    return clip(`${summary}\n${formatted}`, opts.maxChars)
  }

  if (action === 'challenge' && payload && typeof payload === 'object') {
    const list = Array.isArray(payload.challenges) ? payload.challenges : []
    const lines = [`验证挑战检测（tabId=${payload.tabId || ''}，命中 ${payload.count ?? list.length} 个）`]
    if (payload.error) lines.push(`检测告警：${payload.error}`)
    if (list.length === 0) lines.push('未发现 captcha / 滑块类验证控件。')
    for (const c of list) {
      let line = `- ${c.kind} @ ${c.selector} box=(${c.box?.x},${c.box?.y},${c.box?.width}x${c.box?.height})`
      if (c.suggestedDrag) {
        const b = c.box
        const bounds = b ? ` overshootBounds={x:${b.x},y:${b.y},width:${b.width},height:${b.height}}` : ''
        line += `\n  滑块建议：action=drag tabId=${payload.tabId} start=(${c.suggestedDrag.start.x},${c.suggestedDrag.start.y}) deltaX=${c.suggestedDrag.deltaX} easing=easeInOut steps=24 durationMs=900${bounds}`
      }
      lines.push(line)
    }
    lines.push(`弹窗策略：${payload.dialogPolicy || 'dismiss'}${payload.effectivePolicy ? `（当前页生效：${payload.effectivePolicy}）` : ''}；最近弹窗：${payload.lastDialog ? JSON.stringify(payload.lastDialog) : '无'}`)
    return clip(lines.join('\n'), opts.maxChars)
  }

  if (action === 'dialog' && payload && typeof payload === 'object') {
    const domains = payload.dialogPolicyByDomain && typeof payload.dialogPolicyByDomain === 'object'
      ? Object.entries(payload.dialogPolicyByDomain)
      : []
    const domainLines = domains.length
      ? domains.map(([host, policy]) => `  - ${host} -> ${policy}`).join('\n')
      : '  - （无，全部走默认策略）'
    return clip([
      `弹窗策略：${payload.dialogPolicy || '(未知)'}（可选：${(payload.supportedPolicies || []).join(' / ')}）`,
      payload.host ? `当前页域名：${payload.host}${payload.effectivePolicy ? `，实际生效：${payload.effectivePolicy}` : ''}` : null,
      `按域名覆盖（${payload.domainPolicyCount ?? domains.length}${payload.domainPolicyLimit ? `/${payload.domainPolicyLimit}` : ''}）：\n${domainLines}`,
      `最近弹窗：${payload.lastDialog ? JSON.stringify(payload.lastDialog, null, 2) : '无'}`,
    ].filter(Boolean).join('\n'), opts.maxChars)
  }

  if (action === 'drag' && payload && typeof payload === 'object') {
    return `拖拽完成：start=(${payload.start?.x},${payload.start?.y}) -> end=(${payload.end?.x},${payload.end?.y}) steps=${payload.steps} durationMs=${payload.durationMs} easing=${payload.easing || 'linear'} button=${payload.button || 'left'}`
  }

  return clip(JSON.stringify(payload, null, 2), opts.maxChars)
}

/**
 * status 的独立格式化器：输入 /health 原始 JSON + 能力探测结果。
 * 不放进 shapeResult —— 能力数据不是 REST payload，是插件侧算出来的。
 */
function formatStatus(health, caps) {
  const lines = []
  const running = Boolean(health && health.ok)
  lines.push(
    `服务：${running ? '运行中' : '未运行'} @ ${caps.baseUrl}${
      running ? `（后端版本 ${health.engine || '?'}${health.version ? ` v${health.version}` : ''}）` : '（服务未连接或未就绪）'
    }`,
  )
  lines.push(`服务归属：${caps.managed ? '本插件托管（随插件 dispose 回收）' : '复用外部实例（插件未 spawn，注意可能与托管实例互斥）'}`)
  if (running) {
    lines.push(`浏览器：${health.browserConnected ? (health.browserRunning ? '已连接·运行中' : '已连接') : '未启动'}${caps.interactive ? `·interactive=${caps.interactive}（桌面上可见窗口）` : ''}`)
    const rssVal = health.memory?.rssMb !== undefined && health.memory?.rssMb !== null ? health.memory.rssMb : '?'
    lines.push(`活跃：${health.activeTabs || 0} 标签 / ${health.activeSessions || 0} 会话；RSS ${rssVal}MB`)
    lines.push('能力:')
    lines.push(`- pin：${caps.pin ? '支持（open pin:true / action=pin；锁定免疫空闲回收）' : '不支持（后端无 /tabs/:id/pin；别调，会 404）'}`)
    lines.push(`- transcript：${caps.ytDlp ? `yt-dlp ${caps.ytDlpVersion || ''}（快路径）` : '未装 yt-dlp → 浏览器兜底（慢，~30s，仍可用）'}`)
  } else {
    lines.push('提示：后端服务当前未运行。首次调用 open 等浏览器操作会自动拉起，或通过 npm start 手动启动。')
  }
  if (caps.notes?.length) for (const n of caps.notes) lines.push(`- ${n}`)
  return lines.join('\n')
}

/**
 * status 的能力探测：health + pin 路由是否存在 + yt-dlp + interactive 模式。
 * pin 探测用 POST /tabs/<假id>/pin：老后端无路由 → Express 回 HTML 404；
 * 有路由 → JSON（tab_not_found）。按 content-type 区分，一次网络往返定终身，
 * 把 pin 从「运行时才知道 404」变成「启动即知」。探测用的假 id 不是 UUID，
 * 不会命中 410 browser_restarted 分支，也不会污染 reapedTabs 记录。
 */
async function probeStatus(opts, manager, signal) {
  const caps = {
    baseUrl: opts.baseUrl,
    // 归属：优先看"当前是否有本插件持有的活子进程"（稳态下 ping 命中不会更新 managedAtStart）
    managed: manager.managed ? manager.managed() : Boolean(manager.managedAtStart && manager.managedAtStart()),
    pin: false,
    ytDlp: false,
    ytDlpVersion: '',
    interactive: '',
    notes: [],
  }
  let health = {}
  try {
    const res = await fetch(`${opts.baseUrl}/health`, { signal, headers: { Accept: 'application/json' } })
    health = await res.json().catch(() => ({}))
  } catch (error) {
    caps.notes.push(`health 获取失败（服务未运行或无法连接）：${String(error?.message || error)}`)
  }

  // pin 路由探测：仅在 health 正常时进行 (M4)
  if (health && health.ok) {
    try {
      const res = await fetch(`${opts.baseUrl}/tabs/__status_probe__/pin`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: opts.userId, pinned: true }),
        signal,
      })
      const ct = String(res.headers.get('content-type') || '')
      // 精确判定：200 成功，或 404+JSON（说明路由存在但未找到 tab）；500/502/HTML 均为不支持 (M4)
      caps.pin = res.status === 200 || (res.status === 404 && ct.includes('json'))
    } catch { /* 探测失败保持 false */ }
  }

  // yt-dlp：先看配置的绝对路径，再试 PATH。单次执行缓存结果，避免重复 spawnSync (M4)
  const probeYtDlp = (cmd) => {
    try {
      const r = spawnSync(cmd, ['--version'], { encoding: 'utf8', timeout: 5000, windowsHide: true })
      return r.status === 0 ? String(r.stdout || '').trim() : null
    } catch { return null }
  }
  let ytVer = null
  if (opts.ytDlpPath && existsSync(opts.ytDlpPath)) {
    ytVer = probeYtDlp(opts.ytDlpPath)
    if (ytVer) {
      caps.ytDlp = true
      caps.ytDlpVersion = ytVer
    }
    // 后端只认子进程 PATH：本插件托管拉起时已自动注入 ytDlpPath 目录；
    // 服务归外部实例（或托管时配置还没带 ytDlpPath）→ 装了也不生效，明确指出来。
    if (!caps.managed) {
      caps.notes.push(`yt-dlp 在 ${opts.ytDlpPath}，但当前服务不是本插件拉起的（外部实例不会注入该 PATH）；字幕快路径需重启/让插件托管服务后才生效`)
    }
  } else {
    ytVer = probeYtDlp('yt-dlp')
    if (ytVer) {
      caps.ytDlp = true
      caps.ytDlpVersion = ytVer
    }
  }

  // interactive 模式与后端配置：serverDir 已知就读 camofox.config.json
  if (opts.serverDir && existsSync(join(opts.serverDir, 'camofox.config.json'))) {
    try {
      const cfg = JSON.parse(readFileSync(join(opts.serverDir, 'camofox.config.json'), 'utf8'))
      caps.interactive = String(cfg.interactive?.mode || 'off')
    } catch { caps.notes.push('camofox.config.json 解析失败') }
  }
  return { health, caps }
}

/** 单次 HTTP 调用；把非 2xx 的响应体带出来，因为 camofox 的失败原因都在里面。 */
async function api(opts, call, signal) {
  const url = `${opts.baseUrl}${call.path}`
  const res = await fetch(url, {
    method: call.method,
    headers: { 'Content-Type': 'application/json' },
    body: call.body ? JSON.stringify(call.body) : undefined,
    signal,
  })
  if (!res.ok) {
    let raw = await res.text().catch(() => '')
    let formatted = raw
    try {
      const parsed = JSON.parse(raw)
      if (parsed && typeof parsed === 'object') {
        if (parsed.code === 'ambiguous_selector') {
          formatted = `选择器匹配到了多个元素（严格模式冲突）。建议改用 action=snapshot 查看最新元素树并使用 ref（如 e1/e2），或使用更精确唯一的 CSS 选择器。\n详细信息: ${parsed.error || ''}`
        } else if (parsed.code === 'stale_refs') {
          formatted = `引用的元素引用已失效（页面已发生变动）。请先调用 action=snapshot 获取最新的元素树 ref 后重试。\n详细信息: ${parsed.error || ''}`
        } else if (parsed.code === 'invalid_selector') {
          formatted = `提供的 CSS 选择器语法无效：${parsed.error || ''}`
        } else if (parsed.code === 'tab_reaped' || parsed.code === 'tab_not_found') {
          formatted = `【标签页已失效或被回收】${parsed.error || ''}\n${parsed.hint || ''}`
        } else if (parsed.error) {
          formatted = `${parsed.error}${parsed.hint ? `\n${parsed.hint}` : ''}`
        }
      }
    } catch {}
    // Collapse HTML error bodies to one line
    if (!formatted || /^\s*<(!doctype|html)/i.test(formatted)) {
      const text = formatted.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
      const summary = text ? clip(text, 200) : ''
      if (call.path.includes('/pin') && res.status === 404) {
        formatted = summary || `当前 camofox-browser 版本未提供 /tabs/:id/pin 路由 —— 请升级后端或去掉该动作。`
      } else {
        formatted = summary || `后端返回 HTML 错误页面（HTTP ${res.status}）。`
      }
    }
    const detail = clip(formatted, 4000)
    throw new Error(`camofox ${call.method} ${call.path} 失败：HTTP ${res.status}${detail ? `\n${detail}` : ''}`)
  }
  return call.kind === 'image' ? Buffer.from(await res.arrayBuffer()) : res.json()
}

/** 服务是否已经在跑（1.5 秒内没回应就当没跑）。 */
async function ping(opts) {
  try {
    const res = await fetch(`${opts.baseUrl}/health`, { signal: AbortSignal.timeout(1500) })
    return res.ok
  } catch {
    return false
  }
}

/**
 * 服务生命周期。DSH 常驻一个 40MB 的 node 进程是可以接受的（camofox 自己会在
 * 5 分钟空闲后把浏览器关掉），但「装完插件就常驻」不行 —— 所以是懒启动：
 * 第一次真正调用工具时才 spawn，之后复用同一个子进程，插件卸载时带走。
 */
function createServerManager(opts, logger) {
  let child = null
  let starting = null
  let managedAtStart = false // 最近一次 ensure 时，服务是不是本插件拉起来的
  const recent = []

  function remember(line) {
    recent.push(line)
    if (recent.length > 40) recent.shift()
  }

  function spawnServer() {
    if (!opts.serverDir || !existsSync(join(opts.serverDir, 'server.js'))) {
      throw new Error(
        `找不到 camofox-browser 服务：${join(opts.serverDir || '(未配置)', 'server.js')}。` +
          '请先 `git clone https://github.com/jo-inc/camofox-browser` 并 npm install，' +
          '再把插件配置里的 serverDir 指过去。',
      )
    }
    const env = {
      ...process.env,
      ...CAMOFOX_ENV,
      ...(opts.installDir ? { CAMOUFOX_INSTALL_DIR: opts.installDir } : {}),
      ...(opts.userAgent ? { CAMOFOX_USER_AGENT: String(opts.userAgent) } : {}),
      // 主世界执行是服务级 env：只能在 spawn 时注入，运行中改配置要重启服务才生效。
      ...(opts.allowMainWorld ? { CAMOFOX_ALLOW_MAIN_WORLD: '1' } : {}),
      ...(opts.tempDir ? { TEMP: opts.tempDir, TMP: opts.tempDir } : {}),
      // 后端 detectYtDlp 只试 PATH 里的 'yt-dlp' 与两个 unix 固定路径；Windows 上装在
      // 'C:\Program Files\...' 之类位置等于"没装"。配置了 ytDlpPath 就把它的目录前置进
      // 子进程 PATH，让快路径真的生效。
      ...(opts.ytDlpPath && existsSync(opts.ytDlpPath)
        ? { PATH: `${dirname(opts.ytDlpPath)}${delimiter}${process.env.PATH || ''}` }
        : {}),
      ...(opts.proxy && opts.proxy.enabled
        ? {
            PROXY_HOST: String(opts.proxy.host),
            PROXY_PORT: String(opts.proxy.port),
            ...(opts.proxy.protocol ? { PROXY_PROTOCOL: String(opts.proxy.protocol) } : {}),
            ...(opts.proxy.username ? { PROXY_USERNAME: String(opts.proxy.username) } : {}),
            ...(opts.proxy.password ? { PROXY_PASSWORD: String(opts.proxy.password) } : {}),
          }
        : {}),
      ...opts.env,
    }
    const proc = spawn(opts.nodePath || process.execPath, ['server.js'], {
      cwd: opts.serverDir,
      env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    proc.stdout.on('data', (buf) => remember(String(buf).trimEnd()))
    proc.stderr.on('data', (buf) => remember(String(buf).trimEnd()))
    proc.on('exit', (code) => {
      remember(`[camofox 服务退出] code=${code}`)
      if (child === proc) child = null
    })
    child = proc
    return proc
  }

  async function ensure() {
    if (await ping(opts)) { managedAtStart = false; return }
    if (!opts.autoStart) {
      throw new Error(`camofox 服务没有在 ${opts.baseUrl} 上运行，且插件配置 autoStart=false（请手动 npm start）。`)
    }
    if (starting) return starting
    starting = (async () => {
      logger?.info?.(`[camofox] 拉起后端服务：${opts.serverDir}`)
      spawnServer()
      const deadline = Date.now() + Number(opts.startTimeoutMs || 120000)
      while (Date.now() < deadline) {
        if (child === null) {
          throw new Error(`camofox 服务启动即退出。最近输出：\n${recent.join('\n')}`)
        }
        if (await ping(opts)) { managedAtStart = true; return }
        await new Promise((r) => setTimeout(r, 700))
      }
      throw new Error(`camofox 服务 ${opts.startTimeoutMs}ms 内没有就绪。最近输出：\n${recent.join('\n')}`)
    })().finally(() => {
      starting = null
    })
    return starting
  }

  function dispose() {
    if (child) {
      try {
        child.kill()
      } catch {
        /* already gone */
      }
      child = null
    }
  }

  return { ensure, dispose, managed: () => Boolean(child), managedAtStart: () => managedAtStart, tail: () => recent.slice(-15).join('\n') }
}

/** 截图落盘 —— 图片从不进上下文；要看图由 DSH 的 read_image 读这个路径。 */
// 修复：原三元两分支同值，screenshotDir 为空串时 mkdirSync('') 抛 ENOENT。
// 空串回退到宿主当前工作目录下的 .camofox-shots，与配置注释「留空 = 会话工作区」一致。
function saveShot(buffer, opts, tag) {
  const dir = opts.screenshotDir || join(process.cwd(), '.camofox-shots')
  mkdirSync(dir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const file = join(dir, `camofox-${tag || 'shot'}-${stamp}.png`)
  writeFileSync(file, buffer)
  return file
}

const ACTIONS = [
  'open', 'snapshot', 'text', 'click', 'type', 'press', 'navigate',
  'scroll', 'screenshot', 'links', 'evaluate', 'run', 'video', 'capture_element', 'puzzle_gap', 'auth_export', 'auth_import', 'tabs', 'close', 'reset', 'transcript', 'pin', 'status',
  'session', 'wait', 'refresh', 'back', 'forward', 'upload', 'console', 'network', 'set_cookies', 'trace',
  'drag', 'challenge', 'dialog',
]

function camofoxTool(opts, manager) {
  return {
    name: 'camofox',
    description:
      '反检测浏览器（camofox-browser / Camoufox）—— 通用网页调研、现代 SPA/客户端渲染页面抓取、反检测与复杂自动化操作的首选浏览器。' +
      'action=open 开标签页拿 tabId（可传 pin: true 锁定防止 5 分钟空闲自动回收）；' +
      'pin 锁定/解锁已有标签页；' +
      'snapshot 取可交互元素树（元素带 e1/e2 引用，供 click/type 用）；' +
      'text 直接取正文纯文本（读文章、查资料）；' +
      'evaluate 在页面里执行 JS（推荐用于结构化数据提取与正则精准截取，比 text 大幅节省 token；支持 timeoutMs）；' +
      'run 一次跑完整段多步流程（steps 写 async 函数体，内置 sleep/$/$$/wait/waitUntil/setValue/clickByText，最省 token，优先于逐步 click/type）；' +
      'video 视频刷课一等动作（自动倍速、防暂停 Keeper 守护、片尾自动保存进度、进度查询）；' +
      'capture_element 元素级截图/取图（支持普通元素、原生 canvas、data:image 验证码原图直接导出，比全屏截图裁剪精确度高且大幅省 token）；' +
      'puzzle_gap 滑块缺口计算（自动分析背景与滑块拼图像素，计算缺口 deltaX 并给出拟人拖拽建议）；' +
      'auth_export/auth_import 一键导出会话登录态并保存到文件，重启后一键导入恢复，无需手动逆向 Cookie 键名；' +
      'click/type/press/navigate/scroll 做交互（click 支持 direct text 匹配）；' +
      'upload 上传文件到页面控件（支持 ref/selector/已有输入框）；' +
      'console 获取控制台日志与页面未捕获错误；' +
      'network 检查网络 HTTP 请求与响应（注意：隔离世界内无法通过重写 window.fetch/XHR 截获页面请求，网络拦截请使用 action=network 或 action=trace）；' +
      'set_cookies 向会话直接注入 Cookies（支持数组或 "name=val; ..." 格式，免扫码快速登录）；' +
      'trace 动作级监听（在执行指定 subAction 如 click/press 时自动清空并截获触发的 network 请求与 console 日志）；' +
      'wait 等待页面网络空闲（SPA 水合首选，替代反复 evaluate 轮询）；refresh/back/forward 页面导航；' +
      'screenshot 截图存盘并返回文件路径（不进上下文，需要看图再用 read_image）；' +
      'links 取页面链接；tabs/close/reset 管标签页与会话；' +
      'drag 原生可信拖拽（start/handle 到 end/deltaX，可加 easing/jitterPx 拟人轨迹，用于滑块验证）；' +
      'challenge 检测页面验证挑战控件（reCAPTCHA/hCaptcha/Turnstile/极验/阿里云/腾讯/滑块）并给出滑块拖拽建议（需后端 login-guard 插件）；' +
      'dialog 查看/设置原生 JS 弹窗（alert/confirm/prompt/beforeunload）处置策略（dismiss/accept/auto，可用 domain 只对某域名生效，需后端 login-guard 插件）；' +
      'transcript 抓 YouTube 字幕（yt-dlp 优先，未安装时自动降级为浏览器兜底通道，较慢但可用）；' +
      'status 查服务健康度、后端能力（pin/yt-dlp/interactive）与运行状态。' +
      '首次调用会自动拉起本地 camofox 服务（冷启动约 3-8 秒）。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ACTIONS, description: '要执行的动作。' },
        tabId: { type: 'string', description: '标签页 id（open 返回；tabs 可列出）。' },
        url: { type: 'string', description: 'open/navigate/transcript：目标 URL。' },
        path: { description: 'upload：要上传的文件绝对路径；auth_export/auth_import：登录态 JSON 文件路径。' },
        pin: { type: 'boolean', description: 'open/pin：是否锁定标签页（true = 锁定，免疫 5 分钟空闲自动回收）。' },
        reuseTab: { type: 'boolean', description: 'open：复用同会话组里 URL 相同的标签页（默认 false，即总是新开）。匹配忽略末尾/重复斜杠与默认端口，但 path/query/hash 不同视为不同目标。' },
        userAgent: { type: 'string', description: 'open：会话 UA 覆盖，"chrome" = 本机平台对应的「桌面」Chrome UA，也可传完整 UA 字符串。⚠️ 默认不要用：Firefox 引擎套 Chrome UA 会破坏反检测一致性（UA 与引擎不符本身就是可检测特征），只对硬性屏蔽 Firefox 的站点（如保利威 #024「此视频不支持在本浏览器上播放」）单独开一个会话用。必须是桌面 UA，别用 Mobile（会触发移动端播放器 #007）。该会话已有标签页时会返回 409，先 action=reset 再 open。' },
        ref: { type: 'string', description: 'click/type/upload/capture_element：快照里的元素引用，如 e1。' },
        selector: { type: 'string', description: 'click/type/upload/capture_element：CSS 选择器（替代 ref）。text：只取该区块的 innerText（不传则整页）。' },
        text: { type: 'string', description: 'type：要输入的文本；click：要匹配并点击的可见文本（替代 ref/selector）。' },
        pressEnter: { type: 'boolean', description: 'type：输入后是否回车。' },
        key: { type: 'string', description: 'press：按键名，如 Enter / Escape / Tab。' },
        macro: { type: 'string', enum: SEARCH_MACROS, description: 'navigate：搜索宏。' },
        query: { type: 'string', description: 'navigate：配合 macro 的搜索词。' },
        direction: { type: 'string', enum: ['up', 'down', 'left', 'right'], description: 'scroll：方向，默认 down。' },
        amount: { type: 'number', description: 'scroll：滚动滚轮脉冲量（Delta，默认 500；如需精确绝对像素对齐建议使用 action=evaluate 执行 window.scrollTo）。' },
        start: { type: 'object', description: 'drag：起点视图坐标 {x,y}（与 handle 二选一）。', properties: { x: { type: 'number' }, y: { type: 'number' } }, required: ['x', 'y'] },
        handle: { type: 'string', description: 'drag：起点元素——快照 ref（如 e12）或 CSS 选择器，解析到元素中心（与 start 二选一）。拖滑块最常用。' },
        end: { type: 'object', description: 'drag：终点视图坐标 {x,y}（与 deltaX/deltaY 二选一）。', properties: { x: { type: 'number' }, y: { type: 'number' }, }, required: ['x', 'y'] },
        deltaX: { type: 'number', description: 'drag：相对起点的水平位移（替代 end）。' },
        deltaY: { type: 'number', description: 'drag：相对起点的垂直位移（替代 end）。' },
        steps: { type: 'number', description: 'drag：中间移动帧数（默认 12，1-24）。' },
        durationMs: { type: 'number', description: 'drag：整个手势时长毫秒（默认 800，1-5000）。' },
        easing: { type: 'string', enum: ['linear', 'easeInOut'], description: 'drag：运动曲线，easeInOut 更接近人手（默认 linear）。' },
        jitterPx: { type: 'number', description: 'drag：垂直于拖拽方向的确定性抖动像素（0-8，默认 0），增加拟人微颤。' },
        overshootPx: { type: 'number', description: 'drag：沿拖拽方向的越界像素（0-24，默认 0），模拟人手过冲回拉。' },
        overshootBounds: {
          type: 'object',
          description: 'drag：可选矩形（视口坐标），过冲峰值会被钳制在该框内（如 challenge/puzzle_gap 返回的验证码容器 box），比视口钳制更严格。',
          properties: {
            x: { type: 'number', description: '左边界（默认 0）' },
            y: { type: 'number', description: '上边界（默认 0）' },
            width: { type: 'number', description: '宽度（CSS px）' },
            height: { type: 'number', description: '高度（CSS px）' },
          },
          required: ['width', 'height'],
        },
        rate: { type: 'number', description: 'video：播放倍速（默认 16，0.25-16）。' },
        keepAlive: { type: 'boolean', description: 'video：是否开启守护定时器（自动维持倍速与防后台暂停自动续播，默认 true）。' },
        autoSave: { description: 'video：视频结束或达到98%时自动点击保存进度的按钮文本或选择器（如 "保存学习进度" 或 true）。' },
        seek: { type: 'number', description: 'video：跳转到指定播放秒数。' },
        queryOnly: { type: 'boolean', description: 'video：仅查询当前播放器状态不改变播放，默认 false。' },
        bgSelector: { type: 'string', description: 'puzzle_gap：滑块拼图背景图/画布的 CSS 选择器（不传自动探测）。' },
        pieceSelector: { type: 'string', description: 'puzzle_gap：滑块拼图片/画布的 CSS 选择器（不传自动探测）。' },
        handleSelector: { type: 'string', description: 'puzzle_gap：滑块拖动按钮的 CSS 选择器（不传自动探测）。' },
        colorMode: { type: 'string', enum: ['luma', 'ycbcr', 'hsv', 'auto'], description: 'puzzle_gap：比对色彩空间。luma 适合灰度图；彩色/渐变背景用 ycbcr 或 hsv；auto 逐个尝试取最可分的结果（默认 luma）。' },
        edgeFallback: { type: 'boolean', description: 'puzzle_gap：色彩匹配置信度低时是否改用 Sobel 边缘匹配兜底（默认 true）。' },
        name: { type: 'string', description: 'capture_element：截图文件名前缀。' },
        storageState: { type: 'object', description: 'auth_import：导入的 storageState 对象（含 cookies 和 origins）。' },
        policy: { type: 'string', enum: ['dismiss', 'accept', 'auto'], description: 'dialog：原生 JS 弹窗处置策略（默认 dismiss；beforeunload 恒为 accept 以允许导航）。' },
        domain: { type: 'string', description: 'dialog：把 policy 只绑定到该域名（如 example.com；支持 `*.example.com` 形式的前缀匹配需在服务端写入）。不传则改标签页默认策略。' },
        clearDomain: { type: 'string', description: 'dialog：删除该域名的策略覆盖。' },
        clearDomains: { type: 'boolean', description: 'dialog：清空所有按域名的策略覆盖。' },
        reset: { type: 'boolean', description: 'dialog：是否清空最近弹窗记录。' },
        expression: { type: 'string', description: 'evaluate：在页面上下文执行的 JS表达式。' },
        steps: { type: 'string', description: 'run：一段 async 函数体（不要写外层 async () => {}），可 return 任意可 JSON 化的值。内置工具：sleep(ms)/$(sel)/$$(sel)/wait(sel,ms=8000)/waitUntil(fn,ms,label)/setValue(el,v)（原生 setter + input/change，兼容 React）/clickByText(text)/scrollIntoViewClick(selOrEl,{block,click})/waitResponse(urlPattern,{timeout})（等 XHR/fetch，须在触发请求前先起 Promise）/download({url,filename})。导航是硬边界：函数内跳转会中断它，跨页请分段。' },
        select: { type: 'string', description: 'run：只回传关心的字段，省 token。单字段写 a.b.0.c，多字段用逗号分隔 a,b.name（数字段可索引）。不传 = 全量返回。' },
        maxChars: { type: 'number', description: 'run/text：本次返回的最大字符数（超出截断）。默认用插件配置的 maxChars。' },
        mainWorld: { type: 'boolean', description: 'run/video（可选，谨慎）：true 时在页面主世界执行，能访问页面自定义全局（window.player、播放器实例等）。需后端以 CAMOFOX_ALLOW_MAIN_WORLD=1 启动（关闭世界隔离，反检测变弱）；未开启会返回 409 main_world_disabled。' },
        offset: { type: 'number', description: 'snapshot：大页面分页偏移（用上次返回的 offset 提示值续读，不是后端 nextOffset——两者在截断时不一致）。' },
        limit: { type: 'number', description: 'console/network/trace：最大返回条数，默认 100。' },
        types: { type: 'string', description: 'console/trace：日志级别过滤，如 error,warn,log,info。' },
        resourceTypes: { type: 'string', description: 'network/trace：资源类型过滤，如 document,xhr,fetch,script,image。' },
        status: { type: 'string', description: 'network/trace：状态码过滤，如 200, 404 或 failed。' },
        clear: { type: 'boolean', description: 'console/network：获取后是否清空缓冲区，默认 false。' },
        timeout: { type: 'number', description: 'wait/upload：等待超时毫秒。' },
        timeoutMs: { type: 'number', description: 'evaluate/run/video：脚本执行超时毫秒数（上限 300000ms/5分钟，默认 30000ms）。' },
        waitForNetwork: { type: 'boolean', description: 'wait：是否等网络空闲，默认 true。' },
        dismissConsent: { type: 'boolean', description: 'wait：是否顺手点掉 cookie 同意弹窗，默认 false。' },
        languages: { type: 'array', items: { type: 'string' }, description: 'transcript：字幕语言优先级，如 ["zh-Hans","en"]。' },
        sessionKey: { type: 'string', description: '标签页分组名（同组共享会话上下文），默认 default。' },
        cookies: { description: 'set_cookies/auth_import：要注入的 Cookies（Cookie 对象数组或分号分隔字符串）。' },
        domain: { type: 'string', description: 'set_cookies：目标域名，如 ".bilibili.com"。' },
        subAction: { type: 'string', description: 'trace：要监听执行的子动作（如 click, press, type, navigate 等）。' },
        waitMs: { type: 'number', description: 'trace：子动作执行后等待抓包毫秒数，默认 800ms。' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: { text: { type: 'string' }, imagePath: { type: 'string' } },
        required: ['text'],
        additionalProperties: false,
      },
      render(_args, value) {
        const blocks = [{ type: 'text', text: String((value && value.text) || '') }]
        return blocks
      },
    },
    presentCall(args) {
      const action = String((args && args.action) || '').trim()
      return { card: 'terminal', title: `camofox ${action}`.trim() }
    },
    presentResult(args, result) {
      try {
        const text = ((result && result.content) || [])
          .filter((block) => block && block.type === 'text')
          .map((block) => block.text)
          .join('\n')
        return {
          card: 'terminal',
          title: `camofox ${String((args && args.action) || '').trim()}`.trim(),
          output: text,
          exitCode: result && result.isError ? 1 : 0,
        }
      } catch {
        return undefined
      }
    },
    async execute(args, exec) {
      const action = String((args && args.action) || '').toLowerCase()
      const call = buildCall(args, opts)
      const customTimeoutMs = Number(args.timeoutMs || args.timeout || 0)
      const opTimeoutMs = Math.max(Number(opts.requestTimeoutMs) || 90000, customTimeoutMs > 0 ? customTimeoutMs + 15000 : 90000)
      const signal = exec && exec.signal
        ? AbortSignal.any([exec.signal, AbortSignal.timeout(opTimeoutMs)])
        : AbortSignal.timeout(opTimeoutMs)

      // status：独立通道 —— /health + 能力探测，不走通用 api() 也不强行 ensure() 拉起服务
      // 保持脱机诊断能力：即使服务未运行也能快速返回状态报告 (S1)
      if (action === 'status') {
        const { health, caps } = await probeStatus(opts, manager, signal)
        return { text: formatStatus(health, caps) }
      }

      await manager.ensure()

      // trace: 动作级监听（先清缓冲区 -> 执行子动作 -> 短暂等待 -> 提取网络和控制台结果）
      if (action === 'trace') {
        const subAction = String(args.subAction || '').toLowerCase()
        if (!subAction) throw new Error('trace 需要 subAction（如 click, press, type, navigate, evaluate 等）')
        const tab = encodeURIComponent(String(args.tabId))
        const userId = args.userId || opts.userId
        const qClear = new URLSearchParams({ userId, clear: 'true' }).toString()

        // 1. 清空当前 tab 的 console 和 network 缓冲区
        await api(opts, { method: 'GET', path: `/tabs/${tab}/console?${qClear}`, kind: 'json' }, signal).catch(() => {})
        await api(opts, { method: 'GET', path: `/tabs/${tab}/network?${qClear}`, kind: 'json' }, signal).catch(() => {})

        // 2. 执行子动作
        const subArgs = { ...args, action: subAction }
        delete subArgs.subAction
        delete subArgs.waitMs
        const subCall = buildCall(subArgs, opts)
        const subPayload = await api(opts, subCall, signal)
        const actionResult = shapeResult(subAction, subPayload, opts)

        // 3. 等待指定或默认时间（默认 800ms）以捕获异步请求与日志
        const waitMs = Number(args.waitMs) >= 0 ? Number(args.waitMs) : 800
        if (waitMs > 0) {
          await new Promise((r) => setTimeout(r, waitMs))
        }

        // 4. 读取捕获到的网络请求与控制台日志
        const qNet = new URLSearchParams({
          userId,
          limit: String(args.limit || 30),
          resourceTypes: String(args.resourceTypes || 'xhr,fetch'),
          ...(args.status ? { status: String(args.status) } : {}),
        }).toString()
        const qCon = new URLSearchParams({
          userId,
          limit: String(args.limit || 30),
          ...(args.types ? { types: String(args.types) } : {}),
        }).toString()

        const netData = await api(opts, { method: 'GET', path: `/tabs/${tab}/network?${qNet}`, kind: 'json' }, signal).catch(() => ({}))
        const conData = await api(opts, { method: 'GET', path: `/tabs/${tab}/console?${qCon}`, kind: 'json' }, signal).catch(() => ({}))

        const netResult = shapeResult('network', netData, opts)
        const conResult = shapeResult('console', conData, opts)

        const sections = [
          `=== 动作执行结果 (${subAction}) ===\n${actionResult}`,
          `\n=== 动作触发的网络请求 (XHR/fetch) ===\n${netResult}`,
          `\n=== 动作触发的控制台日志 ===\n${conResult}`,
        ]
        return { text: sections.join('\n') }
      }

      if (action === 'capture_element') {
        const tab = encodeURIComponent(String(args.tabId))
        const userId = args.userId || opts.userId
        const ref = args.ref ? String(args.ref) : null
        const selector = args.selector ? String(args.selector) : null
        const nameStem = args.name ? String(args.name).replace(/[^a-zA-Z0-9_-]/g, '_') : `element-${Date.now()}`

        const extractExpr = `(async () => {
          let el = null;
          ${ref ? `
          el = document.querySelector('[data-ref="' + ${JSON.stringify(ref)} + '"]');
          ` : `
          el = document.querySelector(${JSON.stringify(selector)});
          `}
          if (!el) return { ok: false, error: '未找到指定元素: ' + ${JSON.stringify(ref || selector)} };
          const r = el.getBoundingClientRect();
          if (el.tagName === 'CANVAS') {
            try {
              return { ok: true, isDataUrl: true, dataUrl: el.toDataURL('image/png'), width: el.width || Math.round(r.width), height: el.height || Math.round(r.height) };
            } catch (e) {}
          }
          if (el.tagName === 'IMG') {
            if (el.src && el.src.startsWith('data:image')) {
              return { ok: true, isDataUrl: true, dataUrl: el.src, width: el.naturalWidth || Math.round(r.width), height: el.naturalHeight || Math.round(r.height) };
            }
            try {
              const c = document.createElement('canvas');
              c.width = el.naturalWidth || Math.round(r.width);
              c.height = el.naturalHeight || Math.round(r.height);
              const ctx = c.getContext('2d');
              ctx.drawImage(el, 0, 0);
              return { ok: true, isDataUrl: true, dataUrl: c.toDataURL('image/png'), width: c.width, height: c.height };
            } catch (e) {}
          }
          return { ok: true, isDom: true, width: Math.round(r.width), height: Math.round(r.height), rect: { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) } };
        })()`

        const evalRes = await api(opts, { method: 'POST', path: `/tabs/${tab}/evaluate`, body: { userId, expression: extractExpr }, kind: 'json' }, signal)
        const d = evalRes?.result || evalRes
        if (!d || d.ok === false) {
          throw new Error(d?.error || '无法提取指定元素图像')
        }

        const dir = opts.screenshotDir || join(process.cwd(), '.camofox-shots')
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
        const outPath = join(dir, `camofox-${nameStem}.png`)

        if (d.isDataUrl && d.dataUrl) {
          const b64 = d.dataUrl.replace(/^data:image\/[^;]+;base64,/, '')
          const buf = Buffer.from(b64, 'base64')
          writeFileSync(outPath, buf)
          return {
            text: `元素图像已提取并保存：${outPath}\n尺寸: ${d.width}x${d.height} px, 大小: ${buf.length} 字节\n（要看图请用 read_image 读这个路径；原图数据直接导出，无截屏裁剪失真）`,
            imagePath: outPath,
          }
        }

        const shotBuf = await api(opts, { method: 'GET', path: `/tabs/${tab}/screenshot?${new URLSearchParams({ userId })}`, kind: 'image' }, signal)
        writeFileSync(outPath, shotBuf)
        return {
          text: `元素区域已截图保存：${outPath}\n尺寸: ${d.width}x${d.height} px\n（要看图请用 read_image 读这个路径）`,
          imagePath: outPath,
        }
      }

      if (action === 'auth_import') {
        const userId = args.userId || opts.userId
        let state = null
        if (args.path) {
          const content = readFileSync(args.path, 'utf8')
          state = JSON.parse(content)
        } else if (args.storageState && typeof args.storageState === 'object') {
          state = args.storageState
        } else if (args.cookies || args.origins) {
          state = { cookies: args.cookies || [], origins: args.origins || [] }
        }
        if (!state || typeof state !== 'object') {
          throw new Error('auth_import 需要 path（文件路径）或 storageState 对象')
        }

        let cookieCount = 0
        let originCount = 0

        if (Array.isArray(state.cookies) && state.cookies.length > 0) {
          const cookieCall = buildCall({ action: 'set_cookies', userId, cookies: state.cookies }, opts)
          await api(opts, cookieCall, signal)
          cookieCount = state.cookies.length
        }

        if (Array.isArray(state.origins) && state.origins.length > 0) {
          await api(opts, {
            method: 'POST',
            path: `/sessions/${encodeURIComponent(userId)}/local-storage`,
            body: { origins: state.origins },
            kind: 'json',
          }, signal)
          originCount = state.origins.length
        }

        return {
          text: `[登录态导入成功] 已恢复 ${cookieCount} 条 Cookies 及 ${originCount} 个 Origin 的 localStorage。建议刷新或重新导航页面以生效。`,
        }
      }

      if (action === 'auth_export') {
        const data = await api(opts, call, signal)
        if (args.path) {
          writeFileSync(args.path, JSON.stringify(data, null, 2))
          return {
            text: `[登录态已成功保存到文件] 路径: ${args.path}\n包含 ${data.cookies?.length || 0} 条 Cookies, ${data.origins?.length || 0} 个 Origin 的 localStorage 数据。`,
          }
        }
        return {
          text: shapeResult(action, data, opts),
        }
      }

      // 新标签页预先状态探测
      const MAY_SPAWN_TAB = new Set(['click', 'press', 'type'])
      let tabsBefore = null
      if (MAY_SPAWN_TAB.has(action)) {
        try {
          const res = await api(opts, { method: 'GET', path: `/tabs?${new URLSearchParams({ userId: args.userId || opts.userId })}`, kind: 'json' }, AbortSignal.timeout(2000))
          if (res && Array.isArray(res.tabs)) tabsBefore = new Set(res.tabs.map(t => t.tabId))
        } catch {}
      }

      let payload
      try {
        payload = await api(opts, call, signal)
      } catch (error) {
        const message = String((error && error.message) || error)
        // 冷启动竞态：浏览器 pre-warm 未完成时首个 open 常 500（GeoIP/setup 超时），重试即成。
        // 只对建标签类 500 做一次带退避的重试，其他错误保持原样快速失败。
        const launch500 = /HTTP 500/.test(message) && (action === 'open' || /pre-warm|timed out|not (?:ready|started)/i.test(message))
        if (launch500) {
          await new Promise((r) => setTimeout(r, 1500))
          try {
            // 重试时重建独立的 timeout signal，避免复用已濒临超时的旧 signal (M2)
            const retrySignal = exec && exec.signal
              ? AbortSignal.any([exec.signal, AbortSignal.timeout(Number(opts.requestTimeoutMs) || 90000)])
              : AbortSignal.timeout(Number(opts.requestTimeoutMs) || 90000)
            payload = await api(opts, call, retrySignal)
          } catch (retryError) {
            const retryMsg = String((retryError && retryError.message) || retryError)
            const tail = manager.tail()
            throw new Error(`${retryMsg}\n（冷启动重试一次仍失败；首次拉服务后稍等再试可恢复）${tail ? `\n\n[camofox 服务最近输出]\n${tail}` : ''}`)
          }
        } else {
          // 带上服务最近输出：冷启动失败/引擎缺失的线索都在那里。空 tail 不打印。
          const tail = manager.tail()
          const tailLine = tail ? `\n\n[camofox 服务最近输出]\n${tail}` : ''
          throw new Error(`${message}${tailLine}`)
        }
      }

      if (call.kind === 'image') {
        const dir = opts.screenshotDir || join(process.cwd(), '.camofox-shots')
        try {
          const file = saveShot(payload, opts, action)
          return { text: `截图已保存：${file}\n（要看图请用 read_image 读这个路径；图片不进上下文以免占用 token）`, imagePath: file }
        } catch (saveError) {
          const msg = String(saveError?.message || saveError)
          throw new Error(`screenshot 截图已成功抓到（${payload?.length || 0} 字节），但落盘失败：${msg}\n目标目录：${dir}（检查权限/磁盘；也可在 profile 配置里把 screenshotDir 指到可写目录）`)
        }
      }

      let mainText = shapeResult(action, payload, opts, {
        offset: Number(args && args.offset) || 0,
        // run 的返回值裁剪只作用于本次调用（select/maxChars 由调用方给）
        select: args && args.select,
        maxChars: args && args.maxChars,
      })
      if (action === 'open' && payload && typeof payload === 'object' && payload.tabId) {
        mainText = `tabId: ${payload.tabId}\n${mainText}`
      }

      // 新标签页生成自动检测与提醒。
      // target="_blank" 弹出的新标签页是异步注册的，只查一次必然漏报（实测 B 站搜索回车
      // 后立刻查 tabs 仍为旧集合）。这里轮询 3 次、总计约 1s，命中即刻返回，避免拖慢无弹窗的点击。
      if (tabsBefore) {
        const pollDelays = [0, 350, 550]
        for (const wait of pollDelays) {
          try {
            if (wait > 0) await new Promise((r) => setTimeout(r, wait))
            const resAfter = await api(opts, { method: 'GET', path: `/tabs?${new URLSearchParams({ userId: args.userId || opts.userId })}`, kind: 'json' }, AbortSignal.timeout(2000))
            if (!resAfter || !Array.isArray(resAfter.tabs)) continue
            const newTabs = resAfter.tabs.filter(t => !tabsBefore.has(t.tabId))
            if (newTabs.length > 0) {
              const lines = newTabs.map(t => `- 新标签页 tabId: ${t.tabId}\n  URL: ${t.url}\n  标题: ${t.title || '(无标题)'}`)
              mainText += `\n\n💡 [检测到动作生成了 ${newTabs.length} 个新标签页]\n${lines.join('\n')}\n提示：如需在新标签页中继续操作，请在后续交互中使用上述 tabId（建议传入 action=pin 锁定）。`
              break
            }
          } catch {
            /* 探测失败不影响主流程 */
          }
        }
      }

      return { text: mainText }
    },
  }
}

/** 宿主插件入口：一个工具 + 一个被托管的服务进程。 */
function apply(ctx, config) {
  const cfg = config && typeof config === 'object' ? config : {}
  const opts = { ...DEFAULTS, ...cfg }
  opts.proxy = { ...DEFAULTS.proxy, ...(cfg.proxy || {}) }
  opts.env = { ...(DEFAULTS.env || {}), ...(cfg.env || {}) }

  const manager = createServerManager(opts, ctx.logger)

  ctx.inject(['tools'], (scoped) => {
    const dispose = scoped.tools.register(camofoxTool(opts, manager))
    ctx.on('dispose', () => {
      try {
        if (typeof dispose === 'function') dispose()
      } catch {
        /* already gone */
      }
      manager.dispose()
    })
  })
}

export { apply, DEFAULTS, CAMOFOX_ENV, SEARCH_MACROS, clip, ping, createServerManager, formatStatus }
