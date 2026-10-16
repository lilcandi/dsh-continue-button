# dsh-continue-button

A **"Continue" button** for the DSH Web GUI. It sits beside the composer send key:
one click writes an interruption-aware continuation prompt into the draft and submits it,
so a task that stopped mid-flight picks up where it left off.

- Mount point: `conversation.input.activity` — officially *"Compact action after the model
  selector; it can expand across the toolbar while retaining the editor and submit action."*
  That places it to the **right of the model selector** and **immediately left of the
  send/stop key**; measured gap is 12px. If that slot is taken, the plugin falls back to
  `conversation.input.right` (left of the model selector).
- Shape: pure client-side plugin. No host services, no network requests, no system-prompt
  injection, no disk reads.
- Delivery: hand-written lazy-CJS bundle (`client.js`), zero build dependencies.

---

## 1. What it does

| Situation | What a click does |
| --- | --- |
| Session was interrupted / turn errored | Reads the interruption reason plus tail context, builds a structured continuation prompt, sends it |
| Session is still running | Sends the same prompt; because it goes through `mode:"queue"` it is queued for the next turn and does **not** interrupt the current one |
| Draft already has text | **Appends** the continuation prompt after your text instead of overwriting it |
| Alt-click / right-click | Sends the bare word `继续` with no context at all |

The button flashes for 900ms after a successful send.

### What the generated prompt looks like

Smart mode (default) produces four sections:

```
继续。

【中断状态】上一次「send」失败：ECONNRESET socket hang up

【当前任务】把插件挂到 profile 上
【中断前最后输出（结尾片段）】已改完三个文件，接下来准备跑测试。
（上一回合被中止，末尾内容不完整）
【回合终止】INTERRUPTED 用户中止

请从中断点直接接着往下做：不要重复已完成的内容，不要重新解释背景，直接给出下一步动作。
```

`【中断状态】` takes the first signal that matches, in this order:

1. `session.promptError` — a real send/stop failure (carries code and message)
2. `session.lastAgentError` — the previous turn's error
3. tail `turn-error` / `turn-max-tokens` nodes in the transcript
4. `session.awaitingFirstTurn` — prompt accepted but the first turn has not started
5. `session.running === true` — still running, so this entry will be queued
6. `input.queue.length` — messages still waiting for their turn
7. fallback: `上一回合已结束，等待继续`

All context comes from the **currently loaded transcript** (`ChatSnapshot.legacy.nodes`).
The plugin never reads session logs from disk and never makes extra requests.

---

## 2. Install

```bash
dsh plugin --profile web add dsh-continue-button
```

Or from a local checkout:

```bash
dsh plugin --profile web add file:/path/to/dsh-continue-button
```

Either command does two things: it writes the dependency into the profile's `dependencies`,
and appends the name to the profile's `dsh.profile.bundles` list.

**You must restart `dsh web` afterwards.** The browser-side bundle is discovered by
`@deepseek-ai/dsh-client-modules`, which scans `dsh.client` declarations at host startup
and composes the `__DSH_BOOT__` graph. A running process does not rescan the **profile
roster**, so the first install always needs a restart.

Once the plugin is mounted, further edits to `client.js` do **not** need a restart —
see "Hot reload" below.

### Uninstall

```bash
dsh plugin --profile web remove dsh-continue-button
```

Then remove the `dsh-continue-button` line from `dsh.profile.bundles` by hand and restart.

---

## 3. Layout

```
dsh-continue-button/
├── package.json          # dual-face manifest: exports["."] host half, exports["./client"] browser half
├── index.js              # host half: records the mount, no side effects
├── client.js             # browser half: hand-written lazy-CJS bundle (the actual work)
├── cordis.patch.yml      # bundle patch: inserts the plugin row into the profile roster
├── test/
│   ├── load-check.mjs    # 45 assertions: bundle load / slot registration and fallback / render and click / prompt building
│   └── install-check.mjs # 19 assertions: install surface (profile entry / resolveMeta chain / bundle snapshot)
├── LICENSE
└── README.md (Chinese) · README.en.md (this file)
```

Key constants inside `client.js`:

| Constant | Value | Meaning |
| --- | --- | --- |
| `PRIMARY_SLOT` | `conversation.input.activity` | Preferred mount slot (flush against the send key) |
| `FALLBACK_SLOT` | `conversation.input.right` | Used when the preferred slot is taken or not declared within 2s |
| `FALLBACK_MS` | `2000` | How long to wait for the preferred slot to be declared |
| `ENTRY_ID` | `continue-button` | List cell key (a custom id adds a cell; it never shadows shipped controls) |
| `ENTRY_ORDER` | `50` | Ascending order within the slot |

Fallback strategy: `activity` is a **single** slot (a second registration at the same
priority throws), so registration is wrapped in `try/catch`; on throw or timeout the plugin
switches to `input.right` (**list** slot, additive). Both paths register their timer cleanup
inside `ctx.effect`, so an unloaded fiber leaves no dangling timer. The button carries a
`data-slot` attribute, so a DOM probe can tell which slot it landed in.

---

## 4. Verification

```bash
node test/load-check.mjs
node test/install-check.mjs
```

Neither script needs a DSH runtime. `load-check.mjs` uses `node:vm` to simulate
`window.__ModuleLoader__` and `require`, actually executes `client.js`, and asserts both the
registration behaviour and the generated prompt text. `install-check.mjs` replicates the
`resolveMeta` decision chain of `@deepseek-ai/dsh-client-modules`
(`parseDshClient` / `clientExportOf` / bundle existence / `artifactRevision`) against the
copy **actually installed in the profile**.

Measured results:

```
load-check.mjs    : 45/45 passed
install-check.mjs : 19/19 passed
```

`load-check.mjs` covers more than "it loads": it unwraps the function components down to the
host `<button>` and invokes its `onClick` / `onContextMenu` directly, asserting the text
passed to `setDraft`, the ordering of `submit`, draft appending, busy disabling, and graceful
degradation.

Host-side config composition confirms the plugin row reaches the loader roster:

```bash
dsh --profile web --dump-config | grep continue-button
#   # == dsh-continue-button
#   - id: dsh-continue-button
#     name: dsh-continue-button
```

### Runtime verification (done)

A **second independent instance** was started on port 3099
(`DSH_WEB_ALLOW_MULTI=1`, leaving the user's 3080 untouched) and probed with Playwright:

| Check | Result |
| --- | --- |
| Bundle loaded by the browser | `window.__DSH_BOOT__.entries` contains `dsh-continue-button` |
| Button rendered | `.dshcb-btn` count = 1, `aria-label="继续"` |
| CSS injected | `<style data-plugin-css="dsh-continue-button/continue-button.css">` present |
| Which slot | `data-slot = "conversation.input.activity"` |
| Parent container | `uV2eYG_activity` (the official activity container) |
| Gap to the send key | button x=1051 (w 28) → send key x=1091, **12px gap** |
| End-to-end click | after the click the page title became `继续。 【中断状态】上一回合 — DeepSeek Harness`; the draft was consumed and the continuation prompt entered the transcript |

Measured positions (same row, ascending x):

```
add(429) → access mode(469) → credentials(581) → rewind(733) → model selector(803, w235) → 【continue】(1051, w28) → send(1091, w34)
```

Screenshots: [docs/screenshot-composer.png](docs/screenshot-composer.png) (full composer, button outlined),
[docs/screenshot-button.png](docs/screenshot-button.png) (card close-up).

**The 3080 instance was also checked directly** — no guessing about whether a restart happened:

```bash
# fetch the bundle 3080 actually serves and compare it byte-for-byte with the on-disk copy
curl -g -s -o served.js "http://127.0.0.1:3080/plugins/??dsh-continue-button/client.js&rev=<current rev>"
node -e "const f=require('fs');const a=f.readFileSync('served.js'),b=f.readFileSync('<profile>/node_modules/dsh-continue-button/client.js');console.log('disk file is an exact prefix of served bytes:',a.subarray(0,b.length).equals(b))"
# → true (the extra 76 trailing bytes are the sourceMappingURL comment)
```

Both instances (3080 and 3099) report the identical rev (`e42e71719f95`) over the
`/plugins/events` SSE channel.

### Hot reload (no restart needed for code edits)

DSH ships `@deepseek-ai/dsh-client-hmr`: it **stat-polls every graph row's `client.js`
every 500ms**, and when `mtimeMs / ctimeMs / size` changes it calls
`clientModules.rebuilt(id)` to recompute the rev, then pushes
`{type:'rebuilt', id, rev}` to the browser over `/plugins/events` (SSE). The browser half
receives it and runs `entries.reload(id, rev)`, refetching and swapping that plugin.

So the loop is:

1. edit `client.js`;
2. sync it to the copy the host actually serves:
   `cp client.js <profile>/node_modules/dsh-continue-button/`;
3. wait about a second (500ms poll plus one SSE round trip) — the browser swaps in the new
   version on its own. **No restart, no page refresh.**

The rev is derived from `mtime / ctime / size` only, never from content, so a write that
changes content without changing any of the three goes unnoticed (a normal editor save
cannot do that). To see the rev currently being served:

```bash
curl -g -s http://127.0.0.1:3080/plugins/events | grep dsh-continue-button
```

### Known limits

- The **first install** needs a restart: the profile roster (`dsh.profile.bundles`) is
  scanned once at startup, and HMR only watches byte changes of rows **already in the
  graph** — it will not discover a new plugin.
- `client.js` edits must be synced to the installed copy under
  `<profile>/node_modules/dsh-continue-button/`; that is the file the host serves.
- The plugin only targets the Web GUI (`platform: "web"`). It does nothing in the TUI.

---

## 5. Troubleshooting

**Button does not appear** — check in order:

1. Did you restart `dsh web` **for the first install**? (No restart means the roster lacks it,
   so it definitely will not appear. After that, `client.js` edits need no restart — HMR swaps them.)
2. Does `dsh --profile web --dump-config | grep continue-button` print anything?
   Nothing → the profile entry did not take; re-run the install command.
3. Does the browser console show `[dsh-continue-button] client bundle 注册失败：…`?
   Yes → `client.js` threw during registration; read the error.
4. Does it show `client-modules: client bundle not found`?
   Yes → the file `exports["./client"]` points at is missing; check
   `node_modules/dsh-continue-button/client.js`.
5. Does `window.__DSH_BOOT__.entries` contain a `dsh-continue-button` row?

**Clicking does nothing** — the console prints `[dsh-continue-button] 发送失败：…`.
When `inputActions` is missing (the composer for that session is not mounted) the button is
silently inert; that is the intended degradation.

**Want the bare word only** — Alt-click or right-click.

---

## 6. Design notes

- **Why `setDraft` + `submit` instead of `ctx.conversation.send()`**: `inputActions.submit()`
  runs the full composer submission transaction (optimistic echo, draft restore on failure,
  attachment handling, analytics) — exactly the same path as pressing the send key by hand.
  `conversation.send()` bypasses the composer; on failure it does not hand the draft back.
- **Why `mode` is `queue`**: `inputActions.submit()` hardcodes `this.submit("queue")`. That is
  established DSH behaviour and the plugin neither can nor should change it. The side effect
  happens to match the requirement — append a turn when interrupted, queue without
  interrupting while running.
- **Why not read session logs from disk**: a client-side plugin cannot and should not reach
  host files; the transcript tail is enough to locate the interruption point and adds no IO
  failure surface.
- **Why a hand-written bundle**: for a pure client-side plugin the only benefit of a bundler
  is type checking, and the `@deepseek-ai/dsh-client-ui-slots` typings are only available from
  a vendored copy on this machine. The hand-written form is already proven in this
  environment (`dsh-infinite-gen-5`) and needs zero build dependencies — and with DSH's
  built-in `dsh-client-hmr`, syncing the installed copy hot-swaps it in about a second,
  with no restart at all.
- **Why `activity` rather than `input.right`**: `input.right` is a list slot and the safest
  additive choice, but it renders inside `standardControls`, **left of the model selector** —
  a 235px-wide model selector sits between it and the send key. `activity` renders to the
  **right** of the model selector, immediately left of the stop/send keys (a 12px `trailing`
  gap), which is what "beside the send key" actually means. The cost is that `activity` is a
  `single` slot — a second registration at the same priority throws — so registration is
  wrapped in try/catch and falls back to `input.right` after 2 seconds if the slot is occupied
  or undeclared. Both paths work; the button's `data-slot` attribute states where it landed.

---

## License

MIT © lilcandi
