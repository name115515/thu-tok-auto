// THU Tok Auto — browser UI (plain global script, no framework).
// Injected into every full page load through DSH's structured index table.
//
// Placement (per spec): inside the DSH sidebar foot, right ABOVE the settings
// row. If other plugins (e.g. Remote's sidebar.footer.action entry) already sit
// above settings, the widget is inserted at the very top of the foot area —
// i.e. above the topmost button. If the foot area cannot be located, the widget
// is inserted directly above the settings row; if the settings trigger is not
// found at all, the widget stays hidden and mounting is retried every 2s.
(function () {
  'use strict';
  if (typeof window.__mmtokUiCleanup === 'function') window.__mmtokUiCleanup()
  else if (window.__mmtokUiLoaded) return
  window.__mmtokUiLoaded = true

  var API = '/thu-tok-auto/api'
  // Host-side reasons for a login window that did not open, in user terms.
  var LOGIN_REASON_TEXT = {
    'renewal-unavailable': '自动续期通道不可用（免登录签发已关闭、SSO 会话已过期）',
    'already-open': '登录窗口已打开，请在其中完成登录',
    reuse: '已复用现有的调试浏览器，请在它的窗口里登录',
    'no-debug-port': '调试端口 9333-9343 全被占用，关掉其中一个浏览器后重试',
    'no-browser': '未找到 Edge 或 Chrome，无法打开登录窗口',
    error: '打开登录窗口失败',
    disposed: '插件已停用',
  }
  var store = {
    auto: false, busy: false, lastGetAt: 0, loggedIn: false, status: 'idle', err: '',
    expiresAt: 0, browserOpen: false, provider: '', providerName: '', credentialWritten: false,
    loginReason: '', refreshBlocked: false, notice: '',
  }
  var box = null
  var dotEl = null
  var getBtn = null
  var autoBtn = null
  var elapsedEl = null
  var warnEl = null
  var intervalIds = []

  function cleanup() {
    for (var i = 0; i < intervalIds.length; i++) clearInterval(intervalIds[i])
    intervalIds = []
    document.removeEventListener('DOMContentLoaded', boot)
    if (box && box.parentNode) box.parentNode.removeChild(box)
    var style = document.getElementById('mmtok-style')
    if (style && style.parentNode) style.parentNode.removeChild(style)
    box = null
    window.__mmtokUiLoaded = false
    if (window.__mmtokUiCleanup === cleanup) window.__mmtokUiCleanup = null
  }
  window.__mmtokUiCleanup = cleanup

  var pad = function (n) { return (n < 10 ? '0' : '') + n }
  var fmt = function (ms) {
    if (!ms || ms < 0) return '--:--'
    var sec = Math.floor(ms / 1000)
    var hh = Math.floor(sec / 3600)
    if (hh >= 100) return 'Too Long!'
    return pad(hh) + ':' + pad(Math.floor((sec % 3600) / 60))
  }
  var remainText = function (at) {
    if (!at) return ''
    var ms = at - Date.now()
    if (ms <= 0) return ''
    var min = Math.floor(ms / 60000)
    return Math.floor(min / 60) + 'h' + pad(min % 60) + 'm'
  }
  // One-line current-state summary (used by the dot and the Get button).
  var statusLine = function () {
    var s = store
    if (s.busy) return '正在获取 Token…'
    if (s.notice) return s.notice
    if (s.status === 'needs-login') {
      return '需要登录：' + (LOGIN_REASON_TEXT[s.loginReason] || '点击 Get 打开登录窗口')
    }
    if (s.status === 'error') return '出错了：' + (s.err || '未知错误')
    if (s.status === 'no-progress') {
      return '刷新未生效：' + (s.err || '拿到的是同一张令牌，到期时间未前进')
    }
    if (s.status === 'expired') return 'Token 已过期，点击 Get 重新获取'
    if (s.status === 'refreshing') return '正在自动刷新 Token…'
    if (s.status === 'ok') return s.credentialWritten
      ? '已更新 ' + (s.providerName || 'DeepSeek (THU)') + ' 模型配置'
      : '已获取 Token'
    return '尚未获取 Token，点击 Get 获取'
  }
  // Multi-line hover text for the whole widget.
  var titleText = function () {
    var s = store
    var lines = ['THU Tok Auto']
    lines.push(statusLine())
    var info = []
    if (s.lastGetAt) info.push('上次获取 ' + fmt(Date.now() - s.lastGetAt) + ' 前')
    if (s.expiresAt) {
      var rem = remainText(s.expiresAt)
      info.push(rem ? ('Token 剩余 ' + rem) : 'Token 已过期')
    }
    if (info.length) lines.push(info.join(' · '))
    if (s.refreshBlocked) lines.push('自动续期不可用：' + (LOGIN_REASON_TEXT[s.loginReason] || '请重新登录'))
    lines.push(s.auto
      ? 'Auto 已开启：计时超过 01:00 自动获取，点击 Auto 关闭'
      : 'Auto 已关闭：点击开启，计时超过 01:00 自动获取')
    return lines.join('\n')
  }

  function jsonRequest(method, endpoint, body) {
    var init = {
      method: method,
      credentials: 'same-origin',
    }
    if (method === 'POST' || body !== undefined) {
      init.headers = { 'Content-Type': 'application/json' }
      init.body = JSON.stringify(body === undefined ? {} : body)
    }
    return fetch(API + '/' + endpoint, init).then(function (r) {
      return r.json().catch(function () { return null }).then(function (data) {
        if (!r.ok) {
          var error = new Error((data && data.error) || ('请求失败（HTTP ' + r.status + '）'))
          error.status = r.status
          throw error
        }
        if (!data) throw new Error('服务器返回了无效数据')
        return data
      })
    })
  }

  function showRequestError(error) {
    if (error && error.status === 404) { cleanup(); return }
    store.busy = false
    store.status = 'error'
    store.err = 'DSH 通信失败：' + String((error && error.message) || error || '未知错误')
    render()
  }

  var refresh = function () {
    return jsonRequest('GET', 'status').then(function (s) {
      if (!s) return
      store.auto = !!s.auto; store.busy = !!s.busy; store.lastGetAt = s.lastGetAt || 0
      store.loggedIn = !!s.loggedIn; store.status = s.status || 'idle'; store.err = s.err || ''
      store.expiresAt = s.expiresAt || 0
      store.browserOpen = !!s.browserOpen; store.provider = s.provider || ''
      store.providerName = s.providerName || ''
      store.credentialWritten = !!s.credentialWritten
      store.loginReason = s.loginReason || ''; store.refreshBlocked = !!s.refreshBlocked
      render()
    }).catch(showRequestError)
  }

  var runGet = function () {
    if (store.busy) return
    store.busy = true
    store.notice = ''
    render()
    jsonRequest('POST', 'get-tok').then(function (r) {
      if (r && r.loginRequired) {
        // The open-login answer carries the reason a window did not appear; it
        // used to be dropped, so every failure looked like nothing happened.
        return jsonRequest('POST', 'open-login').then(function (o) {
          if (o && o.launched) store.notice = '已打开登录窗口，请完成登录'
          else if (o && o.reason) store.notice = LOGIN_REASON_TEXT[o.reason] || ('未打开登录窗口：' + o.reason)
          return o
        })
      }
      if (r && r.err) store.notice = r.err
      else if (r && r.via === 'mint') store.notice = '已签发新令牌'
      else if (r && r.via === 'browser') store.notice = '已从登录浏览器取回会话并续期'
      else if (r && r.via === 'sso') store.notice = '已通过 SSO 续期'
      else if (r && r.via === 'reuse') store.notice = '已复用旧令牌（未刷新）'
      return r
    }).then(function () { return refresh() }).catch(showRequestError)
  }

  var setAuto = function (on) {
    return jsonRequest('POST', 'set-auto', { on: on }).then(function (r) {
      if (r) store.auto = !!r.auto
    }).then(function () { return refresh() }).catch(showRequestError)
  }

  // ---- sidebar foot placement ---------------------------------------------
  // [adapted] DSH 0.2.0-rc.2 sidebar mount.
  // The sidebar foot's settings seat is filled by the account plugin's launcher
  // (<button aria-label="account menu">), so the old button[aria-label="settings"]
  // lookup never matched. Resolve the foot's *column* container instead: inserting
  // into a row container is what put the widget on the account row and wrapped it.
  var mountAttempts = 0
  function triggerLabel(el) {
    return String((el.getAttribute('aria-label') || el.title || el.textContent || '')).trim()
  }
  function isColumnFlex(el) {
    try {
      var cs = window.getComputedStyle(el)
      return !!cs && cs.display.indexOf('flex') >= 0 && cs.flexDirection === 'column'
    } catch (e) { return false }
  }
  function isFootSized(el) {
    try {
      var r = el.getBoundingClientRect()
      return r.height > 0 && r.height < window.innerHeight * 0.5
    } catch (e) { return false }
  }
  function findFootAnchor() {
    var want = ['\u8bbe\u7f6e', '\u8d26\u53f7\u83dc\u5355', 'settings', 'account menu']
    var seeds = []
    var btns = document.querySelectorAll('button')
    for (var i = 0; i < btns.length; i++) {
      var t = triggerLabel(btns[i])
      if (want.indexOf(t) >= 0 || want.indexOf(t.toLowerCase()) >= 0) { seeds.push({ el: btns[i], by: 'trigger' }); break }
    }
    var divs = document.querySelectorAll('div[class]')
    for (var j = 0; j < divs.length; j++) {
      var cls = String(divs[j].className || '')
      if (cls.indexOf('settingsArea') >= 0 || cls.indexOf('footerActions') >= 0) seeds.push({ el: divs[j], by: 'area' })
    }
    for (var s = 0; s < seeds.length; s++) {
      var node = seeds[s].el
      var best = null
      for (var k = 0; k < 12 && node && node !== document.body; k++) {
        // Reachable by name -> that is the foot container, no guessing needed.
        if (String(node.className || '').indexOf('footArea') >= 0) return { foot: node, via: seeds[s].by + ':footArea' }
        // Otherwise the first short column container, never the whole sidebar.
        if (!best && isColumnFlex(node) && isFootSized(node)) best = node
        node = node.parentElement
      }
      if (best) return { foot: best, via: seeds[s].by + ':column' }
    }
    return null
  }
  function tryMount() {
    if (box && box.isConnected) return true
    ensureDom()
    mountAttempts++
    var anchor = findFootAnchor()
    if (anchor && anchor.foot) {
      // First child of the column container = one full-width row of our own,
      // directly above every footer button (Remote, then account/settings).
      anchor.foot.insertBefore(box, anchor.foot.firstChild)
      if (box.isConnected) { box.dataset.mmtokVia = anchor.via; return true }
    }
    // Give the shell a few seconds to render the sidebar before going floating.
    if (mountAttempts >= 8) {
      box.classList.add('mmtok-floating')
      if (document.body && box.parentNode !== document.body) document.body.appendChild(box)
      if (box.isConnected) { box.dataset.mmtokVia = 'floating'; return true }
    }
    return false
  }
  function ensureDom() {
    if (box && document.body && box.isConnected) return
    if (box && box.parentNode) box.parentNode.removeChild(box)
    box = document.createElement('div')
    box.className = 'mmtok-box'
    var btns = document.createElement('div')
    btns.className = 'mmtok-btns'
    dotEl = document.createElement('span')
    dotEl.className = 'mmtok-dot mmtok-off'
    getBtn = document.createElement('button')
    getBtn.className = 'mmtok-btn'
    getBtn.textContent = 'Get'
    getBtn.addEventListener('click', runGet)
    autoBtn = document.createElement('button')
    autoBtn.className = 'mmtok-btn'
    autoBtn.textContent = 'Auto'
    autoBtn.addEventListener('click', function () { setAuto(!store.auto) })
    warnEl = document.createElement('span')
    warnEl.className = 'mmtok-timer-status'
    elapsedEl = document.createElement('span')
    elapsedEl.className = 'mmtok-elapsed'
    elapsedEl.textContent = '--:--'
    btns.appendChild(dotEl)
    btns.appendChild(getBtn)
    btns.appendChild(autoBtn)
    btns.appendChild(warnEl)
    btns.appendChild(elapsedEl)
    box.appendChild(btns)
  }

  function render() {
    if (!box || !box.isConnected) return
    var s = store
    box.title = titleText()
    // ok = green, no-progress (fetched the same token again) = amber, everything
    // else off. A refresh that did not extend the expiry must not look healthy.
    dotEl.className = 'mmtok-dot mmtok-' + (s.busy ? 'busy' : s.status === 'ok' ? 'ok' : s.status === 'no-progress' ? 'stale' : 'off')
    dotEl.title = statusLine()
    getBtn.className = 'mmtok-btn' + (s.busy ? ' mmtok-disabled' : '')
    getBtn.disabled = !!s.busy
    getBtn.textContent = 'Get'
    getBtn.title = statusLine() + '\n点击获取最新 Token 并写入 DeepSeek (THU) 模型配置'
    autoBtn.className = 'mmtok-btn' + (s.auto ? ' mmtok-auto-on' : '')
    autoBtn.textContent = s.auto ? 'Auto ✓' : 'Auto'
    autoBtn.title = s.auto
      ? 'Auto 已开启：计时超过 01:00 自动获取，点击关闭'
      : 'Auto 已关闭：点击开启，计时超过 01:00 自动获取'
    var el = fmt(s.lastGetAt ? Date.now() - s.lastGetAt : 0)
    elapsedEl.textContent = el
    elapsedEl.title = '距上次获取 ' + el + (s.auto ? '，超过 01:00 自动刷新' : '，超过 01:00 后可点击 Auto 开启自动刷新')
    // Only a real "no usable token" state raises the warning. A broken renewal
    // path while a token still works is a hover note, not a permanent alarm.
    var needsLogin = s.status === 'needs-login'
    warnEl.textContent = needsLogin ? '⚠' : ''
    warnEl.title = needsLogin
      ? (LOGIN_REASON_TEXT[s.loginReason] || '需要登录：点击 Get 打开登录窗口')
      : ''
  }

  // Sidebar-foot widget: buttons left, timer pushed flush right, no divider
  // lines. Auto ON = green button labeled "Auto ✓" (matches the original look).
  var css = [
    '.mmtok-box{display:block;padding:6px 10px 6px 11px;width:100%;min-width:0;box-sizing:border-box;pointer-events:auto;}',
    '.mmtok-box.mmtok-floating{padding:6px 10px;width:auto;max-width:calc(100vw - 20px);background:var(--dsw-alias-bg-base,Canvas);border:1px solid rgba(128,128,128,.45);border-radius:10px;box-shadow:0 4px 16px rgba(0,0,0,.18);position:fixed;left:10px;bottom:10px;z-index:2147483000;}',
    '.mmtok-btns{display:flex;align-items:center;gap:12px;width:100%;max-width:100%;min-width:0;box-sizing:border-box;}',
    '.mmtok-box.mmtok-floating .mmtok-btns{width:auto;}',
    '.mmtok-btn{font-size:14px;line-height:1.6;padding:0 8px;border-radius:6px;border:1px solid rgba(128,128,128,.45);background:transparent;color:inherit;cursor:pointer;white-space:nowrap;flex:none;}',
    '.mmtok-btn:hover{border-color:rgba(128,128,128,.85);background:rgba(128,128,128,.18);}',
    '.mmtok-btn.mmtok-auto-on{background:#4caf50;color:#fff;border-color:#4caf50;}',
    '.mmtok-disabled{opacity:.5;cursor:default;}',
    '.mmtok-dot{width:8px;height:8px;border-radius:50%;flex:none;}',
    '.mmtok-ok{background:#4caf50;}',
    '.mmtok-busy{background:#ffb300;animation:mmtok-pulse 1s infinite;}',
    '.mmtok-stale{background:#ff9800;}',
    '.mmtok-off{background:#9e9e9e;}',
    '@keyframes mmtok-pulse{0%,100%{opacity:1}50%{opacity:.3}}',
    '.mmtok-timer-status{min-width:0;color:#ffb300;font-size:14px;flex:none;}',
    '.mmtok-elapsed{margin-left:auto;font-size:14px;font-variant-numeric:tabular-nums;color:inherit;user-select:none;line-height:1;font-family:ui-monospace,Consolas,monospace;flex:none;padding-right:0;}',
  ].join('')

  function injectStyle() {
    var id = 'mmtok-style'
    if (document.getElementById(id)) return
    var style = document.createElement('style')
    style.id = id
    style.textContent = css
    document.head.appendChild(style)
  }

  function boot() {
    injectStyle()
    ensureDom()
    tryMount()
    refresh()
    // Re-mount if the sidebar re-renders (React swaps nodes) or was missing.
    intervalIds.push(setInterval(function () { render() }, 1000))
    intervalIds.push(setInterval(function () { refresh() }, 10000))
    intervalIds.push(setInterval(function () { tryMount() }, 2000))
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot)
  else boot()
})()
