'use strict';
// THU Tok Auto — DSH profile bundle (Cordis plugin) entry.
//
// Runs directly in the DSH host process: no node:vm sandbox, no subprocess helpers.
// Node's built-in fetch / WebSocket / fs / child_process provide the environment;
// DSH services provide settings, credentials, timers, the web server and request auth.
//
// Client UI is a plain global script (lib/ui.js) contributed through DSH's
// structured index-injection table, talking to the JSON API below. Because the tag is
// regenerated on every full page load, the buttons survive F5 (unlike the dynamic
// session-plugin form) while Host-side Auto keeps running regardless.
import fs from 'node:fs'
import { dirname } from 'node:path'
import { spawn } from 'node:child_process'
import { createCore } from './core.js'

const name = 'thu-tok-auto'
const inject = ['settings', 'credentials', 'timer', 'webServer', 'connection']

const jsonParse = function (txt) { try { return JSON.parse(txt); } catch (e) { return null; } }

function httpError(status, message) {
  const error = new Error(message)
  error.status = status
  return error
}

async function readResponseText(response, maxBytes = 1024 * 1024) {
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > maxBytes) throw new Error('response too large')
  if (!response.body) return ''
  const reader = response.body.getReader()
  const chunks = []
  let bytes = 0
  try {
    while (true) {
      const part = await reader.read()
      if (part.done) break
      bytes += part.value.byteLength
      if (bytes > maxBytes) throw new Error('response too large')
      chunks.push(Buffer.from(part.value))
    }
    return Buffer.concat(chunks).toString('utf8')
  } finally {
    try { await reader.cancel() } catch (e) {}
  }
}

function readBody(req, maxBytes = 64 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let bytes = 0
    let settled = false
    const done = (error, value) => {
      if (settled) return
      settled = true
      req.removeListener('data', onData)
      req.removeListener('end', onEnd)
      req.removeListener('error', onError)
      if (error) reject(error)
      else resolve(value)
    }
    const onData = (chunk) => {
      bytes += Buffer.byteLength(chunk)
      if (bytes > maxBytes) {
        req.resume()
        return done(httpError(413, '请求体过大。'))
      }
      chunks.push(Buffer.from(chunk))
    }
    const onEnd = () => {
      const text = Buffer.concat(chunks).toString('utf8')
      try { done(null, text ? JSON.parse(text) : {}) } catch (e) { done(httpError(400, 'JSON 格式无效。')) }
    }
    const onError = (e) => done(e)
    req.on('data', onData)
    req.on('end', onEnd)
    req.on('error', onError)
  })
}

function json(res, value, code = 200, extraHeaders = {}) {
  if (res.destroyed || res.writableEnded) return
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    ...extraHeaders,
  })
  res.end(JSON.stringify(value))
}

function apply(ctx) {
  const disposers = []
  const dispose = () => {
    for (const fn of disposers.splice(0).reverse()) { try { fn() } catch (e) { /* best-effort cleanup */ } }
  }
  try {
    const timer = ctx.get('timer')
    const settingsSvc = ctx.get('settings')
    const credSvc = ctx.get('credentials')
    const webServer = ctx.get('webServer')
    const connection = ctx.get('connection')
    if (!webServer || typeof webServer.register !== 'function') throw new Error('webServer service unavailable')
    if (!timer || typeof timer.interval !== 'function') throw new Error('timer service unavailable')
    if (!connection || typeof connection.requestRejection !== 'function') throw new Error('需要支持 connection.requestRejection 的 DSH 宿主。')

    const core = createCore({
      logger: console,
      clock: { now: () => Date.now() },
      // THU_TOK_AUTO_HOME lets tests (or users) relocate the state directory.
      env: {
        home: process.env.THU_TOK_AUTO_HOME || process.env.USERPROFILE || process.env.HOME || '',
        temp: process.env.TEMP || process.env.TMP || '',
        localAppData: process.env.LOCALAPPDATA || '',
        cwd: process.cwd(),
      },
      settings: settingsSvc,
      credentials: credSvc,
      timer,
      // Node 内置 fetch：与动态版子进程 helper 相同的语义（redirect manual 保留 Location）。
      http: async (url, options) => {
        const init = { redirect: options.follow === false ? 'manual' : 'follow', signal: AbortSignal.timeout(options.timeoutMs || 25000) }
        if (options.headers) init.headers = options.headers
        try {
          const r = await fetch(url, init)
          const text = await readResponseText(r)
          return { status: r.status, ok: r.ok, location: r.headers.get('location') || '', text }
        } catch (e) { return { error: String((e && e.message) || e) } }
      },
      // CDP 捕获：仅连本机 127.0.0.1 / localhost / [::1] 且端口匹配的调试端面，
      // 页面按 Tsinghua 域名打分选择，绝不回退到任意页面。
      cdp: async (arg) => {
        const port = arg.port || 9333
        const deadline = Date.now() + (arg.timeoutMs || 20000)
        let pages = null
        let running = false
        while (Date.now() < deadline) {
          try {
            const r = await fetch('http://127.0.0.1:' + port + '/json/list', { signal: AbortSignal.timeout(1500) })
            if (r.ok) {
              running = true
              pages = jsonParse(await readResponseText(r))
              break
            }
          } catch (e) {}
          await new Promise((r) => setTimeout(r, 300))
        }
        if (!running) return { ok: false, running: false, reason: 'no-devtools' }
        if (!Array.isArray(pages) || !pages.length) return { ok: false, running: true, reason: 'no-target' }
        let target = null
        const hostname = (u) => { try { return new URL(u).hostname.toLowerCase() } catch (e) { return '' } }
        const score = (u) => {
          const h = hostname(u)
          if (h === 'madmodel.cs.tsinghua.edu.cn') return 3
          if (h === 'id.tsinghua.edu.cn' || h === 'oauth.tsinghua.edu.cn') return 2
          if (h === 'tsinghua.edu.cn' || h.endsWith('.tsinghua.edu.cn')) return 1
          return 0
        }
        let best = 0
        for (const p of pages) {
          if (p && typeof p === 'object' && p.type === 'page') {
            const s = score(p.url || '')
            if (s > best) { best = s; target = p }
          }
        }
        if (!target || !target.webSocketDebuggerUrl) return { ok: false, running: true, reason: 'no-target' }
        if (arg.probeOnly) return { ok: true, running: true, url: target.url || '' }
        let debuggerUrl = null
        try { debuggerUrl = new URL(target.webSocketDebuggerUrl) } catch (e) {}
        const debuggerHost = debuggerUrl ? debuggerUrl.hostname.toLowerCase() : ''
        if (!debuggerUrl || debuggerUrl.protocol !== 'ws:' ||
            (debuggerHost !== '127.0.0.1' && debuggerHost !== 'localhost' && debuggerHost !== '[::1]') ||
            Number(debuggerUrl.port) !== port) return { ok: false, running: true, reason: 'unsafe-debugger-url' }
        const ws = new WebSocket(debuggerUrl.href)
        let nextId = 1
        const pending = {}
        let openTimer = null
        const rejectPending = (error) => {
          for (const id of Object.keys(pending)) {
            clearTimeout(pending[id].timer)
            pending[id].reject(error)
            delete pending[id]
          }
        }
        const send = (method, params) => new Promise((resolve, reject) => {
          const id = nextId++
          const timer = setTimeout(() => {
            if (pending[id]) { delete pending[id]; reject(new Error('cdp timeout ' + method)) }
          }, 8000)
          pending[id] = { resolve, reject, timer }
          try { ws.send(JSON.stringify({ id, method, params: params || {} })) } catch (e) {
            clearTimeout(timer)
            delete pending[id]
            reject(e)
          }
        })
        ws.onmessage = (ev) => {
          try {
            if (typeof ev.data !== 'string' || Buffer.byteLength(ev.data) > 1024 * 1024) return
            const m = jsonParse(ev.data)
            if (m && m.id && pending[m.id]) {
              clearTimeout(pending[m.id].timer)
              pending[m.id].resolve(m)
              delete pending[m.id]
            }
          } catch (e) {}
        }
        try {
          await new Promise((resolve, reject) => {
            ws.onopen = () => {
              clearTimeout(openTimer)
              resolve()
            }
            ws.onerror = () => reject(new Error('ws error'))
            openTimer = setTimeout(() => reject(new Error('ws open timeout')), 6000)
          })
          ws.onerror = () => rejectPending(new Error('ws error'))
          ws.onclose = () => rejectPending(new Error('ws closed'))
          try { await send('Network.enable', {}) } catch (e) {}
          let ck = null
          try { ck = await send('Network.getAllCookies', {}) } catch (e) {}
          let ev = null
          try {
            ev = await send('Runtime.evaluate', {
              // WebVPN namespaces the proxied site's storage (the app's "user" key
              // shows up as "__1_user"), so any *_user key holding a JWT counts.
              expression: "(function(){try{var t='';var u=window.localStorage.getItem('user');if(u){try{t=(JSON.parse(u).token)||''}catch(e){}}if(!t){for(var i=0;i<window.localStorage.length;i++){var k=window.localStorage.key(i);if(!/_?user$/i.test(k))continue;try{var j=JSON.parse(window.localStorage.getItem(k));if(j&&typeof j.token==='string'&&j.token){t=j.token;break}}catch(e){}}}return JSON.stringify({token:t,url:location.href})}catch(e){return JSON.stringify({error:String(e)})}})()",
              returnByValue: true,
            })
          } catch (e) {}
          const cookies = (ck && ck.result && Array.isArray(ck.result.cookies)) ? ck.result.cookies : []
          const picked = []
          for (const c of cookies) {
            const d = String(c.domain || '').toLowerCase().replace(/^\.+/, '')
            if (!(d === 'tsinghua.edu.cn' || d.endsWith('.tsinghua.edu.cn'))) continue
            // Keep every attribute a Cookie header needs. The SSO chain spans
            // several hosts (id./oauth./auth*.tsinghua.edu.cn), so picking cookies
            // by host at capture time silently drops ones a replay depends on.
            picked.push({
              name: c.name,
              value: c.value,
              domain: d,
              path: c.path || '/',
              secure: !!c.secure,
              httpOnly: !!c.httpOnly,
              expires: typeof c.expires === 'number' ? c.expires : -1,
              session: !!c.session,
            })
          }
          let token = ''
          let url = ''
          try {
            const rv = ev && ev.result && ev.result.result && ev.result.result.value
            if (rv) {
              const j = jsonParse(rv)
              url = typeof j.url === 'string' ? j.url : ''
              const h = hostname(url)
              // A WebVPN-wrapped page (off campus) is as good a source as the real
              // origin: /https/<hex>/... is how the gateway rewrites madmodel.
              let wrapped = false
              try { wrapped = h === 'webvpn.tsinghua.edu.cn' && /^\/https\/[0-9a-f]+/i.test(new URL(url).pathname) } catch (e) {}
              if ((h === 'madmodel.cs.tsinghua.edu.cn' || wrapped) && typeof j.token === 'string') token = j.token
            }
          } catch (e) {}
          return { ok: true, token, url, cookies: picked }
        } finally {
          clearTimeout(openTimer)
          rejectPending(new Error('cdp connection closed'))
          try { ws.close() } catch (e) {}
        }
      },
      // 状态文件：%USERPROFILE%\.dsh\madmodel\state.json，原子写（tmp + rename + chmod 0600），
      // 与 0.2.x 动态版同一路径，正式版无缝接管已有数据。
      stateIO: {
        async mkdir(path) { try { fs.mkdirSync(path, { recursive: true }); return { ok: true } } catch (e) { return { ok: false, error: String((e && e.message) || e) } } },
        async load(path) {
          try {
            if (fs.existsSync(path)) return { ok: true, data: jsonParse(fs.readFileSync(path, 'utf8')) }
            return { ok: true, data: null }
          } catch (e) { return { ok: false, error: String((e && e.message) || e) } }
        },
        async save(path, data) {
          let tmp = ''
          try {
            fs.mkdirSync(dirname(path), { recursive: true })
            tmp = path + '.tmp-' + process.pid + '-' + Date.now() + '-' + Math.random().toString(16).slice(2)
            fs.writeFileSync(tmp, JSON.stringify(data), { encoding: 'utf8', mode: 0o600 })
            fs.renameSync(tmp, path)
            try { fs.chmodSync(path, 0o600) } catch (e) {}
            return { ok: true }
          } catch (e) {
            if (tmp) { try { fs.unlinkSync(tmp) } catch (ignore) {} }
            return { ok: false, error: String((e && e.message) || e) }
          }
        },
      },
      findExecutable: async (candidate) => {
        try { return fs.existsSync(candidate) ? candidate : null } catch (e) { return null }
      },
      spawnBrowser: (exe, argv) => new Promise((resolve, reject) => {
        const child = spawn(exe, argv, {
          cwd: process.env.SystemRoot || 'C:\\Windows',
          detached: true,
          stdio: 'ignore',
        })
        child.once('error', reject)
        child.once('spawn', () => {
          child.unref()
          resolve({ pid: child.pid })
        })
      }),
    })
    disposers.push(() => core.dispose())

    // Off campus madmodel answers 307 to oauth, so this plugin and DSH both talk to
    // the local WebVPN adapter. Start it when nothing is listening: detached, so it
    // also outlives this host; a later host start finds the port busy and skips.
    void ensureWebvpnProxy()
    // The adapter is its own process, so re-check it every 30 s: a crash (a gateway
    // reset mid-stream used to kill it) or a kill then heals in half a minute instead
    // of leaving every model call failing until the next host start.
    const proxyWatch = setInterval(() => { void ensureWebvpnProxy() }, 30000)
    if (proxyWatch && typeof proxyWatch.unref === 'function') proxyWatch.unref()
    disposers.push(() => clearInterval(proxyWatch))

    const rejectReq = (req) => {
      try { return connection.requestRejection(req) } catch (e) {
        console.error('[thu-tok-auto] request trust check', e)
        return 403
      }
    }
    function route(method, endpoint, handler) {
      disposers.push(webServer.register({
        kind: 'exact',
        path: '/thu-tok-auto/api/' + endpoint,
        handler: async (req, res) => {
          try {
            const rejection = rejectReq(req)
            if (rejection !== undefined) {
              const code = rejection === 401 ? 401 : 403
              return json(res, { ok: false, error: code === 401 ? '请先登录 DSH。' : '请求来源不受信任。' }, code)
            }
            if (req.method !== method) return json(res, { ok: false, error: '请求方法不支持。' }, 405, { Allow: method })
            if (method === 'POST') {
              if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) return json(res, { ok: false, error: '仅接受 application/json。' }, 415)
              const body = await readBody(req)
              return json(res, await handler(body))
            }
            return json(res, await handler(undefined))
          } catch (e) {
            const status = Number.isInteger(e && e.status) && e.status >= 400 && e.status <= 599 ? e.status : 500
            json(res, { ok: false, error: status === 500 ? '插件内部错误。' : String((e && e.message) || e) }, status)
            if (status === 500) console.error('[thu-tok-auto] API ' + endpoint, e)
          }
        },
      }))
    }
    route('GET', 'status', () => core.state())
    route('POST', 'get-tok', () => core.getTok())
    route('POST', 'open-login', () => core.openLogin())
    route('POST', 'set-auto', (body) => {
      if (!body || typeof body !== 'object' || Array.isArray(body) || typeof body.on !== 'boolean') {
        throw httpError(400, '字段 on 必须是布尔值。')
      }
      return core.setAuto(body.on)
    })

    const uiUrl = new URL('./ui.js', import.meta.url)
    if (fs.existsSync(uiUrl)) {
      disposers.push(webServer.register({
        kind: 'exact',
        path: '/thu-tok-auto/ui.js',
        handler: (req, res) => {
          const rejection = rejectReq(req)
          if (rejection !== undefined) {
            const code = rejection === 401 ? 401 : 403
            return json(res, { ok: false, error: code === 401 ? '请先登录 DSH。' : '请求来源不受信任。' }, code)
          }
          if (req.method !== 'GET') return json(res, { ok: false, error: '请求方法不支持。' }, 405, { Allow: 'GET' })
          res.writeHead(200, {
            'Content-Type': 'application/javascript; charset=utf-8',
            'Cache-Control': 'no-store',
            'X-Content-Type-Options': 'nosniff',
            'Cross-Origin-Resource-Policy': 'same-origin',
            'Referrer-Policy': 'no-referrer',
          })
          res.end(fs.readFileSync(uiUrl, 'utf8'))
        },
      }))
      disposers.push(ctx.on('webserver/index-inject', (table) => {
        table.push({ kind: 'script-src', placement: 'body', src: '/thu-tok-auto/ui.js' })
      }))
    }

    // Auto-refresh lives in the Host: it keeps running no matter what the page does.
    core.init().catch((e) => console.error('[thu-tok-auto] initial load', e))
    disposers.push(timer.interval(() => {
      return core.autoTick().catch((e) => console.error('[thu-tok-auto] auto tick', e))
    }, 30000))

    ctx.effect(() => dispose)
    return
  } catch (e) {
    console.error('[thu-tok-auto] 插件未启用：', (e && e.message) || e)
    dispose()
    return
  }
}

export { name, inject, apply }

// Start the local WebVPN adapter (see ensureWebvpnProxy's call site) if it is not
// already listening on 127.0.0.1:8788. Deliberately silent on every failure: the
// adapter is an off-campus convenience, never a reason to break the plugin.
async function ensureWebvpnProxy() {
  try {
    const dshHome = process.env.DSH_HOME || ((process.env.USERPROFILE || process.env.HOME || '') + '\\.dsh')
    if (!dshHome) return
    // Deployed copy (DSH_HOME\madmodel) first, then the copy shipped inside this
    // package, so an installation from this fork works without a separate deploy.
    const pkgRoot = import.meta.dirname ? import.meta.dirname.replace(/[\\/]lib$/, '') : ''
    const candidates = [
      dshHome + '\\madmodel\\webvpn-proxy.mjs',
      pkgRoot ? pkgRoot + '\\tools\\webvpn-proxy.mjs' : '',
    ]
    let script = ''
    for (const c of candidates) { if (c && fs.existsSync(c)) { script = c; break } }
    if (!script) return
    try {
      const r = await fetch('http://127.0.0.1:8788/healthz', { signal: AbortSignal.timeout(1500) })
      if (r && r.ok) return
    } catch (e) {}
    const spawnDetached = (exe, argv, opts) => new Promise((resolve, reject) => {
      const child = spawn(exe, argv, opts)
      child.once('error', reject)
      child.once('spawn', () => { child.unref(); resolve(child.pid) })
    })
    // Keep the adapter's log useful without breaking the spawn if the file is locked.
    let out = 'ignore'
    try { out = fs.openSync(dshHome + '\\madmodel\\proxy.log', 'a') } catch (e) { out = 'ignore' }
    const base = { detached: true, stdio: out === 'ignore' ? 'ignore' : ['ignore', out, out], windowsHide: true }
    const closeOut = () => { if (out !== 'ignore') { try { fs.closeSync(out) } catch (e) {} } }
    try {
      const pid = await spawnDetached(process.execPath, [script], { ...base, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } })
      closeOut()
      console.error('[thu-tok-auto] started the local WebVPN adapter (pid ' + pid + ')')
    } catch (e) {
      const local = process.env.LOCALAPPDATA || ''
      const alt = local + '\\Programs\\DeepSeek Harness\\resources\\runtime\\node\\node.exe'
      if (!local || !fs.existsSync(alt)) { closeOut(); return }
      const pid = await spawnDetached(alt, [script], base)
      closeOut()
      console.error('[thu-tok-auto] started the local WebVPN adapter via ' + alt + ' (pid ' + pid + ')')
    }
  } catch (e) {
    console.error('[thu-tok-auto] WebVPN adapter start failed', e)
  }
}
