'use strict';
// THU Tok Auto — core business logic, dependency-injected so it stays unit-testable
// outside a running DSH host. Environment access (fs, fetch, WebSocket, processes)
// is completely abstracted away; lib/index.js wires the real implementations and
// the DSH profile services (settings, credentials, timer, webServer, connection).
//
// get-tok ladder, in order: (1) mint via /auth-login/check — the site shut anonymous issuance
// down (2026-09-29: no credentials now returns 10001 "ticket已过期或无效", so this rung normally
// misses) → (2) read the session back from a still-running login browser → (3) SSO replay with
// the saved cookie jar → (4) reuse the token in hand while the server still accepts it →
// (5) a manual Get opens Edge/Chrome on the SSO login form (CDP capture); Auto ticks never
// open a window.
// On success the fresh token is written into the DSH model provider config:
//   credentials.set('MADMODEL_API_KEY', token)  +  ensure llm-pi-ai.providers.*(baseURL=madmodel) exists.

// Off campus the real host answers 307 to oauth.tsinghua.edu.cn. LOCAL_BASE is the
// local WebVPN adapter (webvpn-proxy.mjs) which injects the wengine_vpn_ticket
// cookie and streams the gateway's response. Point MADMODEL_LOCAL_BASE at the real
// host to go direct again (e.g. on campus).
const LOCAL_BASE = (typeof process !== 'undefined' && process.env && process.env.MADMODEL_LOCAL_BASE)
  ? String(process.env.MADMODEL_LOCAL_BASE).replace(/\/+$/, '')
  : 'http://127.0.0.1:8788';
export const SITE = LOCAL_BASE;
const SSO_APP = 'd736f067a6705ab942df52f958a0f23b'; // md5('DEEPSEEK'), verified against id.tsinghua.edu.cn
// The window the user is asked to log in through. Opening the site's own home
// page instead meant landing on an SPA with no login affordance in sight, which
// reads as "not a login page" (reported 2026-09-29). The SSO form carries the
// `?/authLogin` callback, so a successful login lands back on madmodel and the
// capture reads the fresh session from there.
export const SSO_LOGIN_URL = 'https://id.tsinghua.edu.cn/do/off/ui/auth/login/form/' + SSO_APP + '/0?/authLogin';
export const CDP_PORT_START = 9333;
export const CDP_PORT_END = 9343;
export const CRED_REF = 'MADMODEL_API_KEY';
export const PROVIDER_NAME = 'DeepSeek (THU)';
export const PROVIDER_KEY = 'madmodel';
export const PROVIDER_BASE = LOCAL_BASE + '/v1';
export const TOKEN_LIFETIME_MS = 6 * 3600e3; // empirically exp-iat == 6h on check-issued JWTs (site guide says 5h for login-issued)
// Auto re-issues on a flat hourly interval instead of aiming at the token's
// assumed expiry. The 6h lifetime is a decoded JWT property rather than a
// promise, and the mint service stamps its clock ~10min ahead of this machine,
// so any "renew N minutes before expiry" scheme sits on estimates. Re-issuing
// costs nothing, which makes the plain interval the sturdier choice.
// Renewal only *looks* automatic, though: while the session lives the site hands
// back the very same token, so RENEWAL_MARGIN_MS is what actually protects the
// tail (see RENEWAL_MARGIN_MS).
export const AUTO_REFRESH_MS = 1 * 3600e3;
export const AUTO_RETRY_MS = 5 * 60e3;
export const CAPTURE_INTERVAL_MS = 2500;
export const CAPTURE_TIMEOUT_MS = 20 * 60e3;
// The usable context is the smaller of two measured caps (both re-measured 2026-10-01):
//   - the deployment itself: 1,048,576 prompt tokens passed and the next step up was
//     refused ("服务器繁忙"), i.e. the model runs max-model-len = 1 MiB tokens;
//   - the gateway in front of it: 8,388,608 request bytes pass, 8,388,609 get 413
//     (nginx `client_max_body_size 8m`), which is ~1.34M tokens of English text — so
//     the model, not the gateway, is the binding constraint now.
// 1,000,000 leaves ~48k tokens of headroom for the system prompt and tool definitions
// that ride along on every request. (The previous 150,000 came from the 1 MiB body cap
// the gateway had until 2026-10, when anything larger was refused outright.)
const CONTEXT_WINDOW = 1000000;
// Models whose image input is confirmed by an actual request, which can differ
// from what the site's own model list claims (it marks DeepSeek-V4.1-Flash as
// text-only, yet it read a test image and named its colour correctly).
const IMAGE_CONFIRMED = ['DeepSeek-V4.1-Flash'];
// Shown when neither mint nor SSO can produce a new token — e.g. the site closed
// the anonymous mint endpoint and the saved SSO session expired, so the user has
// to log in once more (see runGetTok).
const RENEWAL_HINT = '免登录签发与 SSO 续期均不可用，请重新登录';
// Same situation, but the token in hand still works: worth a note, never a modal.
const RENEWAL_NOTE = '免登录签发已关闭、SSO 会话已过期：当前令牌仍可用，到期后需重新登录一次';
// The renewal ran, but handed back the very same token: a session-bound token keeps
// its original expiry until a real login issues a new one, so nothing was extended.
const RENEWAL_STALLED = '拿到的是同一张令牌：到期时间未前进，到期后需要重新登录';
// When the token is this close to dying and no automatic path can replace it, even a
// background tick may open the login window: waiting means a hard outage (measured
// 2026-10-01: the token died at 20:06 and nothing worked again until a manual Get at
// 20:12). A manual click always may. The two rejected extremes: popping a window on
// every tick, and never popping one until the token is already dead.
export const RENEWAL_MARGIN_MS = 1 * 3600e3;
// Rate limit for that background prompt, so an unattended machine cannot stack windows.
const LOGIN_PROMPT_MIN_INTERVAL_MS = 30 * 60e3;
// Models the site offers but this plugin deliberately does not register. Kept
// out of both the fallback profile and the live sync, so the site's own list
// can never put one back.
const EXCLUDED_MODEL_IDS = [
  'DeepSeek-V4-Flash-Vision-Exp', // V4.1-Flash already covers image input
  'DeepSeek-R1-W8A8',
];
// Fallback profile, used when the site's model list cannot be read. The live
// list is fetched from the site itself (see fetchSiteModels); this copy only
// has to keep the plugin useful while that fetch is failing.
const MODEL_PROFILE = [
  {
    id: 'DeepSeek-V4.1-Flash',
    name: 'DeepSeek-V4.1-Flash (THU)',
    contextWindow: CONTEXT_WINDOW,
    input: ['text', 'image'],
    reasoningEfforts: { low: 'low', high: 'high', max: 'max' },
  },
  {
    id: 'qwen3.8-27b',
    name: 'qwen3.8-27b (THU)',
    contextWindow: CONTEXT_WINDOW,
    input: ['text', 'image'],
    reasoningEfforts: { low: 'low', medium: 'medium', xhigh: 'xhigh' },
  },
];
const MODEL_CACHE_MS = 6 * 3600e3;
// Every pi-ai thinking level a site-declared effort may name (see the site's
// own effortOptions; "off" is not sent, so it never appears there).
const THINKING_LEVELS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

function sliceBracket(js, start) {
  if (start < 0) return null;
  let depth = 0;
  let quote = '';
  for (let i = start; i < js.length; i++) {
    const c = js[i];
    if (quote) {
      if (c === '\\') { i++; continue; }
      if (c === quote) quote = '';
      continue;
    }
    if (c === '"' || c === "'") { quote = c; continue; }
    if (c === '[') depth++;
    else if (c === ']') { depth--; if (depth === 0) return js.slice(start + 1, i); }
  }
  return null;
}

function splitTopLevelObjects(body) {
  const out = [];
  let depth = 0;
  let cur = '';
  let quote = '';
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (quote) {
      cur += c;
      if (c === '\\') { cur += body[++i] || ''; continue; }
      if (c === quote) quote = '';
      continue;
    }
    if (c === '"' || c === "'") { quote = c; cur += c; continue; }
    if (c === '{') { depth++; cur += c; continue; }
    if (c === '}') { depth--; cur += c; if (depth === 0) { out.push(cur); cur = ''; } continue; }
    if (depth > 0) cur += c;
  }
  return out;
}

function fieldString(entry, key) {
  const m = entry.match(new RegExp(key + ':"([^"]*)"'));
  return m ? m[1] : '';
}

/**
 * Read the model list out of the site's own front-end bundle.
 *
 * The site exposes no model-list API (`/v1/models` falls through to the SPA),
 * so the list the page itself uses — `modelList:[{label,value,supportImage,
 * thinkingParam,effortOptions}, …]` inside the hashed JS bundle — is the only
 * source. Parsing stays tolerant of field order and minified variable names,
 * and returns null on anything unexpected so the caller falls back to
 * MODEL_PROFILE instead of writing a half-read list.
 */
export function extractModelList(js) {
  if (typeof js !== 'string' || !js) return null;
  const at = js.indexOf('modelList:[');
  if (at < 0) return null;
  const body = sliceBracket(js, js.indexOf('[', at));
  if (!body) return null;
  const models = [];
  for (const entry of splitTopLevelObjects(body)) {
    const id = fieldString(entry, 'value');
    if (!id) continue;
    const effortField = entry.match(/effortOptions:\[([^\]]*)\]/);
    const efforts = effortField
      ? effortField[1].split(',').map(function (s) { return s.trim().replace(/^["']|["']$/g, ''); }).filter(Boolean)
      : [];
    models.push({
      id: id,
      label: fieldString(entry, 'label') || id,
      supportImage: /supportImage:!0|supportImage:true/.test(entry),
      efforts: efforts,
    });
  }
  return models.length ? models : null;
}

/** Turn the site's own list into the provider `models` shape llm-pi-ai stores. */
export function toProviderModels(siteModels) {
  if (!Array.isArray(siteModels) || !siteModels.length) return null;
  const kept = siteModels.filter(function (m) {
    return m && m.id && EXCLUDED_MODEL_IDS.indexOf(m.id) === -1;
  });
  if (!kept.length) return null;
  return kept.map(function (m) {
    const efforts = {};
    for (const e of m.efforts || []) if (THINKING_LEVELS.indexOf(e) !== -1) efforts[e] = e;
    const model = {
      id: m.id,
      name: (m.label || m.id) + ' (THU)',
      contextWindow: CONTEXT_WINDOW,
      input: (m.supportImage || IMAGE_CONFIRMED.indexOf(m.id) !== -1) ? ['text', 'image'] : ['text'],
    };
    if (Object.keys(efforts).length) model.reasoningEfforts = efforts;
    return model;
  });
}

/** Compare only the fields this plugin owns, so a live list rewrites rarely. */
function modelsEqual(a, b) {
  const norm = function (list) {
    return JSON.stringify((Array.isArray(list) ? list : []).map(function (m) {
      return {
        id: (m && m.id) || '',
        name: (m && m.name) || '',
        contextWindow: (m && m.contextWindow) || 0,
        input: (m && m.input) || [],
        reasoningEfforts: (m && m.reasoningEfforts) || {},
      };
    }));
  };
  return norm(a) === norm(b);
}

/**
 * Build a Cookie header for one URL out of a cookie jar: match by domain, path
 * and secure flag, drop expired entries, and send longer paths first (the order
 * browsers use). A pure function so these rules can be tested directly.
 */
export function buildCookieHeader(jar, target, now) {
  let u = null;
  try { u = new URL(String(target || '')); } catch (e) { return ''; }
  const host = u.hostname.toLowerCase();
  const at = typeof now === 'number' ? now : Date.now();
  return (Array.isArray(jar) ? jar : []).filter(function (c) {
    if (!c || !c.name) return false;
    const d = String(c.domain || '').toLowerCase().replace(/^\.+/, '');
    if (!d || !(host === d || host.endsWith('.' + d))) return false;
    const p = c.path || '/';
    const pathOK = u.pathname === p || (u.pathname.indexOf(p) === 0 && (p.charAt(p.length - 1) === '/' || u.pathname.charAt(p.length) === '/'));
    if (!pathOK) return false;
    if (c.secure && u.protocol !== 'https:') return false;
    if (typeof c.expires === 'number' && c.expires > 0 && c.expires * 1000 <= at) return false;
    return true;
  }).sort(function (a, b) {
    return String(b.path || '/').length - String(a.path || '/').length;
  }).map(function (c) { return c.name + '=' + c.value; }).join('; ');
}

/**
 * A token's own expiry in epoch milliseconds, decoded locally. The panel used to
 * estimate it as "last fetch + 6h", which overstates the remaining life whenever an
 * older token is read back from a live browser (measured 2026-10-01: token issued
 * 14:06, read back 16:30, panel claimed 2.4h more than it had). Returns 0 when the
 * token cannot be decoded, so callers can fall back to the old estimate.
 */
export function jwtExpiry(token) {
  try {
    const part = String(token || '').split('.')[1];
    if (!part) return 0;
    const payload = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
    return typeof payload.exp === 'number' && payload.exp > 0 ? payload.exp * 1000 : 0;
  } catch (e) { return 0; }
}

export function createCore(deps) {
  const logger = deps.logger || console;
  const settingsSvc = deps.settings;
  const credSvc = deps.credentials;
  const state = {
    token: '', cookies: '', ssoCookies: '',
    lastGetAt: 0, auto: false, busy: false, status: 'idle', err: '',
    browserOpen: false, minted: false, provider: '', providerName: '', credentialWritten: false,
    // Outcome of the last run, plus why automatic renewal is unusable. The latter
    // is persisted (see saveState) so a restart cannot turn a broken renewal path
    // back into a healthy-looking "ok", and so the sidebar can explain it.
    lastVia: '', loginReason: '', refreshBlocked: false, cookieJar: [],
    // Local facts about the token in hand: its own expiry, and whether the server
    // accepted it the last time we asked.
    tokenExpAt: 0, serverValid: null, lastValidatedAt: 0,
    // True when the last renewal handed back a token whose expiry did not move:
    // a session-bound token comes back identical, so "fetched" is not "renewed".
    renewalNoProgress: false,
  };
  let baseDir = '';
  let initialized = false;
  let initPromise = null;
  let captureDispose = null;
  let captureBusy = false;
  let captureElapsed = 0;
  let cdpPort = CDP_PORT_START;
  let lastAutoAttemptAt = 0;
  let lastLoginPromptAt = 0;
  let disposed = false;

  const jsonParse = function (txt) { try { return JSON.parse(txt); } catch (e) { return null; } };
  const cookieDomain = function (value) { return String(value || '').toLowerCase().replace(/^\.+/, ''); };
  // Cookies are kept whole and picked per request URL (domain + path + secure +
  // not expired), instead of being filtered by host at capture time. The SSO
  // chain spans id./oauth./auth*.tsinghua.edu.cn, and dropping the hosts this
  // plugin did not recognise is what made a captured session unreplayable.
  // A jar with no madmodel.cs.tsinghua.edu.cn entry is expected, not a fault: that
  // site authenticates with the JWT kept in localStorage, so its cookie header is
  // legitimately empty (verified 2026-10-01).
  const cookieHeaderFor = function (target) {
    return buildCookieHeader(state.cookieJar, target, deps.clock.now());
  };
  /** Merge freshly read cookies into the jar, newest value per name+domain+path. */
  const mergeCookies = function (cookies) {
    if (!Array.isArray(cookies) || !cookies.length) return 0;
    if (!Array.isArray(state.cookieJar)) state.cookieJar = [];
    let merged = 0;
    for (const c of cookies) {
      if (!c || !c.name || typeof c.value !== 'string') continue;
      const d = cookieDomain(c.domain);
      if (!d) continue;
      const entry = {
        name: c.name, value: c.value, domain: d, path: c.path || '/',
        secure: !!c.secure, expires: typeof c.expires === 'number' ? c.expires : -1,
      };
      const key = d + '|' + entry.path + '|' + entry.name;
      const i = state.cookieJar.findIndex(function (x) { return cookieDomain(x.domain) + '|' + (x.path || '/') + '|' + x.name === key; });
      if (i === -1) state.cookieJar.push(entry); else state.cookieJar[i] = entry;
      merged++;
    }
    return merged;
  };
  const isMadModelUrl = function (value) {
    const m = String(value || '').match(/^https?:\/\/([^\/:?#]+)(?::\d+)?(?:[\/?#]|$)/i);
    if (!m) return false;
    const h = m[1].toLowerCase();
    // The local WebVPN adapter serves the very same API, so it is "ours" too.
    return h === 'madmodel.cs.tsinghua.edu.cn' || h === '127.0.0.1' || h === 'localhost';
  };
  const isSsoUrl = function (value) {
    const m = String(value || '').match(/^https:\/\/([^\/:?#]+)(?::\d+)?(?:[\/?#]|$)/i);
    if (!m) return false;
    const h = m[1].toLowerCase();
    return h === 'id.tsinghua.edu.cn' || h === 'oauth.tsinghua.edu.cn';
  };
  const resolveLocation = function (base, location) {
    try {
      const resolved = new URL(String(location || ''), String(base || ''));
      return resolved.protocol === 'https:' ? resolved.href : '';
    } catch (e) { return ''; }
  };

  function ensureBaseDir() {
    const env = deps.env || {};
    const home = env.home || env.temp || '';
    baseDir = home ? home + '\\.dsh\\madmodel' : 'C:\\Windows\\.dsh-madmodel';
  }

  async function httpGet(url, headers, follow) {
    const r = await deps.http(url, { headers: headers || {}, follow: follow === false ? false : true, timeoutMs: 25000 });
    if (!r || r.error) return null;
    return r;
  }
  const okData = function (r) {
    if (!r || r.status !== 200 || !r.text) return null;
    const j = jsonParse(r.text);
    if (!j || j.success !== true || typeof j.data !== 'string' || !j.data) return null;
    return j.data;
  };
  async function authValid(token, cookie) {
    const h = { Authorization: 'Bearer ' + token };
    const c = cookie || cookieHeaderFor(SITE + '/model-api/auth-login');
    if (c) h.Cookie = c;
    const r = await httpGet(SITE + '/model-api/auth-login', h, false);
    if (!r || r.status !== 200 || !r.text) return false;
    const j = jsonParse(r.text);
    return !!(j && j.success === true);
  }
  async function mintCheck() {
    return okData(await httpGet(SITE + '/model-api/auth-login/check', {}, false));
  }
  async function ssoReplay() {
    if (!cookieHeaderFor(SSO_LOGIN_URL)) return null;
    let cur = SSO_LOGIN_URL;
    let ticket = '';
    for (let hops = 0; hops < 10; hops++) {
      if (!isSsoUrl(cur) && !isMadModelUrl(cur)) return null;
      // Carry whatever applies to each hop: the chain crosses hosts, and the
      // madmodel leg needs its own cookies too (sending none there was another
      // reason a captured session failed to replay).
      const hdrs = {};
      const ch = cookieHeaderFor(cur);
      if (ch) hdrs.Cookie = ch;
      const r = await httpGet(cur, hdrs, false);
      if (!r) return null;
      if (r.status >= 300 && r.status < 400 && r.location) {
        cur = resolveLocation(cur, r.location);
        continue;
      }
      const m = String(cur).match(/[?&]ticket=([^&#]+)/);
      if (m) ticket = decodeURIComponent(m[1]);
      break;
    }
    if (!ticket) return null;
    return okData(await httpGet(SITE + '/model-api/auth-login/check?ticket=' + encodeURIComponent(ticket), {}, false));
  }
  async function listProviderNamespaces() {
    const out = [];
    try {
      if (settingsSvc && typeof settingsSvc.describe === 'function') {
        const desc = await settingsSvc.describe();
        if (Array.isArray(desc)) {
          for (const d of desc) {
            if (!d || typeof d !== 'object') continue;
            const name = d.ns || d.namespace || d.key || '';
            if (typeof name === 'string' && name.indexOf('llm-') === 0 && out.indexOf(name) === -1) out.push(name);
          }
        }
      }
    } catch (e) { logger.error('[thu-tok-auto] describe', e); }
    if (!out.length) out.push('llm-pi-ai', 'llm-deepseek');
    return out;
  }
  async function findProvider() {
    const nss = await listProviderNamespaces();
    for (const ns of nss) {
      let cur = null;
      try { cur = await settingsSvc.get(ns); } catch (e) { continue; }
      if (!cur || typeof cur !== 'object') continue;
      const providers = (cur.providers && typeof cur.providers === 'object') ? cur.providers : {};
      for (const id in providers) {
        const p = providers[id];
        if (!p || typeof p !== 'object') continue;
        const base = p.baseURL || '';
        if (typeof base === 'string' && isMadModelUrl(base)) {
          return {
            ns: ns,
            id: id,
            base: base,
            apiKeyEnv: typeof p.apiKeyEnv === 'string' ? p.apiKeyEnv : '',
            displayName: typeof p.displayName === 'string' ? p.displayName : '',
          };
        }
      }
    }
    return null;
  }
  // The site's live model list is the source of truth; MODEL_PROFILE is only
  // what we fall back to when it cannot be read. Cached, because reading it
  // means downloading the site's multi-megabyte front-end bundle.
  let modelCache = { at: 0, models: null };
  async function fetchSiteModels() {
    if (modelCache.models && deps.clock.now() - modelCache.at < MODEL_CACHE_MS) return modelCache.models;
    try {
      const page = await httpGet(SITE + '/', {}, true);
      if (page && page.status === 200 && page.text) {
        const ref = String(page.text).match(/["']([^"']*assets\/js\/[^"']+\.js)["']/);
        if (ref) {
          const path = ref[1];
          const url = /^https?:/i.test(path) ? path : SITE + (path.charAt(0) === '/' ? '' : '/') + path;
          const bundle = await httpGet(url, {}, true);
          if (bundle && bundle.status === 200 && bundle.text) {
            const models = toProviderModels(extractModelList(bundle.text));
            if (models && models.length) {
              modelCache = { at: deps.clock.now(), models: models };
              return models;
            }
          }
        }
      }
    } catch (e) { logger.error('[thu-tok-auto] site models', e); }
    return modelCache.models;
  }
  async function resolveModels() {
    const live = await fetchSiteModels();
    return (live && live.length) ? live : MODEL_PROFILE;
  }
  function providerPatch(id, value) {
    // Runs directly in the DSH host process (no node:vm sandbox in the bundle form),
    // so plain objects are already Host-realm objects that dsh-settings accepts.
    const patch = { providers: {} };
    patch.providers[id] = value;
    return patch;
  }
  async function applyToProvider(token) {
    const res = { provider: '', providerName: '', detail: '', credentialWritten: false, err: '' };
    try {
      if (!credSvc || typeof credSvc.set !== 'function') { res.err += 'credentials service unavailable; '; }
      else {
        let current = null;
        try { current = await credSvc.resolve(CRED_REF); } catch (e) {}
        if (current && current.value === token) res.credentialWritten = true;
        else { await credSvc.set(CRED_REF, token); res.credentialWritten = true; }
      }
    } catch (e) { res.err += 'credential:' + String((e && e.message) || e) + '; '; }
    try {
      if (!settingsSvc || typeof settingsSvc.get !== 'function') { res.err += 'settings service unavailable; '; return res; }
      const found = await findProvider();
      const models = await resolveModels();
      if (found) {
        res.provider = found.ns + '/' + found.id;
        res.providerName = found.displayName || PROVIDER_NAME;
        res.detail = 'found';
        const cur = await settingsSvc.get(found.ns);
        if (cur) {
          const existing = (cur.providers && cur.providers[found.id]) || {};
          const patch = {};
          if (found.apiKeyEnv !== CRED_REF) patch.apiKeyEnv = CRED_REF;
          // The site renames and retires models over time. Without this an
          // existing provider keeps yesterday's list, and every request fails
          // with "模型不存在" until someone edits settings.yaml by hand.
          if (!modelsEqual(existing.models, models)) patch.models = models;
          if (Object.keys(patch).length) {
            await settingsSvc.update(found.ns, providerPatch(found.id, patch));
            res.detail = patch.models ? (patch.apiKeyEnv ? 'synced' : 'models-synced') : 'apiKeyEnv-set';
          }
        }
      } else {
        const ns = 'llm-pi-ai';
        const cur = await settingsSvc.get(ns);
        if (cur) {
          if (cur.providers && Object.hasOwn(cur.providers, PROVIDER_KEY)) {
            throw new Error('Provider "madmodel" 已被其他配置占用；请重命名该配置后重试。');
          }
          await settingsSvc.update(ns, providerPatch(PROVIDER_KEY, {
            displayName: PROVIDER_NAME,
            apiKeyEnv: CRED_REF,
            api: 'openai-completions',
            reasoning: 'medium',
            baseURL: PROVIDER_BASE,
            models: models,
          }));
          res.provider = ns + '/' + PROVIDER_KEY;
          res.providerName = PROVIDER_NAME;
          res.detail = 'created';
        } else res.err += 'settings namespace "llm-pi-ai" unavailable; ';
      }
    } catch (e) { res.err += 'settings:' + String((e && e.message) || e) + '; '; }
    return res;
  }
  const statePath = function () { return baseDir + '\\state.json'; };
  const loadedStatus = function () {
    // A remembered "needs login" only decides the status when there is nothing
    // usable to fall back on. While a token still works the widget stays green and
    // the blocked renewal path is reported in the hover text only — a permanent
    // warning for a working setup was a false alarm.
    if (!state.token) return state.refreshBlocked ? 'needs-login' : 'idle';
    // The server's own verdict outranks the local clock: a token the site has
    // already refused must not keep showing as "ok" until its nominal expiry.
    if (state.serverValid === false) return 'expired';
    const exp = state.tokenExpAt || (state.lastGetAt ? state.lastGetAt + TOKEN_LIFETIME_MS : 0);
    if (!exp) return 'idle';
    if (deps.clock.now() >= exp) return 'expired';
    // A valid token that could not be renewed is not "ok" either: say so while
    // there is still time to log in (2026-10-01, when every Auto run "succeeded"
    // against an expiry that never moved).
    if (state.renewalNoProgress) return 'no-progress';
    return 'ok';
  };
  let lastSavedStamp = '';
  async function saveState() {
    ensureBaseDir();
    const payload = {
      // The API token belongs in DSH's credential store, never in this state file.
      cookies: state.cookies, ssoCookies: state.ssoCookies,
      lastGetAt: state.lastGetAt, auto: state.auto,
      refreshBlocked: !!state.refreshBlocked, loginReason: state.loginReason,
      cookieJar: Array.isArray(state.cookieJar) ? state.cookieJar : [],
      tokenExpAt: state.tokenExpAt || 0,
      serverValid: state.serverValid === null ? null : !!state.serverValid,
      lastValidatedAt: state.lastValidatedAt || 0,
      renewalNoProgress: !!state.renewalNoProgress,
    };
    // Auto ticks can run every few minutes without anything in here changing;
    // rewriting the file each time is pure churn.
    const stamp = JSON.stringify([payload.cookies, payload.ssoCookies, payload.cookieJar, payload.lastGetAt, payload.auto, payload.refreshBlocked, payload.loginReason, payload.tokenExpAt, payload.serverValid, payload.lastValidatedAt, payload.renewalNoProgress]);
    if (stamp === lastSavedStamp) return;
    const saved = await deps.stateIO.save(statePath(), payload);
    if (!saved || !saved.ok) throw new Error('state save failed: ' + String((saved && saved.error) || 'unknown error'));
    lastSavedStamp = stamp;
  }
  async function loadState() {
    try {
      ensureBaseDir();
      const r = await deps.stateIO.load(statePath());
      if (r && r.ok) {
        const d = r.data;
        if (d && typeof d === 'object') {
          let stored = null;
          if (credSvc && typeof credSvc.resolve === 'function') {
            try { stored = await credSvc.resolve(CRED_REF); } catch (e) {}
          }
          const credentialToken = stored && typeof stored.value === 'string' ? stored.value : '';
          const legacyToken = typeof d.token === 'string' ? d.token : '';
          state.token = credentialToken || legacyToken;
          state.cookies = typeof d.cookies === 'string' ? d.cookies.slice(0, 65536) : '';
          state.ssoCookies = typeof d.ssoCookies === 'string' ? d.ssoCookies.slice(0, 65536) : '';
          const savedAt = typeof d.lastGetAt === 'number' && Number.isFinite(d.lastGetAt) ? d.lastGetAt : 0;
          state.lastGetAt = savedAt > 0 && savedAt <= deps.clock.now() + 5 * 60e3 ? Math.min(savedAt, deps.clock.now()) : 0;
          state.auto = !!d.auto;
          state.refreshBlocked = !!d.refreshBlocked;
          state.loginReason = typeof d.loginReason === 'string' ? d.loginReason.slice(0, 200) : '';
          state.cookieJar = Array.isArray(d.cookieJar)
            ? d.cookieJar.filter(function (c) { return c && c.name && typeof c.value === 'string'; }).slice(0, 200)
            : [];
          state.tokenExpAt = jwtExpiry(state.token) || (typeof d.tokenExpAt === 'number' && Number.isFinite(d.tokenExpAt) ? d.tokenExpAt : 0);
          state.serverValid = d.serverValid === true ? true : (d.serverValid === false ? false : null);
          state.lastValidatedAt = typeof d.lastValidatedAt === 'number' && Number.isFinite(d.lastValidatedAt) ? d.lastValidatedAt : 0;
          state.renewalNoProgress = !!d.renewalNoProgress;
          state.credentialWritten = !!credentialToken;
          state.status = loadedStatus();
          // Migrate legacy state files that contained the token in plaintext.
          if (legacyToken && credSvc && typeof credSvc.set === 'function') {
            try {
              if (!credentialToken) { await credSvc.set(CRED_REF, legacyToken); state.credentialWritten = true; }
              await saveState();
            } catch (e) { logger.error('[thu-tok-auto] legacy token migration', e); }
          }
        } else {
          if (credSvc && typeof credSvc.resolve === 'function') {
            try {
              const stored = await credSvc.resolve(CRED_REF);
              state.token = stored && typeof stored.value === 'string' ? stored.value : '';
              state.credentialWritten = !!state.token;
              state.tokenExpAt = jwtExpiry(state.token);
            } catch (e) {}
          }
          state.status = loadedStatus();
        }
        if (state.token && settingsSvc && typeof settingsSvc.get === 'function') {
          try {
            const found = await findProvider();
            if (found) {
              state.provider = found.ns + '/' + found.id;
              state.providerName = found.displayName || PROVIDER_NAME;
            }
          } catch (e) {}
        }
      }
    } catch (e) { logger.error('[thu-tok-auto] load', e); }
  }
  function ensureLoaded() {
    if (!initialized) {
      initialized = true;
      initPromise = loadState();
    }
    return initPromise;
  }
  function snapshot() {
    // expiresAt is derived from lastGetAt + 6h (local-clock consistent) rather than the JWT exp:
    // the mint service stamps iat/exp on a clock ~9.6min AHEAD of the web layer / this machine
    // (verified: mint response Date header == local clock while iat == local + 9.6min), so
    // exp - Date.now() overstates remaining lifetime by ~10min. Site API guide claims 5h for
    // login-issued tokens; check-issued JWTs decode to exactly 6h (exp - iat), sampled repeatedly.
    // expiresAt keeps reporting the assumed 6h lifetime; Auto re-issues hourly.
    return {
      auto: state.auto, busy: state.busy, lastGetAt: state.lastGetAt, status: state.status, err: state.err,
      loggedIn: !!state.token,
      // Real expiry from the token itself; the estimate is only a fallback for a
      // token we could not decode.
      expiresAt: state.tokenExpAt || (state.lastGetAt ? state.lastGetAt + TOKEN_LIFETIME_MS : 0),
      serverValid: state.serverValid, lastValidatedAt: state.lastValidatedAt,
      renewalNoProgress: state.renewalNoProgress,
      browserOpen: state.browserOpen, minted: state.minted,
      provider: state.provider, providerName: state.providerName, credentialWritten: state.credentialWritten,
      via: state.lastVia, loginReason: state.loginReason, refreshBlocked: state.refreshBlocked,
    };
  }
  async function runGetTok(opts) {
    // `background` marks an Auto tick. A click on Get is the user asking for a
    // refresh, so when no automatic path can produce one, handing them the login
    // window is the only useful answer; a background tick must never do that.
    // (Both extremes were wrong: always popping a window nags, and never popping
    // one leaves the button dead once the automatic paths are gone.)
    const background = !!(opts && opts.background);
    await ensureLoaded();
    if (disposed) return snapshot();
    if (state.busy) return snapshot();
    state.busy = true;
    state.status = 'refreshing';
    state.err = '';
    try {
      const old = state.token;
      let t = '';
      let via = '';
      let reusable = '';
      const d = await mintCheck();
      if (disposed) { state.busy = false; return snapshot(); }
      if (d) { t = d; via = 'mint'; }
      if (!t && state.token) {
        const ok = await authValid(state.token);
        if (disposed) { state.busy = false; return snapshot(); }
        if (ok) reusable = state.token;
      }
      if (!t) {
        // A browser still running with the login profile carries the SSO session
        // (and possibly a fresher token), so read it before replaying anything.
        const live = await renewFromBrowser();
        if (disposed) { state.busy = false; return snapshot(); }
        if (live && live.token) {
          const okLive = await authValid(live.token);
          if (disposed) { state.busy = false; return snapshot(); }
          if (okLive) { t = live.token; via = 'browser'; }
        }
      }
      if (!t) {
        const sso = await ssoReplay();
        if (disposed) { state.busy = false; return snapshot(); }
        if (sso) { t = sso; via = 'sso'; }
      }
      // Neither renewal path produced a fresh token.
      const renewalBroken = !t;
      if (!t && reusable) { t = reusable; via = 'reuse'; }
      if (!t) {
        // Nothing usable at all: the only case that asks the user to log in.
        state.refreshBlocked = true;
        state.loginReason = 'renewal-unavailable';
        state.status = 'needs-login';
        state.err = RENEWAL_HINT;
        state.busy = false;
        try { await saveState(); } catch (e) {}
        const out = snapshot();
        out.loginRequired = true;
        out.via = 'none';
        out.fresh = false;
        return out;
      }
      state.token = t;
      // Re-validating an old token does not mint a new lifetime. Preserve the original local
      // issuance baseline so Auto cannot run an aging token for another full interval.
      if (via !== 'reuse') state.lastGetAt = deps.clock.now();
      // "We fetched something" is not "we renewed". A session-bound token comes back
      // identical while the session lives, so compare expiries before claiming success
      // (2026-10-01: Auto reported success hourly while exp never moved, and the token
      // died at its original expiry). An undecodable token leaves the check unknown.
      const previousExp = state.tokenExpAt || 0;
      state.tokenExpAt = jwtExpiry(t);
      const expiryAdvanced = !previousExp || !state.tokenExpAt || state.tokenExpAt > previousExp;
      state.renewalNoProgress = !expiryAdvanced;
      state.minted = via === 'mint';
      state.lastVia = via;
      // mint / live-browser / SSO hand over a token nobody has served yet: ask the
      // server once, so a rejected token cannot keep the panel green (2026-09-29).
      const serverOk = await authValid(t);
      if (disposed) { state.busy = false; return snapshot(); }
      state.serverValid = !!serverOk;
      state.lastValidatedAt = deps.clock.now();
      // renewalBroken only annotates here: the token works, so the widget stays
      // green and the note lives in the hover text instead of a permanent warning.
      state.refreshBlocked = renewalBroken;
      state.loginReason = renewalBroken ? 'renewal-unavailable' : '';
      const pw = await applyToProvider(t);
      state.provider = pw.provider;
      state.providerName = pw.providerName;
      state.credentialWritten = pw.credentialWritten;
      state.err = pw.err || (renewalBroken ? RENEWAL_NOTE : '');
      if (!serverOk && !pw.err) state.err = '服务端不接受该令牌（auth-login 校验未通过）';
      else if (!expiryAdvanced && !pw.err) state.err = RENEWAL_STALLED;
      state.status = !pw.err && pw.credentialWritten && pw.provider
        ? (serverOk ? (expiryAdvanced ? 'ok' : 'no-progress') : 'error')
        : 'error';
      try { await saveState(); } catch (e) {
        state.err += 'state:' + String((e && e.message) || e) + '; ';
        if (state.status === 'ok') state.status = 'error';
      }
      state.busy = false;
      const out = snapshot();
      out.fresh = t !== old;
      out.via = via;
      out.loginRequired = false;
      out.detail = pw.detail;
      out.err = state.err;
      out.expiryAdvanced = expiryAdvanced;
      // A click that could not renew hands the user the one door still open — the
      // login window. A background tick does the same, but only when the token is
      // nearly out and it has not prompted recently; otherwise it just records the
      // state. The token in hand stays usable either way, so the widget does not
      // turn into a warning while the user decides.
      if (renewalBroken) {
        const expAt = state.tokenExpAt || (state.lastGetAt ? state.lastGetAt + TOKEN_LIFETIME_MS : 0);
        const nearlyOut = !!expAt && (expAt - deps.clock.now()) <= RENEWAL_MARGIN_MS;
        const throttled = background && (deps.clock.now() - lastLoginPromptAt) < LOGIN_PROMPT_MIN_INTERVAL_MS;
        if (!background || (nearlyOut && !throttled)) {
          out.loginRequired = true;
          out.detail = 'renewal-unavailable';
          out.nearlyOut = nearlyOut;
          if (!out.err) out.err = nearlyOut ? RENEWAL_NOTE + '（令牌即将到期，已为你打开登录窗口）' : RENEWAL_NOTE;
          if (background) lastLoginPromptAt = deps.clock.now();
        }
      }
      return out;
    } catch (e) {
      state.status = 'error';
      state.err = String((e && e.message) || e);
      state.busy = false;
      const out = snapshot();
      out.err = state.err;
      out.loginRequired = false;
      return out;
    } finally {
      state.busy = false;
    }
  }
  async function resolveBrowser() {
    const local = String((deps.env && deps.env.localAppData) || '').replace(/[\\\/]+$/, '');
    const cands = [
      'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
      'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
      local ? local + '\\Microsoft\\Edge\\Application\\msedge.exe' : '',
      local ? local + '\\Google\\Chrome\\Application\\chrome.exe' : '',
    ];
    for (const c of cands) {
      if (!c) continue;
      try { if (await deps.findExecutable(c)) return c; } catch (e) {}
    }
    return null;
  }
  /**
   * Renew from a browser that is still running the login profile. An SSO session
   * lives in that process (its cookie is a session cookie, so a file copy cannot
   * revive it once the window is gone), which is why the session has to be read
   * back from a live instance instead. This is also how other THU tooling keeps
   * a login: reuse the browser session that is already there.
   */
  async function renewFromBrowser() {
    for (let port = CDP_PORT_START; port <= CDP_PORT_END; port++) {
      const probe = await deps.cdp({ port: port, timeoutMs: 1200, probeOnly: true });
      if (disposed) return null;
      if (!probe || !probe.running) return null; // nothing listening: no live instance
      if (!probe.ok) continue; // listening but no usable page on this port
      const r = await deps.cdp({ port: port, timeoutMs: 20000 });
      if (disposed || !r || !r.ok) return null;
      cdpPort = port;
      const merged = mergeCookies(r.cookies);
      return { port: port, token: r.token || '', merged: merged };
    }
    return null;
  }
  async function openLogin() {
    await ensureLoaded();
    if (disposed) { state.loginReason = 'disposed'; return { launched: false, reason: 'disposed' }; }
    if (state.browserOpen) { state.loginReason = 'already-open'; return { launched: false, reason: 'already-open' }; }
    try {
      ensureBaseDir();
      const made = await deps.stateIO.mkdir(baseDir + '\\profile');
      if (!made || !made.ok) throw new Error('无法创建登录浏览器目录：' + String((made && made.error) || 'unknown error'));
      let availablePort = 0;
      for (let port = CDP_PORT_START; port <= CDP_PORT_END; port++) {
        const probe = await deps.cdp({ port: port, timeoutMs: 1200, probeOnly: true });
        if (disposed) return { launched: false, reason: 'disposed' };
        if (probe && probe.ok) {
          cdpPort = port;
          state.browserOpen = true;
          state.loginReason = 'reuse';
          startCapture();
          return { launched: false, reason: 'reuse', port: port };
        }
        if (!probe || !probe.running) { availablePort = port; break; }
      }
      if (!availablePort) {
        state.status = 'error';
        state.err = '调试端口 9333-9343 均被占用';
        state.loginReason = 'no-debug-port';
        return { launched: false, reason: 'no-debug-port' };
      }
      cdpPort = availablePort;
      const browser = await resolveBrowser();
      if (!browser) {
        state.status = 'error';
        state.err = '未找到 Edge/Chrome';
        state.loginReason = 'no-browser';
        return { launched: false, reason: 'no-browser' };
      }
      const launched = await deps.spawnBrowser(browser, [
        '--remote-debugging-port=' + cdpPort,
        '--user-data-dir=' + baseDir + '\\profile',
        '--no-first-run',
        '--no-default-browser-check',
        '--no-session-restore',
        SSO_LOGIN_URL,
      ]);
      if (disposed) return { launched: false, reason: 'disposed' };
      state.browserOpen = true;
      state.status = 'needs-login';
      state.loginReason = '';
      startCapture();
      return { launched: true, pid: launched && launched.pid, browser: browser, port: cdpPort };
    } catch (e) {
      state.status = 'error';
      state.err = String((e && e.message) || e);
      state.loginReason = 'error';
      return { launched: false, reason: 'error', err: state.err };
    }
  }
  function startCapture() {
    if (disposed || captureDispose) return;
    captureElapsed = 0;
    const iv = deps.timer.interval(async function () {
      if (disposed) return;
      captureElapsed += CAPTURE_INTERVAL_MS;
      if (captureElapsed > CAPTURE_TIMEOUT_MS) { stopCapture('timeout'); return; }
      if (captureBusy) return;
      captureBusy = true;
      try {
        const r = await deps.cdp({ port: cdpPort, timeoutMs: 20000 });
        if (disposed) return;
        if (r && r.ok) {
          let done = false;
          // Keep every cookie the browser holds; the header for each request is
          // built per URL from this jar (see cookieHeaderFor).
          mergeCookies(r.cookies);
          const cookie = cookieHeaderFor(SITE + '/model-api/auth-login');
          const sh = cookieHeaderFor(SSO_LOGIN_URL);
          if (cookie) state.cookies = cookie;
          if (sh) state.ssoCookies = sh;
          let token = '';
          let via = '';
          if (r.token) {
            const valid = await authValid(r.token, cookie);
            if (disposed) return;
            if (valid) { token = r.token; via = 'login'; }
          }
          if (!token) {
            const d = await mintCheck();
            if (disposed) return;
            if (d) { token = d; via = 'capture-mint'; }
          }
          if (token) {
            // Same "did the expiry actually move?" rule as the ladder.
            const previousExp = state.tokenExpAt || 0;
            state.token = token;
            state.lastGetAt = deps.clock.now();
            state.tokenExpAt = jwtExpiry(token);
            const expiryAdvanced = !previousExp || !state.tokenExpAt || state.tokenExpAt > previousExp;
            state.renewalNoProgress = !expiryAdvanced;
            state.minted = via === 'capture-mint';
            // Same rule as the ladder: an unverified token must never look healthy.
            state.serverValid = await authValid(token);
            state.lastValidatedAt = deps.clock.now();
            const pw = await applyToProvider(token);
            state.provider = pw.provider;
            state.providerName = pw.providerName;
            state.credentialWritten = pw.credentialWritten;
            state.err = pw.err || (state.serverValid ? '' : '服务端不接受该令牌（auth-login 校验未通过）');
            const healthy = !pw.err && pw.credentialWritten && pw.provider && state.serverValid;
            state.status = !healthy ? 'error' : (expiryAdvanced ? 'ok' : 'no-progress');
            if (state.status === 'no-progress' && !state.err) state.err = RENEWAL_STALLED;
            done = true;
          }
          if (done) {
            // Clear the remembered block before persisting. Saving first and
            // clearing afterwards is what left "needs login" stuck in the state
            // file even though the capture had just succeeded.
            state.refreshBlocked = false;
            state.loginReason = '';
            try { await saveState(); } catch (e) {
              state.err += 'state:' + String((e && e.message) || e) + '; ';
              state.status = 'error';
            }
            stopCapture('captured');
          }
        } else if (r && r.running === false && captureElapsed >= 10000) {
          stopCapture('closed');
        } else if (r && r.error && String(r.error).toLowerCase().indexOf('refused') !== -1) {
          stopCapture('closed');
        }
      } catch (e) { logger.error('[thu-tok-auto] capture', e); }
      finally { captureBusy = false; }
    }, CAPTURE_INTERVAL_MS);
    captureDispose = function () {
      try { iv(); } catch (e) {}
      captureDispose = null;
      captureBusy = false;
      state.browserOpen = false;
    };
  }
  function stopCapture(reason) {
    const was = state.status;
    if (captureDispose) captureDispose();
    if (reason === 'captured' && state.status !== 'error') {
      // A successful capture proves the login path works again, so drop the block.
      state.status = 'ok';
      state.refreshBlocked = false;
      state.loginReason = '';
    }
    else if (reason === 'closed' && was !== 'ok') { state.status = 'needs-login'; state.err = '登录窗口已关闭'; }
    else if (reason === 'timeout' && was !== 'ok') { state.status = 'needs-login'; state.err = '登录等待超时'; }
  }
  async function autoTick() {
    await ensureLoaded();
    if (disposed) return snapshot();
    if (!state.auto || state.busy || state.browserOpen) return snapshot();
    const now = deps.clock.now();
    const refreshDue = !state.lastGetAt || now - state.lastGetAt >= AUTO_REFRESH_MS;
    const repairDue = !!state.token && (state.status === 'error' || !state.credentialWritten || !state.provider);
    if (!refreshDue && !repairDue) return snapshot();
    if (now - lastAutoAttemptAt < AUTO_RETRY_MS) return snapshot();
    lastAutoAttemptAt = now;
    return runGetTok({ background: true });
  }
  const api = {
    init: async function () { await ensureLoaded(); return snapshot(); },
    state: async function () { await ensureLoaded(); return snapshot(); },
    setAuto: async function (on) {
      await ensureLoaded();
      if (disposed) return snapshot();
      state.auto = !!on;
      try { await saveState(); } catch (e) {
        state.status = 'error';
        state.err = 'state:' + String((e && e.message) || e);
        return snapshot();
      }
      if (state.auto && (!state.lastGetAt || deps.clock.now() - state.lastGetAt >= AUTO_REFRESH_MS)) return autoTick();
      return snapshot();
    },
    getTok: async function () { return runGetTok(); },
    openLogin: async function () { return openLogin(); },
    autoTick: autoTick,
    internal: {
      state: state,
      ensureBaseDir: ensureBaseDir,
      saveState: saveState,
      loadState: loadState,
    },
    dispose: function () {
      disposed = true;
      state.busy = false;
      if (captureDispose) captureDispose();
    },
  };
  return api;
}
