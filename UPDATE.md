# UPDATE — network-adaptive transport + DSH 0.2.0-rc.2 sidebar mount

Branch: `local/off-campus-webvpn` (based on upstream `e8df43a`).
This is the **complete working build** for one setup: DSH desktop (profile `desktop`) on
Windows, reaching `madmodel.cs.tsinghua.edu.cn` both **on campus** and **off campus** through
Tsinghua's WebVPN.

Two of the three changes are upstream-relevant and are offered separately as
`fix/dsh-0.2-sidebar-mount` (PR #1) and `fix/webvpn-wrapped-token` (PR #2) so they can be
reviewed on their own. This branch additionally carries the environment-specific transport
work that upstream cannot take.

| # | Change | Files | Upstream offer |
|---|--------|-------|----------------|
| 1 | Mount the sidebar widget on DSH 0.2.0-rc.2 | `lib/ui.js` | PR #1 |
| 2 | Read the token from a WebVPN-wrapped page | `lib/index.js` | PR #2 |
| 3 | Network-adaptive transport: adapter, base seam, autostart, watchdog | `lib/core.js`, `lib/index.js`, `tools/` | local only |

---

## 1. Why the transport has to adapt

The site is reached **differently depending on the network**, and a transport hard-wired to
either one fails on the other:

| Where | Observed | Consequence |
|---|---|---|
| on campus | the site answers directly; without a token that is a plain **401** (a normal answer — it wants a token) | direct works, the gateway is unnecessary |
| off campus | every direct request answers **307** to `oauth.tsinghua.edu.cn/lb-auth/lbredirect` (`TsinghuaLB`) | the plugin cannot validate a captured token, and DSH cannot reach `/v1` at all |
| off campus | the app runs at `webvpn.tsinghua.edu.cn/https/<hex>/…`, so the page origin is the gateway | `hostname === 'madmodel.cs.tsinghua.edu.cn'` discarded every captured token |
| off campus | the gateway namespaces the proxied site's `localStorage` (`user` → `__1_user`) | `getItem('user')` returned `null` |
| off campus | the gateway needs the `wengine_vpn_ticket` **cookie** (a query parameter is rejected) | neither the plugin nor DSH's LLM client can send it |
| **both** | a transport pinned to the gateway breaks **on campus** as soon as the WebVPN ticket dies ("WebVPN 会话已失效" on every call); a transport pinned to the site breaks **off campus** | the choice has to be made at runtime, not by configuration |

Behind the gateway with that cookie (or directly on campus) the site is completely normal:
`GET /model-api/auth-login` → `200 {"success":true}`, `POST /v1/chat/completions` → `200`
(streaming included).

## 2. What each change does

### 2.1 `lib/ui.js` — sidebar mount (identical to PR #1)

DSH 0.2.0-rc.2 fills the `sidebar.settings` seat with the account launcher, whose button
carries `aria-label="账号菜单"`, so the old `button[aria-label="设置"]` lookup never matched
and the widget stayed detached. Now:

* `findFootAnchor()` seeds from the first button labelled `设置`/`账号菜单`/`settings`/
  `account menu` **and** from any `*settingsArea*`/`*footerActions*` container;
* walking up, a `*footArea*` ancestor wins; otherwise the first short
  `flex-direction: column` container (`isColumnFlex()` + `isFootSized()`) is used, and the box
  is inserted as its **first child** — one full-width row above every footer button;
* after 8 attempts it falls back to a floating chip;
* the row never wraps (`min-width: 0`, flex default `nowrap`), so it stays on one line in the
  expanded and in the collapsed/rail sidebar. `data-mmtok-via` records which anchor won.

### 2.2 `lib/index.js` — token capture (identical to PR #2)

* `isTokenSource(url)` accepts `madmodel.cs.tsinghua.edu.cn` **or** a WebVPN-wrapped page
  (`webvpn.tsinghua.edu.cn` + `/https/<hex>…`). Page selection already worked, because
  `score()` ranks any `*.tsinghua.edu.cn` page;
* the CDP expression keeps the plain `getItem('user')` fast path, then scans any `*_user` key
  whose JSON carries a `token`;
* an empty captured token is no longer adopted.

### 2.3 Network-adaptive transport (local only)

**`tools/webvpn-proxy.mjs`** — a dependency-free adapter on `127.0.0.1:8788` that **picks the
transport itself**, so DSH and the plugin keep pointing at one stable address wherever the
machine is:

* **probe** — a bodyless `GET /model-api/auth-login` with `redirect: 'follow'`; the site counts
  as directly usable unless the final URL moved to another host (the campus login) or landed on
  a `/login`/`/lb-auth` path. A 401 counts as usable: the site is right there, it just wants a
  token;
* **cache** — the choice is kept for `MADMODEL_PROBE_TTL_MS` (default 60 s) and re-probed after
  that, so a change of network is noticed even while idle;
* **bounce on a real request** — a 3xx on an actual call switches to the gateway *on the spot*
  (and caches that), so walking between networks heals without restarting anything;
* **lazy gateway** — a WebVPN gateway prefix is resolved only when the gateway is actually
  needed, so being on campus with no Edge login window is no longer a `503`;
* **ticket only on the gateway leg** — the site has no idea what a `wengine_vpn_ticket` is;
* **`via=direct` / `via=gateway` on every log line**, and the chosen transport in `GET /healthz`;
* `GET /v1/models` is synthesised locally whenever that path answers with portal HTML instead of
  a JSON model list (both transports do);
* crash-proofed: an upstream reset mid-stream and a client hang-up are logged
  (`upstream-reset` / `client-aborted`) and the process keeps serving. Before this, a single
  `ECONNRESET` during a streaming answer raised an unhandled `'error'` event on the response
  stream and killed the adapter — after which every model call failed with a connection error
  while the token was still valid;
* each log line names the ticket prefix (`ticket=wrdvpn1-4eb1`) and a rotation is logged
  explicitly, because a rotation can reset a stream still using the previous ticket.

**`lib/core.js`** — `SITE` / `PROVIDER_BASE` follow `MADMODEL_LOCAL_BASE`
(default `http://127.0.0.1:8788`), and `isMadModelUrl()` accepts `127.0.0.1` / `localhost`, so
the plugin validates tokens through the adapter and finds/creates the provider that points at
it. Because the adapter now adapts, **there is no environment variable to flip when the machine
moves between campus and home**. This seam is also the one piece of the transport work that
arguably belongs upstream on its own merit: a documented target override lets anyone put a
gateway, mirror or adapter in front of the site without patching the installed plugin.

**`lib/index.js` autostart + watchdog** — `ensureWebvpnProxy()` runs at host start and every
30 s: it probes `/healthz` and, if nothing answers, spawns the adapter **detached** using the
host's own executable with `ELECTRON_RUN_AS_NODE=1` (falling back to the bundled runtime node).
The adapter therefore survives DSH restarts and a crash heals within ~30 s. It looks for the
adapter at `%DSH_HOME%\madmodel\webvpn-proxy.mjs` first, then `tools/webvpn-proxy.mjs` inside
this package, and logs to `%DSH_HOME%\madmodel\proxy.log`.

## 3. DSH provider configuration

The plugin writes the API key to the credential store as `MADMODEL_API_KEY`. The provider entry
belongs in the profile patch layer (`%USERPROFILE%\.dsh\profiles\desktop\cordis.patch.yml`):

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
        baseURL: http://127.0.0.1:8788/v1   # the adapter; it picks campus/off-campus itself
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
#    (or copy lib/*.js and tools/ into the installed package, as this setup does)
# 2. restart DSH   — Ctrl+R is enough for lib/ui.js, a restart for the Host half
# 3. click Get once (opens the login window: the site on campus, the WebVPN login off
#    campus), then pick "DeepSeek-V4.1-Flash (THU)"
```

Environment variables: `MADMODEL_LOCAL_BASE` (transport target), `MADMODEL_PROXY_PORT`
(adapter port, default 8788), `MADMODEL_DIRECT_BASE` (site used for the direct attempt),
`MADMODEL_FORCE_GATEWAY` (never try direct), `MADMODEL_PROBE_TTL_MS` (re-probe interval),
`WEBVPN_TICKET` (ticket override), `DSH_HOME` (where `madmodel\state.json`, `webvpn.json`,
`proxy.log` live). `webvpn.json` accepts the same `direct` / `forceGateway` keys.

## 5. Verified

Environment: DSH 0.2.0-rc.2 desktop (profile `desktop`), thu-tok-auto 0.3.6, Windows, Edge 154.
Both campus and off campus were exercised against the live site.

Transport selection, with a fake site + fake campus-login host + fake WebVPN gateway driving the
real adapter unmodified (`test-transport-switch.mjs`, **15/15 checks**):

| Case | Result |
|---|---|
| A on campus: the probe gets 401, `/v1` answers | `transport=direct`, served by the site, **gateway never contacted**, `/v1/models` synthesised |
| B off campus: the probe follows a 307 to the campus login | `transport=gateway`, served by the gateway, **ticket sent as a cookie** |
| C off campus, stale WebVPN session | `401` with the re-login hint — not a crash and not a generic error |
| D the network moves under a running adapter (a 600 s cache still says direct) | switches to the gateway **on the spot**, `healthz` follows, `transport direct -> gateway` logged |
| E site unreachable at startup | falls back to the gateway and still serves |

Live, **on campus** (after the fix):

| Check | Result |
|---|---|
| `GET /healthz` | `transport: direct`, `direct: https://madmodel.cs.tsinghua.edu.cn` |
| `GET /model-api/auth-login` (valid token) | `200` in 19 ms `via=direct` — this is the plugin's validation path |
| `GET /model-api/auth-login` (no token) | the **site's own** `401 {"code":"missing_authorization_header"}` — proof it is not the gateway |
| `POST /v1/chat/completions` | `200`, `content: "pong"`, **470 ms**, `via=direct`, model `deepseek-ai/DeepSeek-V4.1-Flash` |
| `POST /v1/chat/completions` (`stream:true`) | `200 text/event-stream`, **12 SSE lines** |
| `POST /v1/chat/completions` (malformed token) | the site's `401 {"code":"invalid_token_malformed"}` |

Live, **off campus** (previous round, through the gateway): the token was captured from the
wrapped page (271-char JWT, `exp − iat` = 6.00 h) and accepted, `/v1/models` 200, completions 200
non-stream and SSE, and a full 22 s DSH turn answered end to end.

Resilience: an upstream mid-stream reset (reproduced against a fake gateway) and a client abort
both leave the adapter alive and logged; `node --check` passes on every changed file.

## 6. Operating notes and limitations

* **Moving between campus and home needs nothing** — no environment variable, no restart. The
  adapter re-probes every 60 s and also switches the moment a real request bounces.
* On campus the transport needs no Edge window and no `Get`; `Get` is still how a *token* is
  obtained from the site, exactly as upstream intends.
* Off campus the WebVPN session must stay alive (its ticket is a session cookie): when it
  expires the adapter answers `401` with a hint and `Get` re-opens the login window. The plugin's
  hourly Auto refresh renews the token (~6 h lifetime) while that session exists.
* A ticket rotation can truncate an **in-flight** streaming answer. The adapter survives it and
  logs the cause (ticket prefix per line, plus an explicit rotation line); resend the message.
  The adapter cannot retry a half-delivered stream — that would have to be a client-side retry.
* Host-half changes (`lib/index.js`, `lib/core.js`, `tools/`) only take effect after a DSH
  restart; `lib/ui.js` is re-served on reload (Ctrl+R).
* Not offered upstream: everything in section 2.3 — it is specific to this network path
  (campus/WebVPN switch, ticket cookie, local adapter) rather than a defect in the plugin. The
  `MADMODEL_LOCAL_BASE` seam is the exception worth considering separately.
