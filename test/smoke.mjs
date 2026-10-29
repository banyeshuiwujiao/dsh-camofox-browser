/**
 * dsh-camofox-browser 自测 —— 只测纯函数，不碰网络、不起浏览器。
 *
 *   node test/smoke.mjs
 *
 * 断言的是「工具参数 → REST 规格」的翻译层。这层最容易悄悄坏：路径拼错、
 * 漏掉 userId/sessionKey、把 ref 和 selector 混淆，都要在发请求前就抓住。
 */

import assert from 'node:assert/strict'
import { buildCall, shapeResult, formatStatus, projectRunResult, pickPath, DEFAULTS, SEARCH_MACROS } from '../lib/index.js'

let passed = 0
function check(name, fn) {
  fn()
  passed++
  console.log(`  ok  ${name}`)
}

const opts = { ...DEFAULTS, userId: 'u1', sessionKey: 's1' }

console.log('buildCall')

check('open 会带上 userId + sessionKey（缺 sessionKey 服务会 400）', () => {
  const call = buildCall({ action: 'open', url: 'https://example.com' }, opts)
  assert.equal(call.method, 'POST')
  assert.equal(call.path, '/tabs')
  assert.deepEqual(call.body, { url: 'https://example.com', userId: 'u1', sessionKey: 's1' })
})

check('open 缺 url 就报错', () => {
  assert.throws(() => buildCall({ action: 'open' }, opts), /需要 url/)
})

check('snapshot 不带 includeScreenshot（截图会撑爆上下文）', () => {
  const call = buildCall({ action: 'snapshot', tabId: 't1' }, opts)
  assert.equal(call.kind, 'snapshot')
  assert.match(call.path, /^\/tabs\/t1\/snapshot\?userId=u1$/)
  assert.ok(!call.path.includes('includeScreenshot'))
})

check('snapshot 支持 offset 分页', () => {
  const call = buildCall({ action: 'snapshot', tabId: 't1', offset: 2000 }, opts)
  assert.match(call.path, /offset=2000/)
})

check('click 接受 ref 或 selector，且只带其中一个', () => {
  const byRef = buildCall({ action: 'click', tabId: 't1', ref: 'e1' }, opts)
  assert.deepEqual(byRef.body, { userId: 'u1', ref: 'e1' })
  const bySel = buildCall({ action: 'click', tabId: 't1', selector: '#go' }, opts)
  assert.deepEqual(bySel.body, { userId: 'u1', selector: '#go' })
})

check('click 两个都没有就报错', () => {
  assert.throws(() => buildCall({ action: 'click', tabId: 't1' }, opts), /需要 ref/)
})

check('type 带 pressEnter 布尔值', () => {
  const call = buildCall({ action: 'type', tabId: 't1', ref: 'e2', text: 'hi', pressEnter: true }, opts)
  assert.deepEqual(call.body, { userId: 'u1', text: 'hi', pressEnter: true, ref: 'e2' })
})

check('type 允许空字符串（清空输入框是合法操作）', () => {
  const call = buildCall({ action: 'type', tabId: 't1', ref: 'e2', text: '' }, opts)
  assert.equal(call.body.text, '')
})

check('navigate 用 macro 时不带 url', () => {
  const call = buildCall({ action: 'navigate', tabId: 't1', macro: '@google_search', query: 'x' }, opts)
  assert.deepEqual(call.body, { userId: 'u1', macro: '@google_search', query: 'x' })
  const byUrl = buildCall({ action: 'navigate', tabId: 't1', url: 'https://a.b' }, opts)
  assert.deepEqual(byUrl.body, { userId: 'u1', url: 'https://a.b' })
})

check('screenshot 是 image 类型（走落盘，不进上下文）', () => {
  const call = buildCall({ action: 'screenshot', tabId: 't1' }, opts)
  assert.equal(call.kind, 'image')
})

check('text 走 evaluate 取 innerText', () => {
  const call = buildCall({ action: 'text', tabId: 't1' }, opts)
  assert.equal(call.path, '/tabs/t1/evaluate')
  assert.match(call.body.expression, /innerText/)
})

check('transcript 不需要 tabId', () => {
  const call = buildCall({ action: 'transcript', url: 'https://youtu.be/x' }, opts)
  assert.equal(call.path, '/youtube/transcript')
  assert.equal(call.body.url, 'https://youtu.be/x')
})

check('status 走 /health，不带 tabId', () => {
  const call = buildCall({ action: 'status' }, opts)
  assert.equal(call.method, 'GET')
  assert.equal(call.path, '/health')
})

check('wait 带 timeout 与开关，且需要 tabId', () => {
  const call = buildCall({ action: 'wait', tabId: 't1', timeout: 5000, dismissConsent: true }, opts)
  assert.deepEqual(call.body, { userId: 'u1', timeout: 5000, dismissConsent: true })
  assert.throws(() => buildCall({ action: 'wait' }, opts), /需要 tabId/)
})

check('refresh/back/forward 各自打到对应路由', () => {
  for (const [action, path] of [['refresh', '/tabs/t1/refresh'], ['back', '/tabs/t1/back'], ['forward', '/tabs/t1/forward']]) {
    const call = buildCall({ action, tabId: 't1' }, opts)
    assert.equal(call.method, 'POST')
    assert.equal(call.path, path)
    assert.equal(call.body.userId, 'u1')
  }
})

check('reset 用 userId 清整个会话', () => {
  const call = buildCall({ action: 'reset' }, opts)
  assert.equal(call.method, 'DELETE')
  assert.equal(call.path, '/sessions/u1')
})

check('upload 打到 /tabs/:tabId/upload，支持 path 与 ref/selector', () => {
  const call = buildCall({ action: 'upload', tabId: 't1', path: 'C:\\tmp\\file.png', ref: 'e1' }, opts)
  assert.equal(call.method, 'POST')
  assert.equal(call.path, '/tabs/t1/upload')
  assert.deepEqual(call.body, { userId: 'u1', path: 'C:\\tmp\\file.png', ref: 'e1' })
  assert.throws(() => buildCall({ action: 'upload', tabId: 't1' }, opts), /需要 path/)
})

check('console 打到 /tabs/:tabId/console 并支持参数', () => {
  const call = buildCall({ action: 'console', tabId: 't1', types: 'error,warn', limit: 50, clear: true }, opts)
  assert.equal(call.method, 'GET')
  assert.match(call.path, /^\/tabs\/t1\/console\?/)
  assert.match(call.path, /types=error%2Cwarn/)
  assert.match(call.path, /limit=50/)
  assert.match(call.path, /clear=true/)

  const callStr = buildCall({ action: 'console', tabId: 't1', clear: 'true' }, opts)
  assert.match(callStr.path, /clear=true/)
})

check('network 打到 /tabs/:tabId/network 并支持参数', () => {
  const call = buildCall({ action: 'network', tabId: 't1', resourceTypes: 'fetch,xhr', status: 'failed', clear: true }, opts)
  assert.equal(call.method, 'GET')
  assert.match(call.path, /^\/tabs\/t1\/network\?/)
  assert.match(call.path, /resourceTypes=fetch%2Cxhr/)
  assert.match(call.path, /status=failed/)
  assert.match(call.path, /clear=true/)
})

check('需要 tabId 的 action 缺 tabId 就报错', () => {
  for (const action of ['snapshot', 'click', 'type', 'screenshot', 'text', 'links', 'evaluate', 'wait', 'refresh', 'back', 'forward', 'pin', 'upload', 'console', 'network']) {
    const args = { action, ...(action === 'click' ? { ref: 'e1' } : {}) }
    if (action === 'type') args.text = 'x'
    if (action === 'evaluate') args.expression = '1'
    if (action === 'upload') args.path = '/a'
    assert.throws(() => buildCall(args, opts), /需要 tabId/, `${action} 应报错`)
  }
})

check('tabId 会被 URL 编码（UUID 之外也可能是别的形态）', () => {
  const call = buildCall({ action: 'close', tabId: 'a/b c' }, opts)
  assert.match(call.path, /^\/tabs\/a%2Fb%20c\?/)
})

check('未知 action 报错并列出可用项', () => {
  assert.throws(() => buildCall({ action: 'nope' }, opts), /未知 action/)
})

check('每个搜索宏都能被 navigate 接受', () => {
  for (const macro of SEARCH_MACROS) {
    const call = buildCall({ action: 'navigate', tabId: 't1', macro, query: 'q' }, opts)
    assert.equal(call.body.macro, macro)
  }
})

console.log('shapeResult')

check('text 结果把标题和 URL 顶在前面（支持扁平结构与 evaluate 包装的 result 结构）', () => {
  const flat = shapeResult('text', { title: 'T', url: 'https://u', text: 'body' }, opts)
  assert.match(flat, /^标题：T\nURL：https:\/\/u\n\nbody$/)
  const wrapped = shapeResult('text', { ok: true, result: { title: 'T', url: 'https://u', text: 'body' } }, opts)
  assert.match(wrapped, /^标题：T\nURL：https:\/\/u\n\nbody$/)
})

check('transcript 错误响应能够格式化并提示排障建议', () => {
  const errOut = shapeResult('transcript', { status: 'error', code: 403, message: 'Sign in to confirm you’re not a bot', video_url: 'https://youtu.be/x' }, opts)
  assert.match(errOut, /YouTube 字幕提取失败: 403/)
  assert.match(errOut, /排障建议/)
})

check('snapshot 的 hasMore 会提示 offset', () => {
  const out = shapeResult('snapshot', { snapshot: 'x', hasMore: true, nextOffset: 500 }, opts)
  assert.match(out, /offset=500/)
})

check('snapshot 被 maxChars 截断时，续点按实际展示量算，绝不跳丢', () => {
  // 复现真实事故：后端整段 80k（nextOffset=74800），插件只展示 40k。
  // 旧行为：提示 offset=74800 → 40k..74.8k 之间的 3.48 万字符被静默跳过。
  const big = 'a'.repeat(80000)
  const payload = { snapshot: big, hasMore: true, nextOffset: 74800, url: 'https://e.com' }
  const smallOpts = { ...opts, maxChars: 40000 }
  const out = shapeResult('snapshot', payload, smallOpts, { offset: 0 })
  const m = out.match(/offset=(\d+) 续读/)
  assert.ok(m, `应给出续读提示，实际开头：${out.slice(0, 120)}…`)
  const cont = Number(m[1])
  assert.ok(cont < 74800, `续点 ${cont} 必须小于后端段尾 74800，否则跳丢`)
  assert.ok(cont >= 39000, `续点 ${cont} 应接近实际展示量（~39740）`)
  assert.match(out, /会跳过 \d+ 字符/)
  // 续点之后没有任何内容被跳过：(0, cont) 覆盖展示区，且 cont ≤ 展示量起点单调推进
  const out2 = shapeResult('snapshot', payload, smallOpts, { offset: 39740 })
  const m2 = out2.match(/offset=(\d+) 续读/)
  if (m2) assert.ok(Number(m2[1]) > cont, '第二次续读必须单调前进')
})

check('snapshot 未截断时沿用后端 nextOffset', () => {
  const payload = { snapshot: 'x', hasMore: true, nextOffset: 500, url: 'https://e.com' }
  const out = shapeResult('snapshot', payload, { ...opts, maxChars: 40000 }, { offset: 0 })
  assert.match(out, /用 offset=500 继续/)
  assert.ok(!/会跳过/.test(out), '不该出现跳丢警告')
})

check('snapshot 小窗口 (maxChars < 260) 续点能正常前进不卡死在 0 (S2)', () => {
  const big = 'hello world '.repeat(100)
  const payload = { snapshot: big, hasMore: true, nextOffset: 800, url: 'https://e.com' }
  const tinyOpts = { ...opts, maxChars: 120 }
  const out = shapeResult('snapshot', payload, tinyOpts, { offset: 0 })
  const m = out.match(/offset=(\d+) 续读/)
  assert.ok(m, '小窗口也应给出续读提示')
  const cont = Number(m[1])
  assert.ok(cont > 0, `续点必须大于 0，避免死循环；实际: ${cont}`)
})

check('snapshot 为对象时不按格式化 JSON 偏移，直接沿用 backendNext (S3)', () => {
  const objPayload = {
    snapshot: { type: 'tree', nodes: [{ id: 1, name: 'root' }, { id: 2, name: 'child' }] },
    hasMore: true,
    nextOffset: 600,
  }
  const out = shapeResult('snapshot', objPayload, { ...opts, maxChars: 50 }, { offset: 0 })
  assert.match(out, /用 offset=600 继续/, '对象快照应直接使用后端的 nextOffset')
  assert.ok(!/别用后端段尾/.test(out), '对象快照不应出现文本切片跳丢警告')
})

check('formatStatus 报告归属与能力', () => {
  const health = { ok: true, engine: 'camoufox', browserConnected: true, browserRunning: true, activeTabs: 1, activeSessions: 1, memory: { rssMb: 133 } }
  const caps = { baseUrl: 'http://127.0.0.1:9377', managed: false, pin: true, ytDlp: false, ytDlpVersion: '', interactive: 'desktop', notes: ['note me'] }
  const out = formatStatus(health, caps)
  assert.match(out, /复用外部实例/)
  assert.match(out, /pin：支持/)
  assert.match(out, /浏览器兜底/)
  assert.match(out, /interactive=desktop/)
  assert.match(out, /note me/)
  const out2 = formatStatus(health, { ...caps, pin: false, managed: true, ytDlp: true, ytDlpVersion: '2026.10.0' })
  assert.match(out2, /本插件托管/)
  assert.match(out2, /pin：不支持/)
  assert.match(out2, /快路径/)
})

check('formatStatus 在脱机/未运行时正确报告未运行 (S1)', () => {
  const health = {}
  const caps = { baseUrl: 'http://127.0.0.1:9377', managed: false, pin: false, ytDlp: false, ytDlpVersion: '', interactive: 'off', notes: [] }
  const out = formatStatus(health, caps)
  assert.match(out, /服务：未运行/)
  assert.match(out, /服务未连接或未就绪/)
})

check('upload/console/network 结果被友好格式化', () => {
  const up = shapeResult('upload', { ok: true, attached: ['/data/a.png'], via: 'panel_input' }, opts)
  assert.match(up, /文件上传成功/)
  assert.match(up, /panel_input/)

  const cons = shapeResult('console', { total: 1, count: 1, logs: [{ type: 'warn', text: 'deprecated api', timestamp: 1700000000000 }] }, opts)
  assert.match(cons, /控制台日志/)
  assert.match(cons, /\[WARN\] deprecated api/)

  const net = shapeResult('network', { total: 1, count: 1, requests: [{ method: 'POST', url: 'https://x.com/api', status: 200, durationMs: 45 }] }, opts)
  assert.match(net, /网络请求/)
  assert.match(net, /\[POST\] https:\/\/x\.com\/api -> 200 \(45ms\)/)
})

check('超长结果被截断', () => {
  const out = shapeResult('text', { text: 'a'.repeat(5000) }, { ...opts, maxChars: 100 })
  assert.ok(out.length < 300, `实际长度 ${out.length}`)
  assert.match(out, /已截断/)
})

check('set_cookies 支持数组和分号字符串格式', () => {
  const fromStr = buildCall({ action: 'set_cookies', cookies: 'a=1; b=2', domain: '.example.com' }, opts)
  assert.equal(fromStr.method, 'POST')
  assert.equal(fromStr.path, '/sessions/u1/cookies')
  assert.deepEqual(fromStr.body.cookies, [
    { name: 'a', value: '1', domain: '.example.com', path: '/' },
    { name: 'b', value: '2', domain: '.example.com', path: '/' },
  ])
  const fromArr = buildCall({ action: 'set_cookies', cookies: [{ name: 'x', value: 'y', domain: '.a.b' }] }, opts)
  assert.deepEqual(fromArr.body.cookies, [{ name: 'x', value: 'y', domain: '.a.b' }])
})

check('trace 接受 subAction 且需要 tabId', () => {
  const traceCall = buildCall({ action: 'trace', tabId: 't1', subAction: 'click', ref: 'e1' }, opts)
  assert.equal(traceCall.action, 'trace')
  assert.equal(traceCall.kind, 'composite')
  assert.throws(() => buildCall({ action: 'trace', tabId: 't1' }, opts), /需要 subAction/)
})

check('null 响应不炸', () => {
  assert.equal(shapeResult('text', null, opts), '(空响应)')
})

console.log('run / text / session')

check('run：steps 注入内置工具（含新增三个）且可执行', () => {
  const call = buildCall({ action: 'run', tabId: 't1', steps: 'return 1' }, opts)
  assert.equal(call.path, '/tabs/t1/evaluate')
  for (const fn of ['const sleep', 'const wait =', 'const waitUntil', 'const setValue', 'const clickByText', 'const scrollIntoViewClick', 'const waitResponse', 'const download']) {
    assert.ok(call.body.expression.includes(fn), `prelude 缺 ${fn}`)
  }
  assert.throws(() => buildCall({ action: 'run', tabId: 't1' }, opts), /需要 steps/)
})

check('run：select 单字段只回该叶子', () => {
  const out = shapeResult('run', { ok: true, result: { a: { b: 7 }, c: 8 } }, opts, { select: 'a.b' })
  assert.equal(out, '7')
})

check('run：select 多字段按叶子名组对象，冲突回退全路径', () => {
  const out = shapeResult('run', { ok: true, result: { name: 'n', nested: { id: 3 } } }, opts, { select: 'name, nested.id' })
  assert.deepEqual(JSON.parse(out), { name: 'n', id: 3 })
  const clash = projectRunResult({ a: { x: 1 }, b: { x: 2 } }, { select: 'a.x, b.x' })
  assert.deepEqual(JSON.parse(clash), { x: 1, 'b.x': 2 })
})

check('run：不传 select 回全量；select 未命中给出提示', () => {
  assert.deepEqual(JSON.parse(shapeResult('run', { ok: true, result: [1, 2] }, opts)), [1, 2])
  assert.match(shapeResult('run', { ok: true, result: { a: 1 } }, opts, { select: 'zzz' }), /未命中/)
})

check('run：maxChars 生效（真正省 token）', () => {
  const out = shapeResult('run', { ok: true, result: { blob: 'a'.repeat(5000) } }, { ...opts, maxChars: 40000 }, { maxChars: 100 })
  assert.ok(out.length < 300, `实际 ${out.length}`)
  assert.match(out, /已截断/)
})

check('pickPath 支持数组下标与缺失路径', () => {
  assert.equal(pickPath({ a: [{ b: 'x' }] }, 'a.0.b'), 'x')
  assert.equal(pickPath({ a: 1 }, 'a.b.c'), undefined)
  assert.equal(pickPath(null, 'a'), undefined)
})

check('text：带 selector 时只取该区块，且表达式含选择器', () => {
  const call = buildCall({ action: 'text', tabId: 't1', selector: '.main' }, opts)
  assert.match(call.body.expression, /\.main/)
  assert.match(call.body.expression, /querySelector/)
  assert.match(buildCall({ action: 'text', tabId: 't1' }, opts).body.expression, /document\.body/)
})

check('text：selector 未命中给出明确提示', () => {
  const out = shapeResult('text', { ok: true, result: { found: false, selector: '.nope', url: 'https://e' } }, opts)
  assert.match(out, /未找到选择器 \.nope/)
})

check('session：GET /sessions/:userId，输出含 UA 家族与标签数', () => {
  const call = buildCall({ action: 'session' }, opts)
  assert.equal(call.method, 'GET')
  assert.equal(call.path, '/sessions/u1')
  const out = shapeResult('session', { userId: 'u1', exists: true, userAgent: 'Mozilla/5.0 Chrome/142.0.0.0', tabCount: 2 }, opts)
  assert.match(out, /标签页数：2/)
  assert.match(out, /Chrome UA/)
  const def = shapeResult('session', { userId: 'u1', exists: true, userAgent: '', tabCount: 0 }, opts)
  assert.match(def, /Firefox（默认）/)
})

check('drag：handle + deltaX 拖滑块（原生可信拖拽语义）', () => {
  const call = buildCall({ action: 'drag', tabId: 't1', handle: 'e12', deltaX: 266, steps: 24, durationMs: 900, easing: 'easeInOut', jitterPx: 1.5 }, opts)
  assert.equal(call.method, 'POST')
  assert.equal(call.path, '/tabs/t1/drag')
  assert.deepEqual(call.body, { userId: 'u1', handle: 'e12', deltaX: 266, steps: 24, durationMs: 900, easing: 'easeInOut', jitterPx: 1.5 })
})

check('drag：start + end 坐标', () => {
  const call = buildCall({ action: 'drag', tabId: 't1', start: { x: 10, y: 20 }, end: { x: 110, y: 20 } }, opts)
  assert.deepEqual(call.body, { userId: 'u1', start: { x: 10, y: 20 }, end: { x: 110, y: 20 } })
})

check('drag：缺起点或终点都报错', () => {
  assert.throws(() => buildCall({ action: 'drag', tabId: 't1', deltaX: 10 }, opts), /需要 start/)
  assert.throws(() => buildCall({ action: 'drag', tabId: 't1', handle: 'e1' }, opts), /需要 end/)
})

check('challenge：打到 /verification/challenge', () => {
  const call = buildCall({ action: 'challenge', tabId: 't1' }, opts)
  assert.equal(call.method, 'POST')
  assert.equal(call.path, '/verification/challenge')
  assert.deepEqual(call.body, { userId: 'u1', tabId: 't1' })
})

check('dialog：打到 /verification/dialog 并带 policy/reset', () => {
  const call = buildCall({ action: 'dialog', tabId: 't1', policy: 'accept' }, opts)
  assert.equal(call.path, '/verification/dialog')
  assert.deepEqual(call.body, { userId: 'u1', tabId: 't1', policy: 'accept' })
  const reset = buildCall({ action: 'dialog', tabId: 't1', reset: true }, opts)
  assert.equal(reset.body.reset, true)
})

check('challenge 结果给出滑块建议', () => {
  const out = shapeResult('challenge', {
    tabId: 't1', count: 1, dialogPolicy: 'dismiss', lastDialog: null,
    challenges: [{ kind: 'slider', selector: '.slide-verify', box: { x: 1, y: 2, width: 300, height: 40 }, suggestedDrag: { start: { x: 20, y: 22 }, deltaX: 260 } }],
  }, opts)
  assert.match(out, /slider/)
  assert.match(out, /滑块建议：action=drag/)
  assert.match(out, /deltaX=260/)
})

check('dialog 结果展示策略与最近弹窗', () => {
  const out = shapeResult('dialog', { dialogPolicy: 'accept', supportedPolicies: ['dismiss', 'accept', 'auto'], lastDialog: { type: 'confirm', message: 'go?' } }, opts)
  assert.match(out, /弹窗策略：accept/)
  assert.match(out, /confirm/)
})

check('drag 结果一句话概括', () => {
  const out = shapeResult('drag', { start: { x: 1, y: 2 }, end: { x: 3, y: 2 }, steps: 12, durationMs: 800, easing: 'linear', button: 'left' }, opts)
  assert.match(out, /拖拽完成/)
})

console.log('新动作与优化验证')

check('click 支持直接通过 text 参数点击', () => {
  const call = buildCall({ action: 'click', tabId: 't1', text: '登录' }, opts)
  assert.equal(call.method, 'POST')
  assert.equal(call.path, '/tabs/t1/evaluate')
  assert.match(call.body.expression, /click: 未找到包含文本的元素/)
  assert.match(call.body.expression, /"登录"/)
})

check('evaluate 和 run 支持 timeoutMs 透传', () => {
  const evalCall = buildCall({ action: 'evaluate', tabId: 't1', expression: '1+1', timeoutMs: 60000 }, opts)
  assert.equal(evalCall.body.timeoutMs, 60000)
  const runCall = buildCall({ action: 'run', tabId: 't1', steps: 'return 42', timeoutMs: 120000 }, opts)
  assert.equal(runCall.body.timeoutMs, 120000)
})

check('video 动作生成完整视频控制脚本并支持倍速、Keeper与自动保存', () => {
  const call = buildCall({ action: 'video', tabId: 't1', rate: 16, autoSave: '保存学习进度', seek: 100 }, opts)
  assert.equal(call.path, '/tabs/t1/evaluate')
  assert.match(call.body.expression, /targetRate = 16/)
  assert.match(call.body.expression, /doKeepAlive = true/)
  assert.match(call.body.expression, /"保存学习进度"/)
  assert.match(call.body.expression, /seekTarget = 100/)

  const res = shapeResult('video', { ok: true, dur: 3000, t: 1500, pct: 50.0, rate: 16, paused: false, ended: false, saved: false, keeperInstalled: true, videoCount: 1 }, opts)
  assert.match(res, /1500\/3000s/)
  assert.match(res, /50%/)
  assert.match(res, /16x/)
  assert.match(res, /Keeper守护已开启/)
})

check('capture_element 校验参数并标记为 composite', () => {
  assert.throws(() => buildCall({ action: 'capture_element', tabId: 't1' }, opts), /需要 ref（如 e1）或 selector/)
  const call = buildCall({ action: 'capture_element', tabId: 't1', selector: 'canvas.code' }, opts)
  assert.equal(call.action, 'capture_element')
  assert.equal(call.kind, 'composite')
})

check('puzzle_gap 打到 /verification/puzzle-gap 并且 shapeResult 给出建议拖拽指令', () => {
  const call = buildCall({ action: 'puzzle_gap', tabId: 't1', bgSelector: '#bg', pieceSelector: '#slice' }, opts)
  assert.equal(call.path, '/verification/puzzle-gap')
  assert.deepEqual(call.body, { userId: 'u1', tabId: 't1', bgSelector: '#bg', pieceSelector: '#slice' })

  const out = shapeResult('puzzle_gap', {
    ok: true,
    deltaX: 180,
    confidence: 0.9,
    suggestedDrag: { handle: '#btn', start: { x: 50, y: 100 }, deltaX: 180, easing: 'easeInOut', jitterPx: 2, overshootPx: 6, durationMs: 850 }
  }, opts)
  assert.match(out, /deltaX: 180px/)
  assert.match(out, /置信度: 90%/)
  assert.match(out, /action="drag"/)
  assert.match(out, /easing="easeInOut"/)
})

check('auth_export 和 auth_import 规格与格式化', () => {
  const expCall = buildCall({ action: 'auth_export' }, opts)
  assert.equal(expCall.method, 'GET')
  assert.equal(expCall.path, '/sessions/u1/storage_state')

  const expOut = shapeResult('auth_export', { cookies: [{ name: 'a', value: '1' }], origins: [{ origin: 'https://example.com' }] }, opts)
  assert.match(expOut, /共 1 条 Cookies/)
  assert.match(expOut, /1 个 Origin/)

  const impCall = buildCall({ action: 'auth_import' }, opts)
  assert.equal(impCall.action, 'auth_import')
  assert.equal(impCall.kind, 'composite')
})

check('evaluate 对双重序列化 JSON 自动反序列化格式化', () => {
  const out = shapeResult('evaluate', { ok: true, result: JSON.stringify({ code: 200, status: 'ok' }) }, opts)
  assert.match(out, /"code": 200/)
  assert.match(out, /"status": "ok"/)
})

check('video Keeper 用自调度 setTimeout（不累积漂移），可关闭且状态真实', () => {
  const call = buildCall({ action: 'video', tabId: 't1' }, opts)
  const src = call.body.expression
  assert.match(src, /setTimeout\(keeperTick/)
  assert.ok(!src.includes('setInterval('), 'Keeper 不应再用 setInterval（会累积漂移）')
  assert.match(src, /keeperState\.nextAt/)
  assert.match(src, /clearTimeout/)
  assert.match(src, /keeperAlive\(\)/)
  // 关闭 keeper 时也必须停掉已装的定时器
  assert.match(src, /else if \(window\.__camofox_video_keeper_state\)/)
  const off = buildCall({ action: 'video', tabId: 't1', keepAlive: false }, opts)
  assert.match(off.body.expression, /doKeepAlive = false/)
})

check('puzzle_gap 支持 colorMode / edgeFallback 透传', () => {
  const call = buildCall({ action: 'puzzle_gap', tabId: 't1', colorMode: 'hsv', edgeFallback: false }, opts)
  assert.equal(call.path, '/verification/puzzle-gap')
  assert.deepEqual(call.body, { userId: 'u1', tabId: 't1', colorMode: 'hsv', edgeFallback: false })
  const auto = buildCall({ action: 'puzzle_gap', tabId: 't1', colorMode: 'auto' }, opts)
  assert.equal(auto.body.colorMode, 'auto')
  assert.equal(auto.body.edgeFallback, undefined, '默认不显式发送 edgeFallback')
})

check('dialog 支持按域名作用域与清除覆盖', () => {
  const scoped = buildCall({ action: 'dialog', tabId: 't1', domain: 'login.example.com', policy: 'accept' }, opts)
  assert.deepEqual(scoped.body, { userId: 'u1', tabId: 't1', policy: 'accept', domain: 'login.example.com' })
  const clear = buildCall({ action: 'dialog', tabId: 't1', clearDomain: 'login.example.com' }, opts)
  assert.equal(clear.body.clearDomain, 'login.example.com')
  const clearAll = buildCall({ action: 'dialog', tabId: 't1', clearDomains: true }, opts)
  assert.equal(clearAll.body.clearDomains, true)
})

check('dialog 结果展示域名覆盖与当前生效策略', () => {
  const out = shapeResult('dialog', {
    dialogPolicy: 'dismiss',
    supportedPolicies: ['dismiss', 'accept', 'auto'],
    host: 'login.example.com',
    effectivePolicy: 'accept',
    dialogPolicyByDomain: { 'login.example.com': 'accept' },
    lastDialog: null,
  }, opts)
  assert.match(out, /login\.example\.com -> accept/)
  assert.match(out, /实际生效：accept/)
})

check('puzzle_gap 输出带识别方法/色彩空间', () => {
  const out = shapeResult('puzzle_gap', { ok: true, deltaX: 100, confidence: 0.8, method: 'edge', colorMode: 'edge' }, opts)
  assert.match(out, /方法: edge/)
})

check('video/run/click 生成的页面脚本语法可解析', () => {
  for (const args of [
    { action: 'video', tabId: 't1' },
    { action: 'video', tabId: 't1', mainWorld: true, autoSave: '保存', seek: 10, queryOnly: true },
    { action: 'run', tabId: 't1', steps: 'return 1' },
    { action: 'click', tabId: 't1', text: '登录' },
  ]) {
    const call = buildCall(args, opts)
    assert.doesNotThrow(() => new Function('return ' + call.body.expression), `${args.action} 脚本语法错误`)
  }
})

check('open 默认不复用标签页，reuseTab:true 才透传', () => {
  const plain = buildCall({ action: 'open', url: 'https://e.com' }, opts)
  assert.equal(plain.body.reuseTab, undefined, 'open 默认必须新开标签页')
  const reuse = buildCall({ action: 'open', url: 'https://e.com', reuseTab: true }, opts)
  assert.equal(reuse.body.reuseTab, true)
})

check('新增动作缺 tabId 也会提前报错', () => {
  for (const action of ['drag', 'challenge', 'dialog', 'video', 'capture_element', 'puzzle_gap']) {
    assert.throws(() => buildCall({ action }, opts), /需要 tabId/, `${action} 应报错`)
  }
})

check('drag 支持 overshootBounds（控件级过冲钳制）', () => {
  const call = buildCall({
    action: 'drag', tabId: 't1', handle: 'e12', deltaX: 266,
    overshootBounds: { x: 320, y: 480, width: 300, height: 40 },
  }, opts)
  assert.deepEqual(call.body.overshootBounds, { x: 320, y: 480, width: 300, height: 40 })
  assert.throws(() => buildCall({
    action: 'drag', tabId: 't1', handle: 'e1', deltaX: 10,
    overshootBounds: { width: 0, height: 10 },
  }, opts), /overshootBounds/)
})

check('challenge/puzzle_gap 的建议拖拽指令自带 overshootBounds', () => {
  const challenge = shapeResult('challenge', {
    tabId: 't1', count: 1, dialogPolicy: 'dismiss',
    challenges: [{
      kind: 'slider', selector: '.s',
      box: { x: 320, y: 480, width: 300, height: 40 },
      suggestedDrag: { start: { x: 340, y: 500 }, deltaX: 260 },
    }],
  }, opts)
  assert.match(challenge, /overshootBounds=\{x:320,y:480,width:300,height:40\}/)

  const gap = shapeResult('puzzle_gap', {
    ok: true, deltaX: 180, confidence: 0.9,
    bgBox: { x: 10, y: 20, width: 300, height: 150 },
    suggestedDrag: {
      handle: '#btn', start: { x: 50, y: 100 }, deltaX: 180,
      easing: 'easeInOut', jitterPx: 2, overshootPx: 6, durationMs: 850,
    },
  }, opts)
  assert.match(gap, /overshootBounds=\{x:10,y:20,width:300,height:150\}/)
})

check('dialog 结果显示域名覆盖计数与上限', () => {
  const out = shapeResult('dialog', {
    dialogPolicy: 'dismiss',
    supportedPolicies: ['dismiss', 'accept', 'auto'],
    domainPolicyCount: 3,
    domainPolicyLimit: 32,
    dialogPolicyByDomain: { 'a.example.com': 'accept' },
    lastDialog: null,
  }, opts)
  assert.match(out, /按域名覆盖（3\/32）/)
})

console.log(`\n${passed} 项通过`)
