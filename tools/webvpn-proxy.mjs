// webvpn-proxy.mjs - local transport adapter for madmodel.cs.tsinghua.edu.cn.
//
// Why this exists: the site is reached differently on and off campus.
//   * on campus   the site answers directly - a 401 without a token is a good answer,
//                 it just means "give me a token";
//   * off campus  every direct request answers 307 to
//                 https://oauth.tsinghua.edu.cn/lb-auth/lbredirect (TsinghuaLB), so
//                 thu-tok-auto cannot validate a captured token (it reads the redirect as
//                 "server rejected the token") and DSH cannot call /v1 at all. The WebVPN
//                 gateway serves the same requests, but needs the `wengine_vpn_ticket`
//                 cookie, which DSH's LLM client has no way to send.
//
// So this process listens on 127.0.0.1:8788 and chooses the transport itself, which keeps
// DSH and the plugin pointed at one stable address wherever the machine is: it probes the
// site directly and falls back to the gateway when the site bounces to the campus login.
// A bounce seen on a real request switches immediately (no restart when the network
// changes), and the choice is re-probed every MADMODEL_PROBE_TTL_MS (default 60 s).
//
//   GET  /healthz              local status (chosen transport, gateway prefix, ticket)
//   GET  /v1/models            JSON list (this path answers with portal HTML on both
//                              transports, so the list is synthesised locally)
//   *    everything else       forwarded verbatim - SSE included - on the chosen transport
//
// Gateway prefix resolution: --gw <prefix> | webvpn.json "gateway" | live CDP tab (9333+).
// Ticket order: state.json cookieJar | WEBVPN_TICKET | webvpn.json "ticket".
// Config keys: gateway, direct, models, forceGateway. Env: MADMODEL_PROXY_PORT,
// MADMODEL_DIRECT_BASE, MADMODEL_FORCE_GATEWAY, MADMODEL_PROBE_TTL_MS.
//
// No dependencies; Node 22+ (global fetch/WebSocket). Run it with the DSH runtime's node:
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
const truthy = (v) => /^(1|true|yes|on)$/i.test(String(v || ''))

let gateway = (argValue('--gw') || conf.gateway || '').replace(/\/+$/, '')
const DIRECT = (process.env.MADMODEL_DIRECT_BASE || conf.direct || 'https://madmodel.cs.tsinghua.edu.cn').replace(/\/+$/, '')
const FORCE_GATEWAY = truthy(process.env.MADMODEL_FORCE_GATEWAY) || truthy(conf.forceGateway)
const PROBE_TTL = Number(process.env.MADMODEL_PROBE_TTL_MS || 60000)
// '' until the first probe; 'direct' | 'gateway' afterwards, valid for PROBE_TTL.
let transport = { mode: '', at: 0 }
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

function hostOf (url) {
  try { return new URL(url).hostname } catch (e) { return '' }
}
function pathOf (url) {
  try { return new URL(url).pathname } catch (e) { return '' }
}

// Does the site answer us itself, or bounce to the campus login? A 401 counts as usable:
// it means the site is right there and only wants a token. `redirect: 'follow'` is used
// because it makes the bounce visible as a final-URL change, and this probe is a
// bodyless GET, so following it costs nothing but one page load.
async function directUsable () {
  try {
    const r = await fetch(DIRECT + '/model-api/auth-login', {
      redirect: 'follow',
      signal: AbortSignal.timeout(8000),
      headers: { accept: 'application/json' },
    })
    // Two signals mean the site did not answer us itself: the URL moved to another host
    // (oauth.tsinghua.edu.cn) or it landed on a login path.
    if (hostOf(r.url) && hostOf(r.url) !== hostOf(DIRECT)) return false
    if (/^\/(login|lb-auth|auth)\b/i.test(pathOf(r.url))) return false
    return true
  } catch (e) {
    return false
  }
}

function setTransport (mode, why) {
  if (transport.mode && transport.mode !== mode) {
    console.log(`${new Date().toISOString()} transport ${transport.mode} -> ${mode}${why ? ' (' + why + ')' : ''}`)
  }
  transport = { mode, at: Date.now() }
  return mode
}

async function chooseTransport () {
  if (FORCE_GATEWAY) return setTransport('gateway', 'forced')
  if (transport.mode && Date.now() - transport.at < PROBE_TTL) return transport.mode
  const usable = await directUsable()
  return setTransport(usable ? 'direct' : 'gateway', usable ? 'site answered' : 'site bounced to the campus login')
}

// A manual-redirect fetch that bounced: 3xx (undici exposes it) or an opaque redirect.
const bounced = (r) => (r.status >= 300 && r.status < 400) || r.status === 0 || r.type === 'opaqueredirect'

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
      transport: transport.mode || '(probing)',
      direct: DIRECT,
      gateway: gateway || '(none)',
      ticket: ticket ? `present len=${ticket.length}` : 'missing',
      state: fs.existsSync(STATE) ? 'found' : 'missing',
      models: (conf.models && conf.models.length ? conf.models : DEFAULT_MODELS),
    })
  }

  // The site's own HTML can reference gateway-absolute paths; strip a duplicated prefix.
  let p = u.pathname
  const dup = p.match(/^\/https\/[0-9a-f]+(\/.*)?$/i)
  if (dup) p = dup[1] || '/'

  let body = null
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    const chunks = []
    for await (const c of req) chunks.push(c)
    body = Buffer.concat(chunks)
  }
  const headers = {}
  for (const [k, v] of Object.entries(req.headers)) if (!HOP.has(k.toLowerCase())) headers[k] = v

  // One forward attempt on one transport. `withTicket` is only for the gateway: the site
  // itself has no idea what a wengine_vpn_ticket is.
  const forward = async (base, withTicket) => {
    const h = { ...headers }
    if (withTicket && ticket) h.cookie = `wengine_vpn_ticket=${ticket}`
    return fetch(base + p + (u.search || ''), {
      method: req.method,
      headers: h,
      body: body && body.length ? body : undefined,
      redirect: 'manual',
    })
  }

  const mode = await chooseTransport()
  let used = mode
  let up = null
  let upErr = null

  if (mode === 'direct') {
    try {
      up = await forward(DIRECT, false)
      if (bounced(up)) {
        // The network moved out from under us: drop this response and go through the
        // gateway, which also caches the decision for the next PROBE_TTL.
        try { up.body && up.body.cancel() } catch (e) {}
        up = null
        setTransport('gateway', 'direct request bounced to the campus login')
      }
    } catch (e) {
      upErr = e
      setTransport('gateway', 'direct request failed')
    }
  }

  if (!up) {
    used = 'gateway'
    if (!gateway) gateway = await discoverGateway()
    if (!gateway) {
      const why = upErr ? 'direct request failed (' + String(upErr.message || upErr) + ') and ' : 'direct request bounced and '
      return json(res, 503, { error: { message: why + 'no WebVPN gateway prefix is known: open the plugin login window (Edge, CDP 9333) or set "gateway" in webvpn.json.' } })
    }
    try {
      up = await forward(gateway, true)
    } catch (e) {
      console.log(`${new Date().toISOString()} ${req.method} ${p} -> upstream error ${e && e.message} (${Date.now() - started}ms via=${used})`)
      return json(res, 502, { error: { message: 'WebVPN gateway unreachable: ' + String((e && e.message) || e) } })
    }
  } else {
    used = 'direct'
  }

  const ct = up.headers.get('content-type') || ''
  const loc = up.headers.get('location') || ''

  // A login bounce that survived (server-side redirect to /login on the gateway, or a
  // direct 302 to the SSO page): report it as "log in again" rather than as a failure.
  if (/^\/login\b/.test(loc) || /oauth\.tsinghua\.edu\.cn|\/lb-auth\//i.test(loc)) {
    const via = used === 'gateway' ? 'WebVPN 会话已失效（网关要求重新登录）' : '站点要求重新登录'
    return json(res, 401, { error: { message: `${via}。请在 DSH 里点 Get 重新打开登录窗口。` } })
  }

  // /v1/models is answered with the portal's own HTML on both transports, so synthesise
  // the list locally unless the transport returned a real JSON model list.
  if (p === '/v1/models' && req.method === 'GET' && !(up.status >= 200 && up.status < 300 && /application\/json/i.test(ct))) {
    const models = (conf.models && conf.models.length ? conf.models : DEFAULT_MODELS)
    console.log(`${new Date().toISOString()} GET /v1/models -> 200 synthesised via=${used} (${models.length} models, ${Date.now() - started}ms)`)
    return json(res, 200, { object: 'list', data: models.map(id => ({ id, object: 'model', owned_by: 'madmodel' })) })
  }

  const out = {}
  for (const [k, v] of up.headers.entries()) {
    const lk = k.toLowerCase()
    if (lk === 'content-length' || lk === 'content-encoding' || lk === 'transfer-encoding' || lk === 'connection') continue
    out[k] = v
  }
  const tail = `via=${used}${used === 'gateway' ? ' ticket=' + (ticket ? ticket.slice(0, 12) : 'no') : ''} ct=${ct.split(';')[0]}`

  if (!up.body) {
    res.writeHead(up.status, out)
    res.end()
    console.log(`${new Date().toISOString()} ${req.method} ${p} -> ${up.status} ${Date.now() - started}ms ${tail}`)
    return
  }

  // Stream upstream -> client. Two ordinary events must never take this process down,
  // because a dead adapter means "model request failed" for every later call:
  //   * the far side resetting a long-lived streaming connection - undici surfaces it as
  //     `TypeError: terminated` / ECONNRESET, which used to be an unhandled 'error'
  //     event on this Readable and killed the whole process;
  //   * DSH hanging up mid-answer (cancelled turn, model switched).
  const src = Readable.fromWeb(up.body)
  let finished = false
  const log = (note, err) => {
    if (finished) return
    finished = true
    console.log(`${new Date().toISOString()} ${req.method} ${p} -> ${up.status} ${Date.now() - started}ms ${tail}${note ? ' ' + note : ''}${err ? ' ' + String((err && err.message) || err) : ''}`)
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
    return json(res, 502, { error: { message: 'upstream stream failed: ' + String((earlyError && earlyError.message) || earlyError) } })
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

server.listen(PORT, '127.0.0.1', async () => {
  console.log(`${new Date().toISOString()} madmodel transport proxy listening on http://127.0.0.1:${PORT}`)
  console.log(`  direct : ${DIRECT}${FORCE_GATEWAY ? ' (disabled - forced gateway)' : ''}`)
  console.log(`  gateway: ${gateway || '(will auto-discover from the Edge tab when needed)'}`)
  console.log(`  ticket : ${ticketValue() ? 'present' : 'MISSING - only needed off campus'}`)
  const mode = await chooseTransport()
  console.log(`  transport: ${mode} (${mode === 'direct' ? 'campus / site reachable' : 'off campus / WebVPN needed'})`)
})
