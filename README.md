# dsh-continue-button

DSH Web GUI 的**「继续」按钮**插件：在对话框发送键旁边加一个圆形按钮，
点一下就把「续接指令」写进草稿并自动发送，让被中断的任务接着往下做。

- 挂载点：`conversation.input.activity`（DSH 官方定义为 *"Compact action after the model selector; it can expand across the toolbar while retaining the editor and submit action."*），
  位于模型选择器**右侧**、发送/停止主键**正左侧**，实测间距 12px。
  该槽被占用时自动回退到 `conversation.input.right`（模型选择器左侧）。
- 形态：纯客户端插件，无宿主服务依赖、无网络请求、无系统提示词注入。
- 交付形态：手写 lazy-CJS bundle（`client.js`），零构建依赖。

---

## 一、它做了什么

| 场景 | 点击行为 |
| --- | --- |
| 会话已中断 / 回合出错 | 读取中断原因 + 尾部上下文，生成结构化续接指令，自动发送 |
| 会话仍在运行 | 同样发送；因为走 `mode:"queue"`，该条会排入下一回合队列，不打断当前回合 |
| 草稿里已有文字 | 把续接指令**追加**到现有草稿之后一起发送（不覆盖你写的东西） |
| 按住 Alt 点击 / 右键点击 | 只发送裸的 `继续` 两个字，不带任何上下文 |

发送后按钮会闪一下（900ms）作为反馈。

### 生成的续接指令长什么样

smart 模式（默认）产出四段：

```
继续。

【中断状态】上一次「send」失败：ECONNRESET socket hang up

【当前任务】把插件挂到 profile 上
【中断前最后输出（结尾片段）】已改完三个文件，接下来准备跑测试。
（上一回合被中止，末尾内容不完整）
【回合终止】INTERRUPTED 用户中止

请从中断点直接接着往下做：不要重复已完成的内容，不要重新解释背景，直接给出下一步动作。
```

`【中断状态】` 按以下优先级取第一个命中的信号：

1. `session.promptError` —— 真实的发送/停止失败（带 code 与 message）
2. `session.lastAgentError` —— 上一回合的错误
3. transcript 尾部 `turn-error` / `turn-max-tokens` 节点
4. `session.awaitingFirstTurn` —— 提示已提交但首回合尚未开始
5. `session.running === true` —— 仍在运行，本条会排队
6. `input.queue.length` —— 队列里还有待执行消息
7. 兜底：`上一回合已结束，等待继续`

上下文段落全部来自**当前会话的已加载 transcript**（`ChatSnapshot.legacy.nodes`），
不读取磁盘上的会话日志，也不做额外请求。

---

## 二、安装

插件已经在 `C:\Users\candi\.dsh\profiles\web` 里装好了。若要在别的 profile 或机器上重装：

```powershell
dsh plugin --profile web add file:J:/plugin/dsh-continue-button
```

这条命令会做两件事：

1. 把 `"dsh-continue-button": "file:J:/plugin/dsh-continue-button"` 写进 profile 的 `dependencies`；
2. 把 `"dsh-continue-button"` 追加到 profile 的 `dsh.profile.bundles` 列表。

装完后**必须重启 `dsh web`**：浏览器半边的 bundle 由宿主启动时的
`@deepseek-ai/dsh-client-modules` 扫描 `dsh.client` 声明并合成 `__DSH_BOOT__` 图，
运行中的进程不会重新扫描。

### 卸载

```powershell
dsh plugin --profile web remove dsh-continue-button
```

然后手工把 `dsh.profile.bundles` 里的 `"dsh-continue-button"` 一行删掉，再重启。

---

## 三、目录结构

```
dsh-continue-button/
├── package.json          # 双面包清单：exports["."] 宿主半边，exports["./client"] 浏览器半边
├── index.js              # 宿主半边：仅记录装载，无副作用
├── client.js             # 浏览器半边：手写 lazy-CJS bundle（真正干活的部分）
├── cordis.patch.yml      # bundle patch：把插件行插进 profile 名册
├── test/
│   ├── load-check.mjs    # 45 项：bundle 装载 / 槽位注册与回退 / 组件渲染与点击 / 续接文案生成
│   └── install-check.mjs # 19 项：安装面（profile 登记 / resolveMeta 判定链 / bundle 快照）
└── README.md
```

`client.js` 里的关键常量：

| 常量 | 值 | 说明 |
| --- | --- | --- |
| `PRIMARY_SLOT` | `conversation.input.activity` | 首选挂载槽位（紧贴发送键） |
| `FALLBACK_SLOT` | `conversation.input.right` | 首选被占用或 2s 内未声明时的回退槽位 |
| `FALLBACK_MS` | `2000` | 等待首选槽声明的超时 |
| `ENTRY_ID` | `continue-button` | 列表条目的 cell key（自定义 id = 加法式新增，不遮蔽官方控件） |
| `ENTRY_ORDER` | `50` | 在槽位内升序排列 |

落点策略：`activity` 是 **single** 槽（同 priority 二次注册会 throw），所以注册包在 `try/catch` 里；
抛错或超时即切到 `input.right`（**list** 槽，加法式，不会与 dsh-purge 的同名槽冲突）。
两条路径都在 `ctx.effect` 里登记了定时器清理，fiber 卸载时不会留下悬挂 timer。
按钮元素带 `data-slot` 属性，DOM 探针可直接看出它落在哪个槽。

---

## 四、验证

```powershell
node J:\plugin\dsh-continue-button\test\load-check.mjs
node J:\plugin\dsh-continue-button\test\install-check.mjs
```

两份脚本都不依赖 DSH 运行时：`load-check.mjs` 用 `node:vm` 在沙箱里模拟
`window.__ModuleLoader__` 与 `require`，把 `client.js` 真正跑一遍并断言注册行为与文案输出；
`install-check.mjs` 复刻 `@deepseek-ai/dsh-client-modules` 的 `resolveMeta` 判定链
（`parseDshClient` / `clientExportOf` / bundle 存在性 / `artifactRevision`），
对**已安装到 profile 的那份副本**逐条核对。

已验证的事实（实测输出）：

```
load-check.mjs    : 45/45 通过
install-check.mjs : 19/19 通过
```

`load-check.mjs` 覆盖的不只是「能加载」，还包括**点击行为的真实断言**：
把函数组件逐层展开到宿主 `<button>`，然后直接调用它的 `onClick` / `onContextMenu`，
断言 `setDraft` 收到的文本内容与 `submit` 的调用次序（含草稿追加、busy 禁用、降级不崩）。

宿主侧配置合成也已确认插件行进入 loader 名册：

```powershell
node C:\Users\candi\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh\lib\bin.js --profile web --dump-config
# 输出尾部包含：
#   # == dsh-continue-button
#   - id: dsh-continue-button
#     name: dsh-continue-button
```

### 运行时验证（已完成）

在 3099 端口起了**第二个独立实例**（`DSH_WEB_ALLOW_MULTI=1`，不碰用户正在用的 3080），
用 Playwright 打开并实测：

| 验证项 | 实测结果 |
| --- | --- |
| bundle 是否被浏览器加载 | `window.__DSH_BOOT__.entries` 含 `dsh-continue-button` |
| 按钮是否渲染 | `.dshcb-btn` 数量 = 1，`aria-label="继续"` |
| CSS 是否注入 | `<style data-plugin-css="dsh-continue-button/continue-button.css">` 在页内 |
| 落在哪个槽 | `data-slot = "conversation.input.activity"` |
| 祖父容器 | `uV2eYG_activity`（activity 槽的官方容器） |
| 与发送键的间距 | 按钮 x=1051（宽 28）→ 发送键 x=1091，**间距 12px** |
| 端到端点击 | 点击后续接指令作为真实用户消息进入 transcript，agent 随即开始执行 |

实测位置序列（同一行，x 升序）：

```
添加(429) → 访问模式(469) → 凭据(581) → 回退(733) → 模型选择器(803,宽235) → 【继续】(1051,宽28) → 发送(1091,宽34)
```

截图存证：`J:\plugin\.playwright-cli\page-2026-10-16T17-17-26-207Z.png`（按钮加 3px 红框标记）。

### 仍受限制的部分

- 用户当前运行的 3080 实例里**没有**这个 bundle（它启动早于插件安装）。需重启 `dsh web` 才会出现。
- `client.js` 的改动必须同步到 `profiles/web/node_modules/dsh-continue-button/` 才会被加载
  （本次已同步，SHA256 一致）。若直接改源文件而忘了同步，宿主读到的仍是旧副本。

---

## 五、排查

**按钮没出现**，按顺序查：

1. 重启过 `dsh web` 了吗？（未重启 = 一定不出现）
2. `dsh --profile web --dump-config | Select-String continue-button` 有没有输出？
   没有 → profile 登记没生效，重跑安装命令。
3. 浏览器控制台有没有 `[dsh-continue-button] client bundle 注册失败：…`？
   有 → `client.js` 在注册期抛错，看具体报错。
4. 有没有 `client-modules: client bundle not found`？
   有 → `exports["./client"]` 指向的文件不在，检查 `node_modules/dsh-continue-button/client.js` 是否存在。
5. 控制台里 `window.__DSH_BOOT__.entries` 有没有 `dsh-continue-button` 这一行？

**点了没反应**：控制台会打印 `[dsh-continue-button] 发送失败：…`。
`inputActions` 缺失（说明该会话的 composer 未挂载）时按钮静默无操作，属预期降级。

**想改成只发纯「继续」**：按住 Alt 点击，或右键点击。

---

## 六、设计取舍

- **为什么用 `setDraft` + `submit`，而不是 `ctx.conversation.send()`**：
  `inputActions.submit()` 走完整的 composer 提交事务（乐观回显、失败恢复草稿、附件处理、分析埋点），
  与用户手按发送键完全同一条路径；`conversation.send()` 是绕过 composer 的服务直发，
  失败时不会把草稿还给用户。前者体验更一致。
- **为什么 `mode` 是 `queue`**：`inputActions.submit()` 内部固定 `this.submit("queue")`，
  这是 DSH 的既定行为，插件无法也不应改写它。副作用正好符合需求 —— 中断时追加回合、运行中排队不打断。
- **为什么不读磁盘会话日志**：客户端插件拿不到也不该拿宿主文件；transcript 尾部信息已经足够定位中断点，
  且不会引入 IO 失败面。
- **为什么手写 bundle**：纯客户端插件用 tsdown 打包的唯一收益是类型检查，而
  `@deepseek-ai/dsh-client-ui-slots` 等类型包在本机只能靠 vendored 副本提供；
  手写形态与 `dsh-infinite-gen-5` 已在同机验证可行，且零构建依赖、改完即生效（重启后）。
