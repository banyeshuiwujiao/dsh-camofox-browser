/**
 * dsh-camofox-browser 自测 —— 只测纯函数，不碰网络、不起浏览器。
 *
 *   node test/smoke.mjs
 *
 * 断言的是「工具参数 → REST 规格」的翻译层。这层最容易悄悄坏：路径拼错、
 * 漏掉 userId/sessionKey、把 ref 和 selector 混淆，都要在发请求前就抓住。
 */

import assert from 'node:assert/strict'
import { buildCall, shapeResult, DEFAULTS, SEARCH_MACROS } from '../lib/index.js'

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

check('reset 用 userId 清整个会话', () => {
  const call = buildCall({ action: 'reset' }, opts)
  assert.equal(call.method, 'DELETE')
  assert.equal(call.path, '/sessions/u1')
})

check('需要 tabId 的 action 缺 tabId 就报错', () => {
  for (const action of ['snapshot', 'click', 'type', 'screenshot', 'text', 'links', 'evaluate']) {
    const args = { action, ...(action === 'click' ? { ref: 'e1' } : {}) }
    if (action === 'type') args.text = 'x'
    if (action === 'evaluate') args.expression = '1'
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

check('超长结果被截断', () => {
  const out = shapeResult('text', { text: 'a'.repeat(5000) }, { ...opts, maxChars: 100 })
  assert.ok(out.length < 300, `实际长度 ${out.length}`)
  assert.match(out, /已截断/)
})

check('null 响应不炸', () => {
  assert.equal(shapeResult('text', null, opts), '(空响应)')
})

console.log(`\n${passed} 项通过`)
