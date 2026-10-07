// test-transport-switch.mjs - verifies that tools/webvpn-proxy.mjs picks the right
// transport on campus and off campus, without needing both networks at once.
//
// The adapter cannot be tested against the real campus login from here, so this stands up
// a fake site, a fake campus-login host and a fake WebVPN gateway, then drives the real
// adapter (spawned unmodified) through every case:
//
//   A  campus       site answers 401 to the probe, /v1 works      -> direct, gateway untouched
//   B  off campus   probe follows a 307 to the campus login       -> gateway, ticket sent
//   C  stale session gateway answers 302 /login                    -> 401 with the re-login hint
//   D  network moves direct works, then starts bouncing mid-cache  -> switches on the request
//   E  site down    direct unreachable                             -> falls back to the gateway
//
// Run with the DSH runtime node:
//   node test-transport-switch.mjs

import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'

const ADAPTER = process.argv[2] || path.join(os.homedir(), '.dsh', 'madmodel', 'webvpn-proxy.mjs')
const NODE = process.execPath
const TICKET = 'test-ticket-1234567890'
const SITE_PORT = 8801
const LOGIN_PORT = 8802
const GW_PORT = 8803
const DIRECT = `http://localhost:${SITE_PORT}`          // 'localhost' so a bounce to 127.0.0.1 is a host change
const GW_PREFIX = `http://127.0.0.1:${GW_PORT}/https/abc123`

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail })
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  - ' + detail : ''}`)
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

// ---------------------------------------------------------------- fake servers
let siteMode = 'campus'          // 'campus' | 'offcampus' | 'down'
const siteHits = []
const gwHits = []

const site = http.createServer((req, res) => {
  siteHits.push(req.method + ' ' + req.url)
  if (siteMode === 'down') { try { req.socket.destroy() } catch (e) {} return }
  if (siteMode === 'offcampus' && !/auth-login/.test(req.url)) {
    res.writeHead(307, { location: `http://127.0.0.1:${LOGIN_PORT}/lb-auth/lbredirect` })
    return res.end()
  }
  if (/auth-login/.test(req.url)) {
    if (siteMode === 'offcampus') {
      res.writeHead(307, { location: `http://127.0.0.1:${LOGIN_PORT}/login` })
      return res.end()
    }
    res.writeHead(401, { 'content-type': 'application/json' })
    return res.end('{"status":10001,"message":"unauthorized"}')
  }
  if (/\/v1\/chat\/completions/.test(req.url)) {
    res.writeHead(200, { 'content-type': 'application/json' })
    return res.end(JSON.stringify({ content: 'pong-direct', via: 'site' }))
  }
  res.writeHead(404, { 'content-type': 'application/json' })
  res.end('{"error":"not found"}')
})

const login = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html' })
  res.end('<html><title>清华大学统一身份认证</title></html>')
})

const gw = http.createServer((req, res) => {
  const cookie = req.headers.cookie || ''
  gwHits.push({ url: req.url, cookie })
  if (!cookie.includes('wengine_vpn_ticket=')) {
    res.writeHead(302, { location: '/login' })
    return res.end()
  }
  if (/auth-login/.test(req.url)) {
    res.writeHead(200, { 'content-type': 'application/json' })
    return res.end('{"success":true}')
  }
  if (/\/v1\/models/.test(req.url)) {
    res.writeHead(200, { 'content-type': 'text/html' })
    return res.end('<html>portal</html>')
  }
  if (/\/v1\/chat\/completions/.test(req.url)) {
    res.writeHead(200, { 'content-type': 'application/json' })
    return res.end(JSON.stringify({ content: 'pong-gateway', via: 'gateway' }))
  }
  res.writeHead(404, { 'content-type': 'application/json' })
  res.end('{}')
})

// ------------------------------------------------------- throwaway DSH home
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-transport-'))
fs.mkdirSync(path.join(HOME, '.dsh', 'madmodel'), { recursive: true })
fs.writeFileSync(path.join(HOME, '.dsh', 'madmodel', 'state.json'), JSON.stringify({
  cookieJar: [{ name: 'wengine_vpn_ticket', domain: '.webvpn.tsinghua.edu.cn', value: TICKET }],
}))
fs.writeFileSync(path.join(HOME, '.dsh', 'madmodel', 'webvpn.json'), JSON.stringify({ models: ['DeepSeek-V4.1-Flash'] }))

function startAdapter (port, extraEnv = {}) {
  const child = spawn(NODE, [ADAPTER, '--gw', GW_PREFIX], {
    env: {
      ...process.env,
      USERPROFILE: HOME, HOME,
      MADMODEL_PROXY_PORT: String(port),
      MADMODEL_DIRECT_BASE: DIRECT,
      MADMODEL_PROBE_TTL_MS: '600000',
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const log = []
  child.stdout.on('data', d => log.push(String(d)))
  child.stderr.on('data', d => log.push(String(d)))
  return { child, log }
}

async function waitReady (port, tries = 40) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(800) })
      // healthz reports "(probing)" for the few ms the startup probe takes, so wait for a
      // settled transport instead of just for a 200.
      if (r.ok) {
        const h = await r.json()
        if (h.transport && h.transport !== '(probing)') return h
      }
    } catch (e) {}
    await sleep(150)
  }
  return null
}

async function ask (port) {
  const r = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer tok' },
    body: JSON.stringify({ model: 'DeepSeek-V4.1-Flash', messages: [{ role: 'user', content: 'hi' }] }),
    signal: AbortSignal.timeout(10000),
  })
  let body = null
  try { body = await r.json() } catch (e) {}
  return { status: r.status, body }
}

const stop = (p) => new Promise(r => { p.once('close', r); p.kill() })

// ---------------------------------------------------------------------- cases
async function main () {
  await new Promise(r => site.listen(SITE_PORT, '127.0.0.1', r))
  await new Promise(r => login.listen(LOGIN_PORT, '127.0.0.1', r))
  await new Promise(r => gw.listen(GW_PORT, '127.0.0.1', r))
  console.log(`adapter: ${ADAPTER}`)
  console.log(`fake site ${DIRECT} | fake campus login 127.0.0.1:${LOGIN_PORT} | fake gateway ${GW_PREFIX}\n`)

  // A - on campus
  console.log('A. on campus: the site answers for itself')
  siteMode = 'campus'; gwHits.length = 0; siteHits.length = 0
  let a = startAdapter(8791)
  let h = await waitReady(8791)
  check('A healthz reports transport=direct', h && h.transport === 'direct', JSON.stringify(h && h.transport))
  let res = await ask(8791)
  check('A completion served by the site', res.status === 200 && res.body && res.body.content === 'pong-direct', `status=${res.status} body=${JSON.stringify(res.body)}`)
  check('A gateway never contacted', gwHits.length === 0, `gateway hits=${gwHits.length}`)
  res = await fetch('http://127.0.0.1:8791/v1/models').then(r => r.json()).catch(() => null)
  check('A /v1/models synthesised locally', res && res.object === 'list' && res.data.length === 1)
  await stop(a.child)

  // B - off campus
  console.log('\nB. off campus: the probe is bounced to the campus login')
  siteMode = 'offcampus'; gwHits.length = 0
  let b = startAdapter(8792)
  h = await waitReady(8792)
  check('B healthz reports transport=gateway', h && h.transport === 'gateway', JSON.stringify(h && h.transport))
  res = await ask(8792)
  check('B completion served by the gateway', res.status === 200 && res.body && res.body.content === 'pong-gateway', `status=${res.status} body=${JSON.stringify(res.body)}`)
  check('B the WebVPN ticket was sent as a cookie', gwHits.some(x => x.cookie.includes('wengine_vpn_ticket=' + TICKET)), `gateway hits=${gwHits.length}`)
  await stop(b.child)

  // C - the gateway session is gone
  console.log('\nC. off campus with a stale WebVPN session')
  siteMode = 'offcampus'
  fs.writeFileSync(path.join(HOME, '.dsh', 'madmodel', 'state.json'), JSON.stringify({ cookieJar: [] }))
  let c = startAdapter(8793, { WEBVPN_TICKET: '' })
  h = await waitReady(8793)
  res = await ask(8793)
  check('C answers 401 with the re-login hint', res.status === 401 && /WebVPN|重新登录/.test(JSON.stringify(res.body)), `status=${res.status} body=${JSON.stringify(res.body)}`)
  await stop(c.child)
  fs.writeFileSync(path.join(HOME, '.dsh', 'madmodel', 'state.json'), JSON.stringify({
    cookieJar: [{ name: 'wengine_vpn_ticket', domain: '.webvpn.tsinghua.edu.cn', value: TICKET }],
  }))

  // D - the network moves while the adapter is up: direct is cached, then starts bouncing
  console.log('\nD. the network moves under a running adapter (cached direct)')
  siteMode = 'campus'; gwHits.length = 0
  let d = startAdapter(8794)
  h = await waitReady(8794)
  check('D starts on direct', h && h.transport === 'direct')
  res = await ask(8794)
  check('D first answer comes from the site', res.body && res.body.content === 'pong-direct')
  siteMode = 'offcampus'                       // the laptop moved off campus; the 600 s cache still says direct
  res = await ask(8794)
  check('D switches to the gateway on the spot', res.status === 200 && res.body && res.body.content === 'pong-gateway', `status=${res.status} body=${JSON.stringify(res.body)}`)
  h = await fetch('http://127.0.0.1:8794/healthz').then(r => r.json())
  check('D healthz now reports transport=gateway', h.transport === 'gateway', h.transport)
  const dlog = d.log.join('')
  check('D the switch is logged', /transport direct -> gateway/.test(dlog), dlog.match(/transport direct -> gateway[^\n]*/)?.[0] || 'not logged')
  await stop(d.child)

  // E - the site is unreachable at startup
  console.log('\nE. site unreachable at startup')
  siteMode = 'down'
  let e = startAdapter(8795)
  h = await waitReady(8795)
  check('E healthz reports transport=gateway', h && h.transport === 'gateway', JSON.stringify(h && h.transport))
  res = await ask(8795)
  check('E still serves through the gateway', res.status === 200 && res.body && res.body.content === 'pong-gateway', `status=${res.status}`)
  await stop(e.child)

  siteMode = 'campus'
  site.close(); login.close(); gw.close()
  try { fs.rmSync(HOME, { recursive: true, force: true }) } catch (err) {}

  const failed = results.filter(r => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
  console.log(failed.length ? 'RESULT: FAIL - ' + failed.map(f => f.name).join(', ') : 'RESULT: PASS - transport switch behaves on campus, off campus, and when the network moves')
  process.exit(failed.length ? 1 : 0)
}

main().catch((e) => { console.error('test error:', e); process.exit(2) })
