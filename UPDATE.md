# UPDATE — off-campus (WebVPN) build + DSH 0.2.0-rc.2 sidebar mount

Branch: `local/off-campus-webvpn` (based on upstream `e8df43a`).
This is the **complete working build** for one specific setup: DSH desktop (profile
`desktop`) on Windows, **off campus**, reaching the site through Tsinghua's WebVPN.

Two of the three changes are upstream-relevant and are offered separately as
`fix/dsh-0.2-sidebar-mount` (PR #1) and `fix/webvpn-wrapped-token` (PR #2) so they can be
reviewed on their own. This branch additionally carries the environment-specific
transport work that upstream cannot take.

| # | Change | Files | Upstream offer |
|---|--------|-------|----------------|
| 1 | Mount the sidebar widget on DSH 0.2.0-rc.2 | `lib/ui.js` | PR #1 |
| 2 | Read the token from a WebVPN-wrapped page | `lib/index.js` | PR #2 |
| 3 | Off-campus transport: adapter, base seam, autostart, watchdog | `lib/core.js`, `lib/index.js`, `tools/` | local only |

---

## 1. Why off campus needs all three

| Observed | Consequence |
|---|---|
| Every direct request to `madmodel.cs.tsinghua.edu.cn` answers **307** to `oauth.tsinghua.edu.cn/lb-auth/lbredirect` (`TsinghuaLB`) | the plugin cannot validate a captured token, and DSH cannot reach `/v1` at all |
| The app runs at `webvpn.tsinghua.edu.cn/https/<hex>/…`, so the page origin is the gateway | the capture path's `hostname === 'madmodel.cs.tsinghua.edu.cn'` check threw the token away |
| The gateway namespaces the proxied site's `localStorage` (`user` → `__1_user`) | `getItem('user')` returned `null` |
| The gateway needs the `wengine_vpn_ticket` **cookie** (a query parameter does not work) | neither DSH's LLM client nor the plugin can send it |

Through the gateway with that cookie the site behaves normally: `GET /model-api/auth-login`
→ `200 {"success":true}`, `POST /v1/chat/completions` → `200` (including SSE streaming).

## 2. What each change does

### 2.1 `lib/ui.js` — sidebar mount (identical to PR #1)

DSH 0.2.0-rc.2 fills the `sidebar.settings` seat with the account launcher, whose button
is `aria-label="账号菜单"`, so the old `button[aria-label="设置"]` lookup never matched and
the widget stayed detached. Now:

* `findFootAnchor()` seeds from the first button labelled `设置`/`账号菜单`/`settings`/
  `account menu` **and** from any `*settingsArea*`/`*footerActions*` container;
* walking up, a `*footArea*` ancestor wins; otherwise the first short
  `flex-direction: column` container (`isColumnFlex()` + `isFootSized()`) is used, and the
  box is inserted as its **first child** — one full-width row above every footer button;
* after 8 attempts it falls back to a floating chip;
* the row never wraps (`min-width: 0`, flex default `nowrap`), so it stays on one line in
  the expanded and the collapsed/rail sidebar. `data-mmtok-via` records which anchor won.

### 2.2 `lib/index.js` — token capture (identical to PR #2)

* `isTokenSource(url)` accepts `madmodel.cs.tsinghua.edu.cn` **or** a WebVPN-wrapped page
  (`webvpn.tsinghua.edu.cn` + `/https/<hex>…`). Page selection already worked, because
  `score()` ranks any `*.tsinghua.edu.cn` page;
* the CDP expression keeps the plain `getItem('user')` fast path, then scans any `*_user`
  key whose JSON carries a `token`;
* an empty captured token is no longer adopted.

### 2.3 Off-campus transport (local only)

**`tools/webvpn-proxy.mjs`** — a dependency-free adapter on `127.0.0.1:8788`:

* reads `wengine_vpn_ticket` from `state.json` on every request (so re-logins are picked
  up automatically), injects it as a `Cookie`;
* streams responses verbatim, including SSE, and strips a duplicated `/https/<hex>` prefix
  that the site's own HTML emits;
* synthesises `GET /v1/models` locally (the gateway answers that path with its own portal
  HTML instead of JSON);
* answers `401` with a "click Get" hint when the gateway session is gone, `503` when the
  gateway prefix is unknown;
* **crash-proofed**: an upstream reset mid-stream and a client hang-up are logged
  (`upstream-reset` / `client-aborted`) and the process keeps serving. Before this, a single
  `ECONNRESET` during a streaming answer raised an unhandled `'error'` event on the response
  stream and killed the adapter — after which every model call failed with a connection
  error while the token was still valid;
* each log line names the ticket prefix (`ticket=wrdvpn1-4eb1`), and a rotation is logged
  explicitly, because a rotation can reset a stream that is still using the previous ticket.

**`lib/core.js`** — `SITE` / `PROVIDER_BASE` follow `MADMODEL_LOCAL_BASE`
(default `http://127.0.0.1:8788`), and `isMadModelUrl()` accepts `127.0.0.1` / `localhost`,
so the plugin validates against the adapter and finds/creates the provider that points at it.
On campus, set `MADMODEL_LOCAL_BASE=https://madmodel.cs.tsinghua.edu.cn` (or unset the
adapter) to go direct again.

**`lib/index.js` autostart + watchdog** — `ensureWebvpnProxy()` runs at host start and every
30 s: it probes `/healthz` and, if nothing answers, spawns the adapter **detached** using the
host's own executable with `ELECTRON_RUN_AS_NODE=1` (verified working on the Electron host),
falling back to the bundled runtime node. The adapter therefore survives DSH restarts, and a
crash heals within ~30 s. It looks for the adapter at
`%DSH_HOME%\madmodel\webvpn-proxy.mjs` first, then `tools/webvpn-proxy.mjs` inside this
package. Logs to `%DSH_HOME%\madmodel\proxy.log`.

## 3. DSH provider configuration

The plugin writes the API key to the credential store as `MADMODEL_API_KEY`. The provider
entry belongs in the profile patch layer
(`%USERPROFILE%\.dsh\profiles\desktop\cordis.patch.yml`):

```yaml
- id: llm-pi-ai
  name: "@deepseek-ai/dsh-llm-pi-ai"
  config:
    providers:
      madmodel:
        apiKeyEnv: MADMODEL_API_KEY
        api: openai-completions
        displayName: DeepSeek (THU)
        reasoning: medium
        baseURL: http://127.0.0.1:8788/v1   # off campus: the local adapter; on campus: the site
        models:
          - id: DeepSeek-V4.1-Flash
            name: DeepSeek-V4.1-Flash (THU)
            contextWindow: 1000000
            input: [text]
            reasoningEfforts: { low: low, high: high, max: max }
          - id: qwen3.8-27b
            name: qwen3.8-27b (THU)
            contextWindow: 1000000
            input: [text, image]
            reasoningEfforts: { low: low, medium: medium, xhigh: xhigh }
```

Model ids and capabilities come from the site's own bundle (`modelList`), not from guesswork:
`DeepSeek-V4.1-Flash` is **text-only** (`supportImage:false`), `qwen3.8-27b` accepts images.

## 4. Install

```powershell
# 1. install this fork's build into the desktop profile
dsh plugin --profile desktop add <path-to-this-checkout>
#    (or copy lib/*.js into the installed package as this setup does)
# 2. restart DSH   — only Ctrl+R is needed for lib/ui.js, a restart for the Host half
# 3. click Get in the sidebar widget once (opens the WebVPN login window, reuses the
#    session afterwards), then pick "DeepSeek-V4.1-Flash (THU)"
```

Environment variables: `MADMODEL_LOCAL_BASE` (transport target),
`MADMODEL_PROXY_PORT` (adapter port, default 8788), `WEBVPN_TICKET` (ticket override),
`DSH_HOME` (where `madmodel\state.json`, `webvpn.json`, `proxy.log` live).

## 5. Verified

Environment: DSH 0.2.0-rc.2 desktop (profile `desktop`), thu-tok-auto 0.3.6, Windows, off
campus, Edge 154 through the WebVPN gateway.

| Check | Result |
|---|---|
| `GET /model-api/auth-login` (Bearer token) | `200 {"data":true,"status":0,"message":"success","success":true}` |
| `GET /v1/models` | `200` list (2 models, synthesised locally) |
| `POST /v1/chat/completions` | `200`, `content: "pong"` (plus a `reasoning` field) |
| `POST /v1/chat/completions` (`stream:true`) | `200 text/event-stream`, SSE deltas |
| Token actually captured from the wrapped page | 271-char JWT, `exp − iat` = 6.00 h, `serverValid: true` |
| Upstream reset mid-stream (reproduced with a fake gateway) | client stream truncated, **adapter survives**, logged `upstream-reset` |
| Client abort mid-stream | **adapter survives**, logged `client-aborted` |
| End-to-end in DSH | a full turn (22 s) answered through the adapter, `POST /v1/chat/completions -> 200 text/event-stream` |
| `node --check` on all changed files | passes |

## 6. Operating notes and limitations

* The adapter is only needed **off campus**. On campus point `MADMODEL_LOCAL_BASE` at the
  real host and nothing else changes.
* The WebVPN session must stay alive: its ticket is a session cookie. When it expires the
  adapter answers `401` with a hint and the widget shows 需要登录 — click **Get** to
  re-authenticate. The plugin's hourly Auto refresh renews the token (~6 h lifetime) as long
  as that session exists.
* A ticket rotation can truncate an **in-flight** streaming answer. The adapter now survives
  it and logs the cause (ticket prefix per line, plus an explicit rotation line); resend the
  message. The adapter cannot retry a half-delivered stream — that has to be a client-side retry.
* Host-half changes (`lib/index.js`, `lib/core.js`) only take effect after a DSH restart;
  `lib/ui.js` is re-served on reload (Ctrl+R).
* Not offered upstream: everything in section 2.3 — it is specific to this network path
  (WebVPN gateway, ticket cookie, local adapter) rather than a defect in the plugin.
