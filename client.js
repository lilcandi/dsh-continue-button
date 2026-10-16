/**
 * dsh-continue-button —— 浏览器半边（client bundle）。
 *
 * 形态：手写 lazy-CJS bundle，由 @deepseek-ai/dsh-client-modules 经
 * `/plugins/dsh-continue-button/client.js` 送入 Web GUI。执行时只注册工厂，
 * 模块体在首次 require 时物化。
 *
 * 挂载点：`conversation.input.activity`（首选）→ `conversation.input.right`（回退）。
 * 前者渲染在模型选择器之后、发送主键正左侧，是真正的「发送键旁」；后者是
 * "Compact controls before the composer submit action."，但物理上在模型选择器左边。
 * 首选槽是 single（可能被 voice-input 等占用），回退槽是 list（加法式，必成功）。
 *
 * 发送通道：`inputActions.setDraft(text)` + `inputActions.submit()`。
 * `submit()` 内部固定 `mode:"queue"`（追加回合，不打断在飞回合），
 * 因此无论会话正在运行还是已中断都能正确投递。
 */
(() => {
  if (typeof window === 'undefined' || !window.__ModuleLoader__) return;
  try {
    window.__ModuleLoader__.load({
      id: 'dsh-continue-button',
      factory: (require) => {
        var module = { exports: {} };
        var exports = module.exports;
        Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

        var react = require('react');
        var primitives = require('@deepseek-ai/dsh-client-ui-primitives');

        var h = react.createElement;
        var useState = react.useState;
        var useRef = react.useRef;
        var useEffect = react.useEffect;

        var PLUGIN_ID = 'dsh-continue-button';

        /*
         * 挂载点：优先 `conversation.input.activity`，回退 `conversation.input.right`。
         *
         * 两者都在 composer 工具行内，但物理位置不同（InputBar 渲染顺序）：
         *   standardControls[ input.right → 模型选择器 ] → activity → 停止键 → 发送键
         * `input.right` 在模型选择器**左侧**，与发送键隔着约 235px 的模型选择器；
         * `input.activity` 渲染在模型选择器**之后**、发送键正左侧（trailing gap 12px），
         * 才是真正的「发送键旁」。
         *
         * `input.activity` 是 kind:'single' 槽（同 priority 二次注册会 throw），
         * 且语义是「可展开动作」（官方 voice-input 麦克风插件占这里）。因此注册失败
         * 或槽位未声明时，回退到 kind:'list' 的 `input.right`——那里是加法式注册，
         * 永远能成功，只是位置靠左。
         */
        var PRIMARY_SLOT = 'conversation.input.activity';
        var FALLBACK_SLOT = 'conversation.input.right';
        var SLOT = PRIMARY_SLOT;
        var ENTRY_ID = 'continue-button';
        var ENTRY_ORDER = 50;
        var EMPTY_NODES = [];

        /* ------------------------------------------------------------------ *
         * 样式（幂等注入；CSS 变量全部带 fallback，token 缺失时仍可读）
         * ------------------------------------------------------------------ */
        var STYLE_TAG_ID = PLUGIN_ID + '/continue-button.css';
        var CSS_TEXT = [
          '.dshcb-btn{display:grid;place-items:center;flex:none;width:28px;height:28px;padding:0;',
          'border:0;border-radius:999px;background:transparent;',
          'color:var(--dsw-alias-label-secondary,#81858c);cursor:pointer;',
          'transition:background-color .12s ease,color .12s ease}',
          '.dshcb-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.14));',
          'color:var(--dsw-alias-label-primary,#1f2329)}',
          '.dshcb-btn:disabled{opacity:.4;cursor:default}',
          '.dshcb-btn[data-flash="1"]{color:var(--dsw-alias-button-info-fill,#4d6bfe)}',
          '.dshcb-btn svg{width:18px;height:18px;display:block}',
        ].join('');

        function ensureStyle() {
          if (typeof document === 'undefined') return;
          try {
            if (document.querySelector('style[data-plugin-css="' + STYLE_TAG_ID + '"]') !== null) return;
            var tag = document.createElement('style');
            tag.dataset.plugin = PLUGIN_ID;
            tag.dataset.pluginCss = STYLE_TAG_ID;
            tag.textContent = CSS_TEXT;
            document.head.appendChild(tag);
          } catch (_error) {
            /* 样式失败不影响功能，按钮退化为无样式原生 button */
          }
        }

        /* ------------------------------------------------------------------ *
         * 续接文案生成
         * ------------------------------------------------------------------ */

        /** 截断到 n 个字符，超出补省略号。 */
        function clip(text, n) {
          var value = typeof text === 'string' ? text : String(text === undefined ? '' : text);
          if (value.length <= n) return value;
          return value.slice(0, n) + '…';
        }

        /** 取文本块拼接。兼容 AssistantBlock(`kind`) 与 ContentBlock(`type`) 两种形状。 */
        function blocksText(blocks) {
          if (!Array.isArray(blocks)) return '';
          var out = [];
          for (var i = 0; i < blocks.length; i += 1) {
            var block = blocks[i];
            if (!block || typeof block !== 'object') continue;
            var isText = block.kind === 'text' || block.type === 'text';
            if (isText && typeof block.text === 'string' && block.text !== '') out.push(block.text);
          }
          return out.join('\n').trim();
        }

        /** 从 transcript 尾部定位最后一条 user 与最后一条 assistant 节点。 */
        function tailExchange(nodes) {
          var result = { user: null, assistant: null, last: null };
          if (!Array.isArray(nodes) || nodes.length === 0) return result;
          for (var i = nodes.length - 1; i >= 0; i -= 1) {
            var node = nodes[i];
            if (!node || typeof node !== 'object') continue;
            if (result.last === null) result.last = node;
            if (result.assistant === null && node.kind === 'assistant') result.assistant = node;
            else if (result.user === null && node.kind === 'user') result.user = node;
            if (result.user !== null && result.assistant !== null) break;
          }
          return result;
        }

        /** 描述中断状态：优先取真实错误，其次取生命周期标记，最后回落到通用描述。 */
        function describeInterruption(session, input) {
          var queued = input && input.queue && typeof input.queue.length === 'number' ? input.queue.length : 0;
          if (session && typeof session === 'object') {
            if (session.promptError && session.promptError.error) {
              var failure = session.promptError.error;
              var code = failure.code === undefined ? '' : String(failure.code);
              var message = failure.message === undefined ? '' : String(failure.message);
              return '上一次「' + String(session.promptError.op) + '」失败：' + clip(code + ' ' + message, 180);
            }
            if (typeof session.lastAgentError === 'string' && session.lastAgentError !== '') {
              return '上一回合以错误结束：' + clip(session.lastAgentError, 180);
            }
            if (session.awaitingFirstTurn === true) return '提示已提交，但首个回合尚未开始';
            if (session.running === true) return '当前回合仍在运行（本条将排入下一回合队列）';
          }
          if (queued > 0) return '队列中还有 ' + queued + ' 条待执行消息';
          return '上一回合已结束，等待继续';
        }

        /**
         * 生成续接指令。
         * @param mode - `'smart'` 生成带上下文的续接指令；`'plain'` 只发「继续」。
         * @param nodes - transcript 尾部节点数组（ChatSnapshot.legacy.nodes），可为空。
         * @param session - SessionSnapshot，可为 null。
         * @param input - InputState 片段 `{ queue }`，可为 null。
         * @returns 待写入草稿并提交的文本。
         */
        function buildPrompt(mode, nodes, session, input) {
          if (mode === 'plain') return '继续';

          var parts = ['继续。'];
          var reason = describeInterruption(session, input);
          if (reason !== '') parts.push('【中断状态】' + reason);

          var exchange = tailExchange(nodes);
          var contextLines = [];

          if (exchange.user !== null) {
            var userText = blocksText(exchange.user.content);
            if (userText !== '') contextLines.push('【当前任务】' + clip(userText, 240));
          }

          var assistantText = exchange.assistant === null ? '' : blocksText(exchange.assistant.blocks);
          if (assistantText !== '') {
            contextLines.push('【中断前最后输出（结尾片段）】' + assistantText.slice(-520));
          }
          if (exchange.assistant !== null && exchange.assistant.interrupted === true) {
            contextLines.push('（上一回合被中止，末尾内容不完整）');
          }

          var tail = exchange.last;
          if (tail && typeof tail === 'object' && tail.kind === 'turn-error') {
            var tailCode = tail.code === undefined ? '' : String(tail.code);
            var tailMessage = tail.message === undefined ? '' : String(tail.message);
            contextLines.push('【回合终止】' + clip((tailCode + ' ' + tailMessage).trim(), 180));
          }
          if (tail && typeof tail === 'object' && tail.kind === 'turn-max-tokens') {
            contextLines.push('【回合终止】达到单次输出上限，被截断');
          }

          if (contextLines.length > 0) parts.push(contextLines.join('\n'));
          parts.push('请从中断点直接接着往下做：不要重复已完成的内容，不要重新解释背景，直接给出下一步动作。');
          return parts.join('\n\n');
        }

        /** 读取当前会话快照（失败一律返回 null，绝不抛进事件回调）。 */
        function readSession(ctx, sessionId) {
          try {
            if (!ctx || sessionId === undefined || sessionId === null) return null;
            var sessions = ctx.sessions;
            if (!sessions || typeof sessions.binding !== 'function') return null;
            var binding = sessions.binding(sessionId);
            if (!binding || !binding.session || typeof binding.session.getSnapshot !== 'function') return null;
            return binding.session.getSnapshot();
          } catch (_error) {
            return null;
          }
        }

        /* ------------------------------------------------------------------ *
         * 视图
         * ------------------------------------------------------------------ */

        var BUTTON_BASE_STYLE = {
          width: '28px',
          height: '28px',
        };

        /** 无状态依赖的纯视图：接收已解析的 phase/draft/nodes。 */
        function ContinueButtonView(props) {
          ensureStyle();

          var flashPair = useState(false);
          var flash = flashPair[0];
          var setFlash = flashPair[1];
          var timerRef = useRef(null);

          useEffect(function () {
            return function () {
              if (timerRef.current !== null) clearTimeout(timerRef.current);
            };
          }, []);

          var phase = props.__phase;
          var machineBusy = phase === 'adjudicating' || phase === 'submitting' || phase === 'claimed';
          // `locked` 只由 `conversation.input.activity` 的 owner props 提供
          // （InputControlOwnerProps { locked }）；在 input.right 下为 undefined。
          var locked = props.locked === true;
          var busy = machineBusy || locked;
          var running = props.__running === true;
          var draft = typeof props.__draft === 'string' ? props.__draft : '';
          var hasDraft = draft.trim() !== '';

          var label;
          if (locked) label = '当前会话不可发送（未就绪、被阻塞或已移除）';
          else if (machineBusy) label = '输入框正在处理上一动作，稍后再点';
          else if (hasDraft) label = '继续：把续接指令接到当前草稿后一并发送（Alt 点击 = 只发「继续」）';
          else if (running) label = '继续：当前回合运行中，本条会排入下一回合（Alt 点击 = 只发「继续」）';
          else label = '继续：读取中断位置，生成接续指令并自动发送（Alt 点击 = 只发「继续」）';

          function onContinue(event) {
            var plain = event && (event.altKey === true || event.button === 2);
            if (busy) return;
            var actions = props.inputActions;
            if (!actions || typeof actions.setDraft !== 'function' || typeof actions.submit !== 'function') return;

            var session = readSession(props.__ctx, props.sessionId);
            var prompt;
            try {
              prompt = buildPrompt(plain ? 'plain' : 'smart', props.__nodes, session, { queue: props.__queue });
            } catch (error) {
              console.warn('[' + PLUGIN_ID + '] 续接文案生成失败，回退为纯「继续」：', error);
              prompt = '继续';
            }

            var text = hasDraft ? draft.replace(/\s+$/, '') + '\n\n' + prompt : prompt;
            try {
              actions.setDraft(text);
              actions.submit();
            } catch (error) {
              console.warn('[' + PLUGIN_ID + '] 发送失败：', error);
              return;
            }

            setFlash(true);
            if (timerRef.current !== null) clearTimeout(timerRef.current);
            timerRef.current = setTimeout(function () {
              timerRef.current = null;
              setFlash(false);
            }, 900);
          }

          var icon = primitives && primitives.IconPlayOutlineRegular
            ? h(primitives.IconPlayOutlineRegular, null)
            : h('span', { style: { fontSize: '13px', lineHeight: '1' } }, '▶');

          var button = h(
            'button',
            {
              type: 'button',
              className: 'dshcb-btn',
              style: BUTTON_BASE_STYLE,
              disabled: busy,
              'data-flash': flash ? '1' : '0',
              'data-slot': typeof props.__slot === 'string' ? props.__slot : '',
              'aria-label': '继续',
              onClick: onContinue,
              onContextMenu: function (event) {
                event.preventDefault();
                onContinue({ altKey: true });
              },
            },
            icon,
          );

          if (primitives && primitives.Tooltip) {
            // 与 InputBar 主键一致：bubble 走 body portal，避免被 composer 的
            // overflow/stacking context 裁掉；同侧 top 让气泡朝上避开输入框。
            return h(primitives.Tooltip, {
              label: label,
              side: 'top',
              delayMs: 400,
              portal: true,
              disabled: busy,
              maxWidth: 320,
            }, button);
          }
          return button;
        }

        /**
         * 会话状态包装层。
         * `useSession` 由 @deepseek-ai/dsh-client-ui-session 合并进 session 槽位的
         * 标准 props；在标准 shell 里一定存在。这里仍然按可用性分流，
         * 保证在极简/测试宿主上不会因为调用 undefined 而崩。
         */
        function ContinueButtonWithSession(props) {
          var running = props.useSession(function (session) {
            return session ? session.running === true : false;
          });
          var next = Object.assign({}, props, { __running: running });
          if (typeof props.useChat !== 'function') {
            return h(ContinueButtonView, Object.assign({}, next, { __nodes: EMPTY_NODES }));
          }
          return h(ContinueButtonWithChat, next);
        }

        /** 带 Chat transcript 的包装层：`useChat` 只在它存在时挂载，保证 hooks 顺序稳定。 */
        function ContinueButtonWithChat(props) {
          var nodes = props.useChat(function (snapshot) {
            return snapshot && snapshot.legacy ? snapshot.legacy.nodes : EMPTY_NODES;
          });
          return h(ContinueButtonView, Object.assign({}, props, { __nodes: nodes }));
        }

        /** 槽位入口：只调用保证存在的 `useInput`，其余能力按可用性降级。 */
        function ContinueButton(props) {
          var phase = props.useInput(function (state) { return state.phase; });
          var draft = props.useInput(function (state) { return state.draft; });
          var queued = props.useInput(function (state) {
            return state.queue && typeof state.queue.length === 'number' ? state.queue.length : 0;
          });

          var next = Object.assign({}, props, {
            __phase: phase,
            __draft: draft,
            __queue: { queue: new Array(queued) },
            __running: false,
          });

          // 逐层降级：useSession（会话运行态）→ useChat（transcript）→ 纯 useInput。
          if (typeof props.useSession === 'function') return h(ContinueButtonWithSession, next);
          if (typeof props.useChat === 'function') return h(ContinueButtonWithChat, next);
          return h(ContinueButtonView, Object.assign({}, next, { __nodes: EMPTY_NODES }));
        }

        /* ------------------------------------------------------------------ *
         * 插件
         * ------------------------------------------------------------------ */
        var inject = ['slots'];

        /**
         * `inject = ['slots']` 已保证 apply 运行时 slots 服务就绪。
         *
         * 落点策略（两道保险）：
         *   1. 首选 `conversation.input.activity`（发送键正左侧）。它是 single 槽，
         *      若已被别的插件占用（官方 voice-input 麦克风就在这），register 会 throw，
         *      捕获后立即回退。
         *   2. 若本 DSH 版本根本没声明 activity 槽，`slots.inject` 的回调永不触发，
         *      2 秒后由定时器兜底回退到 `conversation.input.right`。
         *
         * `slots.inject(key, cb)` 会等槽位被 conversation 包声明后才执行 cb
         * （注册到未声明的槽位会抛错），返回 disposer。
         */
        var FALLBACK_MS = 2000;

        function apply(ctx) {
          var settled = false;
          var fallbackTimer = null;

          // cordis 的 ctx.effect 负责在 fiber 卸载时回收；极简宿主可能没有。
          if (typeof ctx.effect === 'function') {
            ctx.effect(function () {
              return function () {
                if (fallbackTimer !== null) {
                  clearTimeout(fallbackTimer);
                  fallbackTimer = null;
                }
              };
            }, 'dsh-continue-button: fallback timer');
          }

          function register(slotName) {
            try {
              return ctx.slots.register(
                { name: slotName, id: ENTRY_ID, order: ENTRY_ORDER },
                function (props) {
                  return h(ContinueButton, Object.assign({}, props, { __ctx: ctx, __slot: slotName }));
                },
              );
            } catch (error) {
              console.warn('[' + PLUGIN_ID + '] 注册到 ' + slotName + ' 失败：', error);
              return null;
            }
          }

          function mountFallback() {
            if (settled) return;
            settled = true;
            if (fallbackTimer !== null) {
              clearTimeout(fallbackTimer);
              fallbackTimer = null;
            }
            ctx.slots.inject(FALLBACK_SLOT, function () {
              return register(FALLBACK_SLOT) || function () {};
            });
          }

          ctx.slots.inject(PRIMARY_SLOT, function () {
            if (settled) return function () {};
            var dispose = register(PRIMARY_SLOT);
            if (dispose === null) {
              // single 槽已被占用：让位，改用加法式的 list 槽。
              mountFallback();
              return function () {};
            }
            settled = true;
            if (fallbackTimer !== null) {
              clearTimeout(fallbackTimer);
              fallbackTimer = null;
            }
            return dispose;
          });

          fallbackTimer = setTimeout(mountFallback, FALLBACK_MS);
        }

        exports.name = PLUGIN_ID;
        exports.inject = inject;
        exports.apply = apply;
        exports.__test = {
          SLOT: SLOT,
          PRIMARY_SLOT: PRIMARY_SLOT,
          FALLBACK_SLOT: FALLBACK_SLOT,
          FALLBACK_MS: FALLBACK_MS,
          ENTRY_ID: ENTRY_ID,
          ENTRY_ORDER: ENTRY_ORDER,
          buildPrompt: buildPrompt,
          blocksText: blocksText,
          tailExchange: tailExchange,
          clip: clip,
          describeInterruption: describeInterruption,
        };

        return module.exports;
      },
    });
  } catch (err) {
    console.warn('[dsh-continue-button] client bundle 注册失败：', err);
  }
})();
