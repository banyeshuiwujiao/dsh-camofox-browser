/**
 * dsh-camofox-browser 自测 —— 只测纯函数，不碰网络、不起浏览器。
 *
 *   node test/smoke.mjs
 *
 * 断言的是「工具参数 → REST 规格」的翻译层。这层最容易悄悄坏：路径拼错、
 * 漏掉 userId/sessionKey、把 ref 和 selector 混淆，都要在发请求前就抓住。
 */

import assert from 'node:assert/strict'
import { buildCall, shapeResult, formatStatus, DEFAULTS, SEARCH_MACROS } from '../lib/index.js'

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
})

check('network 打到 /tabs/:tabId/network 并支持参数', () => {
  const call = buildCall({ action: 'network', tabId: 't1', resourceTypes: 'fetch,xhr', status: 'failed' }, opts)
  assert.equal(call.method, 'GET')
  assert.match(call.path, /^\/tabs\/t1\/network\?/)
  assert.match(call.path, /resourceTypes=fetch%2Cxhr/)
  assert.match(call.path, /status=failed/)
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

check('超长结果被截断', () => {
  const out = shapeResult('text', { text: 'a'.repeat(5000) }, { ...opts, maxChars: 100 })
  assert.ok(out.length < 300, `实际长度 ${out.length}`)
  assert.match(out, /已截断/)
})

check('null 响应不炸', () => {
  assert.equal(shapeResult('text', null, opts), '(空响应)')
})

console.log(`\n${passed} 项通过`)
