// webvpn-proxy.mjs - off-campus transport adapter for madmodel.cs.tsinghua.edu.cn.
//
// Why this exists: off campus every direct request to madmodel.cs.tsinghua.edu.cn
// answers 307 to https://oauth.tsinghua.edu.cn/lb-auth/lbredirect (TsinghuaLB), so
//   * thu-tok-auto cannot validate a captured token (it treats the redirect as
//     "server rejected the token"), and
//   * DSH cannot call /v1/chat/completions at all.
// Through the WebVPN gateway the same requests answer 200, but the gateway needs
// the `wengine_vpn_ticket` cookie, which DSH's LLM client has no way to send.
//
// This process listens on 127.0.0.1:8788, reads the ticket from thu-tok-auto's
// state file on every request (so it follows re-logins automatically), injects it
// as a Cookie header, and streams the gateway's response back - including SSE.
//
//   GET  /healthz              local status (gateway prefix, ticket present/length)
//   GET  /v1/models            JSON list (the gateway answers this path with its own
//                              portal HTML, so the list is synthesised locally)
//   *    everything else       forwarded verbatim to <gateway><path><query>
//
// Gateway prefix resolution order: --gw <prefix> | webvpn.json "gateway" | live CDP
// tab (ports 9333-9343). Ticket order: state.json cookieJar | WEBVPN_TICKET | config.
//
// No dependencies; Node 22+ (global fetch/WebSocket). Run it with the DSH runtime's
// node, e.g.:
//   node webvpn-proxy.mjs            # listens on 127.0.0.1:8788

import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'

const HOME = os.homedir()
const BASE_DIR = path.join(HOME, '.dsh', 'madmodel')
const CONF = path.join(BASE_DIR, 'webvpn.json')
const STATE = path.join(BASE_DIR, 'state.json')
const PORT = Number(process.env.MADMODEL_PROXY_PORT || 8788)
const CDP_PORTS = [9333, 9334, 9335, 9336, 9337, 9338, 9339, 9340, 9341, 9342, 9343]
const DEFAULT_MODELS = ['DeepSeek-V4.1-Flash', 'qwen3.8-27b']

function readConf () {
  try { return JSON.parse(fs.readFileSync(CONF, 'utf8')) } catch (e) { return {} }
}
const conf = readConf()

function argValue (name) {
  const i = process.argv.indexOf(name)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : ''
}

let gateway = (argValue('--gw') || conf.gateway || '').replace(/\/+$/, '')
let ticketCache = { at: 0, value: '' }

function ticketValue () {
  if (Date.now() - ticketCache.at < 2000) return ticketCache.value
  let v = ''
  try {
    const s = JSON.parse(fs.readFileSync(STATE, 'utf8'))
    for (const c of (s.cookieJar || [])) {
      if (c && c.name === 'wengine_vpn_ticket' && String(c.domain || '').includes('webvpn')) { v = String(c.value || ''); break }
    }
  } catch (e) {}
  if (!v) v = String(process.env.WEBVPN_TICKET || conf.ticket || '')
  // A rotation mid-answer is worth seeing: the gateway can reset a stream that is still
  // using the previous ticket, which looks like a random "connection failed".
  if (v && ticketCache.value && v !== ticketCache.value) {
    console.log(`${new Date().toISOString()} WebVPN ticket rotated ${ticketCache.value.slice(0, 12)}… -> ${v.slice(0, 12)}…`)
  }
  ticketCache = { at: Date.now(), value: v }
  return v
}

async function discoverGateway () {
  for (const port of CDP_PORTS) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1200) })
      const pages = await r.json()
      for (const pg of pages) {
        try {
          const u = new URL(pg.url || '')
          if (!/(^|\.)tsinghua\.edu\.cn$/.test(u.hostname)) continue
          const m = u.pathname.match(/^(\/https\/[0-9a-f]+)/i)
          if (m) return `https://${u.hostname}${m[1]}`
        } catch (e) {}
      }
    } catch (e) {}
  }
  return ''
}

const HOP = new Set(['host', 'connection', 'cookie', 'content-length', 'accept-encoding', 'transfer-encoding', 'keep-alive', 'upgrade', 'proxy-authorization', 'te', 'trailer'])

function json (res, status, obj) {
  const body = JSON.stringify(obj)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) })
  res.end(body)
}

const server = http.createServer(async (req, res) => {
  const started = Date.now()
  const u = new URL(req.url, 'http://127.0.0.1')
  const ticket = ticketValue()

  if (u.pathname === '/healthz') {
    return json(res, 200, {
      ok: true,
      gateway: gateway || '(none)',
      ticket: ticket ? `present len=${ticket.length}` : 'missing',
      state: fs.existsSync(STATE) ? 'found' : 'missing',
      models: (conf.models && conf.models.length ? conf.models : DEFAULT_MODELS),
    })
  }
  if (!gateway) { gateway = await discoverGateway() }
  if (!gateway) {
    return json(res, 503, { error: { message: 'No WebVPN gateway prefix: start the plugin login window (Edge, CDP 9333) or set "gateway" in webvpn.json.' } })
  }

  // The site's own HTML can reference gateway-absolute paths; strip a duplicated prefix.
  let p = u.pathname
  const dup = p.match(/^\/https\/[0-9a-f]+(\/.*)?$/i)
  if (dup) p = dup[1] || '/'
  const target = gateway + p + (u.search || '')

  let body = null
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    const chunks = []
    for await (const c of req) chunks.push(c)
    body = Buffer.concat(chunks)
  }
  const headers = {}
  for (const [k, v] of Object.entries(req.headers)) if (!HOP.has(k.toLowerCase())) headers[k] = v
  if (ticket) headers.cookie = `wengine_vpn_ticket=${ticket}`

  let up
  try {
    up = await fetch(target, { method: req.method, headers, body: body && body.length ? body : undefined, redirect: 'manual' })
  } catch (e) {
    console.log(`${new Date().toISOString()} ${req.method} ${p} -> upstream error ${e && e.message} (${Date.now() - started}ms)`)
    return json(res, 502, { error: { message: 'WebVPN gateway unreachable: ' + String((e && e.message) || e) } })
  }

  const ct = up.headers.get('content-type') || ''
  const loc = up.headers.get('location') || ''

  if (up.status === 302 && /^\/login\b/.test(loc)) {
    return json(res, 401, { error: { message: 'WebVPN 会话已失效（网关要求重新登录）。请在 DSH 里点 Get 重新打开登录窗口。' } })
  }

  // The gateway answers GET /v1/models with its own portal page, so synthesise a list.
  if (p === '/v1/models' && req.method === 'GET' && /text\/html/i.test(ct)) {
    const models = (conf.models && conf.models.length ? conf.models : DEFAULT_MODELS)
    console.log(`${new Date().toISOString()} GET /v1/models -> 200 synthesised (${models.length} models, ${Date.now() - started}ms)`)
    return json(res, 200, { object: 'list', data: models.map(id => ({ id, object: 'model', owned_by: 'madmodel' })) })
  }

  const out = {}
  for (const [k, v] of up.headers.entries()) {
    const lk = k.toLowerCase()
    if (lk === 'content-length' || lk === 'content-encoding' || lk === 'transfer-encoding' || lk === 'connection') continue
    out[k] = v
  }

  if (!up.body) {
    res.writeHead(up.status, out)
    res.end()
    console.log(`${new Date().toISOString()} ${req.method} ${p} -> ${up.status} ${Date.now() - started}ms ticket=${ticket ? ticket.slice(0, 12) : 'no'} ct=${ct.split(';')[0]}`)
    return
  }

  // Stream upstream -> client. Two ordinary events must never take this process down,
  // because a dead adapter means "model request failed" for every later call:
  //   * the gateway resetting a long-lived streaming connection - undici surfaces it as
  //     `TypeError: terminated` / ECONNRESET, which used to be an unhandled 'error'
  //     event on this Readable and killed the whole process;
  //   * DSH hanging up mid-answer (cancelled turn, model switched).
  const src = Readable.fromWeb(up.body)
  let finished = false
  const log = (note, err) => {
    if (finished) return
    finished = true
    console.log(`${new Date().toISOString()} ${req.method} ${p} -> ${up.status} ${Date.now() - started}ms ticket=${ticket ? ticket.slice(0, 12) : 'no'} ct=${ct.split(';')[0]}${note ? ' ' + note : ''}${err ? ' ' + String((err && err.message) || err) : ''}`)
  }

  // Wire the client side first: it can hang up while we are still waiting for the
  // first byte, and then nothing else would cancel the upstream request.
  res.on('error', (e) => { log('client-error', e); try { src.destroy() } catch (_) {} })
  res.on('close', () => { if (!res.writableEnded) { log('client-aborted'); try { src.destroy() } catch (_) {} } })
  src.on('error', (e) => {
    log('upstream-reset', e)
    // Headers already sent -> the answer is simply truncated; end the client's socket.
    try { if (res.headersSent && !res.writableEnded) res.destroy() } catch (_) {}
  })

  // Read the first chunk before committing headers, so an upstream that dies before
  // producing anything becomes a clean 502 instead of an empty 200.
  let first = null
  let earlyError = null
  try {
    first = await new Promise((resolve, reject) => {
      src.once('readable', () => resolve(src.read()))
      src.once('end', () => resolve(null))
      src.once('close', () => resolve(null))
      src.once('error', reject)
    })
  } catch (e) { earlyError = e }

  if (res.destroyed || res.writableEnded) {
    log('client-gone')
    try { src.destroy() } catch (_) {}
    return
  }
  if (earlyError) {
    log('upstream-reset', earlyError)
    return json(res, 502, { error: { message: 'WebVPN upstream stream failed: ' + String((earlyError && earlyError.message) || earlyError) } })
  }

  src.on('end', () => log(''))
  res.writeHead(up.status, out)
  if (first && first.length) res.write(first)
  src.pipe(res)
})

// Last-resort guards: a proxy that exits because of one bad socket breaks every later
// request, so log and keep serving instead. Startup stays strict (a port clash must be
// visible), which is why these are attached only once the server is listening.
server.on('clientError', (e, socket) => {
  try { socket.destroy() } catch (_) {}
  console.log(`${new Date().toISOString()} client error: ${(e && e.message) || e}`)
})
process.on('uncaughtException', (e) => {
  console.log(`${new Date().toISOString()} uncaught exception (kept serving): ${(e && e.stack) || e}`)
})
process.on('unhandledRejection', (e) => {
  console.log(`${new Date().toISOString()} unhandled rejection (kept serving): ${(e && e.stack) || e}`)
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`${new Date().toISOString()} madmodel WebVPN proxy listening on http://127.0.0.1:${PORT}`)
  console.log(`  gateway: ${gateway || '(will auto-discover from the Edge tab)'}`)
  console.log(`  ticket : ${ticketValue() ? 'present' : 'MISSING - click Get in DSH once'}`)
})
