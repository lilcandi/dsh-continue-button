/**
 * dsh-continue-button 自检脚本。
 *
 * 用 node:vm 在受控沙箱里加载 client.js，模拟 `window.__ModuleLoader__` 与
 * `require('react')`，然后验证：
 *   1. bundle 能被解析、工厂能注册、模块能物化；
 *   2. 导出的 name / inject / apply 形态正确；
 *   3. apply 在 mock cordis 上下文里注册到正确的槽位、id、order；
 *   4. 注册的组件是可渲染函数；
 *   5. 续接文案生成器在各种中断场景下的输出符合预期。
 *
 * 运行：node test/load-check.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const HERE = dirname(fileURLToPath(import.meta.url));
const BUNDLE = join(HERE, '..', 'client.js');
const source = readFileSync(BUNDLE, 'utf8');

const failures = [];
let checks = 0;

function check(label, fn) {
  checks += 1;
  try {
    fn();
    console.log(`  ok   ${label}`);
  } catch (error) {
    failures.push({ label, error });
    console.log(`  FAIL ${label}\n       ${error.message}`);
  }
}

/* ------------------------------------------------------------------ *
 * 沙箱：模拟浏览器模块系统
 * ------------------------------------------------------------------ */
const registrations = [];
const moduleLoader = {
  load(registration) {
    registrations.push(registration);
  },
};

const warnings = [];

/**
 * 受控定时器：client.js 用 setTimeout 做「首选槽位从未声明」时的兜底回退，
 * 测试里需要同步触发它，所以不接真实计时器。
 */
const timers = [];
const fakeSetTimeout = (fn, ms) => {
  timers.push({ fn, ms, cancelled: false });
  return timers.length;
};
const fakeClearTimeout = (id) => {
  const entry = timers[id - 1];
  if (entry !== undefined) entry.cancelled = true;
};
/** 触发所有未被取消的定时器（模拟时间流逝）。 */
function runTimers() {
  for (const timer of timers) {
    if (timer.cancelled) continue;
    timer.cancelled = true;
    timer.fn();
  }
}

const sandbox = {
  window: { __ModuleLoader__: moduleLoader },
  console: {
    log: (...args) => console.log('  [client]', ...args),
    warn: (...args) => {
      warnings.push(args.map(String).join(' '));
    },
    error: (...args) => console.error('  [client:error]', ...args),
  },
  setTimeout: fakeSetTimeout,
  clearTimeout: fakeClearTimeout,
  Symbol,
  Object,
  Array,
  Math,
  JSON,
  Date,
  String,
  Number,
  Boolean,
  Error,
  RegExp,
};
sandbox.globalThis = sandbox;

/* 最小 react 替身：本测试不渲染 DOM，只把元素树展开。 */
const reactStub = {
  createElement: (type, props, ...children) => {
    const merged = { ...(props ?? {}) };
    if (children.length === 1) merged.children = children[0];
    else if (children.length > 1) merged.children = children;
    return { __element: true, type, props: merged, children };
  },
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useRef: (initial) => ({ current: initial }),
  useEffect: () => {},
};

const primitivesStub = {
  /** 桩：把 Tooltip 折叠掉，直接返回它的 anchor 子元素（label 透传进 props 供断言）。 */
  Tooltip: (props) => {
    const anchor = props.children;
    if (anchor && typeof anchor === 'object') {
      return { ...anchor, props: { ...anchor.props, __tooltipLabel: props.label } };
    }
    return anchor;
  },
  IconPlayOutlineRegular: (props) => ({ __element: true, type: 'IconPlayOutlineRegular', props, children: [] }),
};

const requireStub = (specifier) => {
  if (specifier === 'react') return reactStub;
  if (specifier === '@deepseek-ai/dsh-client-ui-primitives') return primitivesStub;
  throw new Error(`unexpected require("${specifier}")`);
};

vm.runInNewContext(source, sandbox, { filename: 'client.js' });

/* ------------------------------------------------------------------ *
 * 1. bundle 装载与模块形态
 * ------------------------------------------------------------------ */
console.log('\n[1] bundle 装载');

check('bundle 注册了恰好一个模块', () => {
  assert.equal(registrations.length, 1);
});

const registration = registrations[0];

check('模块 id 为 dsh-continue-button', () => {
  assert.equal(registration.id, 'dsh-continue-button');
});

check('factory 是函数', () => {
  assert.equal(typeof registration.factory, 'function');
});

let exported;
check('factory 可物化且不抛错', () => {
  exported = registration.factory(requireStub);
  assert.equal(typeof exported, 'object');
});

check('导出 name', () => {
  assert.equal(exported.name, 'dsh-continue-button');
});

check('导出 inject 含 slots', () => {
  assert.deepEqual(Array.from(exported.inject), ['slots']);
});

check('导出 apply 是函数', () => {
  assert.equal(typeof exported.apply, 'function');
});

check('无加载期警告', () => {
  assert.deepEqual(warnings, []);
});

/* ------------------------------------------------------------------ *
 * 2. 槽位注册（首选 activity → 回退 input.right）
 * ------------------------------------------------------------------ */
console.log('\n[2] 槽位注册');

const PRIMARY = 'conversation.input.activity';
const FALLBACK = 'conversation.input.right';

/**
 * mock cordis ctx。`declared` 决定哪些槽位「已被 conversation 包声明」——
 * `slots.inject` 只对已声明的槽位同步回调（与真实实现一致：未声明时不回调）。
 * `onRegister` 可抛错来模拟 single 槽被占用。
 */
function makeCtx({ declared, onRegister } = {}) {
  const declaredSlots = declared ?? [PRIMARY];
  const calls = [];
  const entries = [];
  const ctx = {
    calls,
    entries,
    effect(fn) {
      calls.push(['effect']);
      const dispose = fn();
      return typeof dispose === 'function' ? dispose : () => {};
    },
    slots: {
      inject(key, callback) {
        calls.push(['inject', key]);
        if (!declaredSlots.includes(key)) return () => {};
        const dispose = callback();
        return typeof dispose === 'function' ? dispose : () => {};
      },
      register(options, component) {
        calls.push(['register', options.name]);
        if (onRegister !== undefined) onRegister(options, component);
        entries.push({ options, component });
        return () => {};
      },
    },
  };
  return ctx;
}

const ctx = makeCtx();
const registered = ctx.entries;

check('apply 可执行且不抛错', () => {
  exported.apply(ctx);
});

check('注册了恰好一个槽位条目', () => {
  assert.equal(registered.length, 1);
});

check('首选落点是 conversation.input.activity（发送键正左侧）', () => {
  assert.equal(registered[0].options.name, PRIMARY);
  assert.equal(exported.__test.PRIMARY_SLOT, PRIMARY);
  assert.equal(exported.__test.FALLBACK_SLOT, FALLBACK);
});

check('apply 只触碰 slots.inject / slots.register 各一次（首选成功时不试回退）', () => {
  const injects = ctx.calls.filter((c) => c[0] === 'inject');
  const registers = ctx.calls.filter((c) => c[0] === 'register');
  assert.deepEqual(injects, [['inject', PRIMARY]]);
  assert.deepEqual(registers, [['register', PRIMARY]]);
});

check('apply 通过 ctx.effect 注册定时器清理（fiber 卸载可回收）', () => {
  assert.equal(ctx.calls.filter((c) => c[0] === 'effect').length, 1);
});

check('首选槽成功注册后，兜底定时器不再动作', () => {
  runTimers();
  assert.equal(registered.length, 1);
});

check('首选槽被占用（single 冲突抛错）时回退到 conversation.input.right', () => {
  const fallbackCtx = makeCtx({
    declared: [PRIMARY, FALLBACK],
    onRegister(options) {
      if (options.name === PRIMARY) throw new Error('single slot already has a registration');
    },
  });
  exported.apply(fallbackCtx);
  assert.equal(fallbackCtx.entries.length, 1);
  assert.equal(fallbackCtx.entries[0].options.name, FALLBACK);
});

check('首选槽从未被声明时，定时器兜底回退到 input.right', () => {
  const lateCtx = makeCtx({ declared: [FALLBACK] });
  exported.apply(lateCtx);
  assert.equal(lateCtx.entries.length, 0, '槽位未声明时不应提前注册');
  runTimers();
  assert.equal(lateCtx.entries.length, 1);
  assert.equal(lateCtx.entries[0].options.name, FALLBACK);
});

check('回退注册也失败时静默不崩', () => {
  const brokenCtx = makeCtx({
    declared: [FALLBACK],
    onRegister() {
      throw new Error('register failed');
    },
  });
  assert.doesNotThrow(() => {
    exported.apply(brokenCtx);
    runTimers();
  });
});

check('极简宿主（无 ctx.effect）也能挂载', () => {
  const bare = {
    slots: {
      inject(key, callback) {
        if (key !== PRIMARY) return () => {};
        return callback() ?? (() => {});
      },
      register() {
        return () => {};
      },
    },
  };
  assert.doesNotThrow(() => exported.apply(bare));
});

const entry = registered[0];

check('条目 id 唯一且非官方保留 id', () => {
  assert.equal(entry.options.id, 'continue-button');
});

check('order 为正数（不与默认 0 冲突）', () => {
  assert.equal(entry.options.order, 50);
});

check('组件是函数', () => {
  assert.equal(typeof entry.component, 'function');
});

check('组件可被调用并返回元素（mock props）', () => {
  const useInput = (selector) =>
    selector({ phase: 'plain', draft: '', queue: [] });
  const element = entry.component({
    useInput,
    inputActions: { setDraft() {}, submit() {} },
    sessionId: 'session-test',
    __ctx: ctx,
  });
  assert.equal(element.__element, true);
});

check('缺少 inputActions 时组件仍可渲染（降级不崩）', () => {
  const useInput = (selector) => selector({ phase: 'plain', draft: '', queue: [] });
  const element = entry.component({ useInput, sessionId: 'session-test', __ctx: ctx });
  assert.equal(element.__element, true);
});

/* ---- 手动渲染：把函数组件逐层展开，直到拿到宿主 button ---- */
function renderToButton(element, depth = 0) {
  assert.ok(element !== undefined && element !== null, '组件返回了 undefined');
  assert.ok(depth < 12, '组件层级过深，疑似循环');
  if (element.type === 'button') return element;
  assert.equal(typeof element.type, 'function', `期望函数组件或 button，实际 ${String(element.type)}`);
  return renderToButton(element.type(element.props), depth + 1);
}

/** 测试用 transcript 片段。 */
const userNode = { kind: 'user', content: [{ type: 'text', text: '把插件挂到 profile 上' }] };
const assistantNode = {
  kind: 'assistant',
  blocks: [{ kind: 'text', text: '已改完三个文件，接下来准备跑测试。' }],
};

const sessionShim = (running) => (selector) => selector({ running, sessionId: 'session-test' });
const chatShim = (nodes) => (selector) => selector({ legacy: { nodes } });
const inputShim = (over) => (selector) =>
  selector({ phase: 'plain', draft: '', queue: [], ...over });

check('完整 props 下渲染出 button 元素', () => {
  const button = renderToButton(
    entry.component({
      useInput: inputShim({}),
      useSession: sessionShim(false),
      useChat: chatShim([userNode, assistantNode]),
      inputActions: { setDraft() {}, submit() {} },
      sessionId: 'session-test',
      __ctx: ctx,
    }),
  );
  assert.equal(button.props.type, 'button');
  assert.equal(button.props['aria-label'], '继续');
  assert.equal(button.props.disabled, false);
});

check('点击后调用 setDraft(含上下文) 与 submit', () => {
  const calls = [];
  const button = renderToButton(
    entry.component({
      useInput: inputShim({}),
      useSession: sessionShim(false),
      useChat: chatShim([userNode, assistantNode]),
      inputActions: {
        setDraft: (text) => calls.push(['setDraft', text]),
        submit: () => calls.push(['submit']),
      },
      sessionId: 'session-test',
      __ctx: ctx,
    }),
  );
  button.props.onClick({ altKey: false });
  assert.equal(calls.length, 2);
  assert.equal(calls[0][0], 'setDraft');
  assert.equal(calls[1][0], 'submit');
  assert.match(calls[0][1], /^继续。/);
  assert.match(calls[0][1], /【当前任务】把插件挂到 profile 上/);
});

check('右键点击发送裸「继续」', () => {
  const calls = [];
  let prevented = false;
  const button = renderToButton(
    entry.component({
      useInput: inputShim({}),
      useSession: sessionShim(false),
      useChat: chatShim([userNode, assistantNode]),
      inputActions: {
        setDraft: (text) => calls.push(['setDraft', text]),
        submit: () => calls.push(['submit']),
      },
      sessionId: 'session-test',
      __ctx: ctx,
    }),
  );
  button.props.onContextMenu({ preventDefault: () => { prevented = true; } });
  assert.equal(prevented, true);
  assert.deepEqual(calls, [['setDraft', '继续'], ['submit']]);
});

check('草稿非空时把续接指令追加到草稿之后', () => {
  const calls = [];
  const button = renderToButton(
    entry.component({
      useInput: inputShim({ draft: '我自己的草稿' }),
      useSession: sessionShim(false),
      useChat: chatShim([]),
      inputActions: {
        setDraft: (text) => calls.push(text),
        submit: () => {},
      },
      sessionId: 'session-test',
      __ctx: ctx,
    }),
  );
  button.props.onClick({});
  assert.match(calls[0], /^我自己的草稿\n\n继续。/);
});

check('phase 为 submitting 时按钮 disabled 且点击无操作', () => {
  const calls = [];
  const button = renderToButton(
    entry.component({
      useInput: inputShim({ phase: 'submitting' }),
      useSession: sessionShim(false),
      useChat: chatShim([]),
      inputActions: {
        setDraft: () => calls.push('setDraft'),
        submit: () => calls.push('submit'),
      },
      sessionId: 'session-test',
      __ctx: ctx,
    }),
  );
  assert.equal(button.props.disabled, true);
  button.props.onClick({});
  assert.deepEqual(calls, []);
});

check('会话运行中时 tooltip 文案提示会排队', () => {
  const button = renderToButton(entry.component({
    useInput: inputShim({}),
    useSession: sessionShim(true),
    useChat: chatShim([]),
    inputActions: { setDraft() {}, submit() {} },
    sessionId: 'session-test',
    __ctx: ctx,
  }));
  // Tooltip 桩把 label 透传到 button 的 props 上，便于断言
  assert.match(button.props.__tooltipLabel, /当前回合运行中/);
});

check('空闲时 tooltip 文案提示读取中断位置', () => {
  const button = renderToButton(entry.component({
    useInput: inputShim({}),
    useSession: sessionShim(false),
    useChat: chatShim([]),
    inputActions: { setDraft() {}, submit() {} },
    sessionId: 'session-test',
    __ctx: ctx,
  }));
  assert.match(button.props.__tooltipLabel, /读取中断位置/);
});

check('缺少 useSession/useChat 时仍能渲染（极简宿主降级）', () => {
  const button = renderToButton(
    entry.component({
      useInput: inputShim({}),
      inputActions: { setDraft() {}, submit() {} },
      sessionId: 'session-test',
      __ctx: ctx,
    }),
  );
  assert.equal(button.props.type, 'button');
});

check('inputActions 缺方法时点击静默无操作', () => {
  const button = renderToButton(
    entry.component({
      useInput: inputShim({}),
      useSession: sessionShim(false),
      useChat: chatShim([]),
      inputActions: { setDraft() {} },
      sessionId: 'session-test',
      __ctx: ctx,
    }),
  );
  assert.doesNotThrow(() => button.props.onClick({}));
});

/* ------------------------------------------------------------------ *
 * 3. 续接文案生成
 * ------------------------------------------------------------------ */
console.log('\n[3] 续接文案生成');

const { buildPrompt } = exported.__test;

const nodes = [userNode, assistantNode];

check('plain 模式只发「继续」', () => {
  assert.equal(buildPrompt('plain', nodes, null, null), '继续');
});

check('smart 模式在无 transcript 时仍产出结构化指令', () => {
  const text = buildPrompt('smart', [], null, null);
  assert.match(text, /^继续。/);
  assert.match(text, /【中断状态】上一回合已结束，等待继续/);
  assert.match(text, /不要重复已完成的内容/);
});

check('smart 模式带上当前任务与中断前输出', () => {
  const text = buildPrompt('smart', nodes, null, null);
  assert.match(text, /【当前任务】把插件挂到 profile 上/);
  assert.match(text, /【中断前最后输出（结尾片段）】已改完三个文件/);
});

check('promptError 优先作为中断原因', () => {
  const session = { promptError: { op: 'send', error: { code: 'ECONNRESET', message: 'socket hang up' } } };
  const text = buildPrompt('smart', nodes, session, null);
  assert.match(text, /【中断状态】上一次「send」失败：ECONNRESET socket hang up/);
});

check('lastAgentError 作为中断原因', () => {
  const text = buildPrompt('smart', nodes, { lastAgentError: 'context window exceeded' }, null);
  assert.match(text, /【中断状态】上一回合以错误结束：context window exceeded/);
});

check('awaitingFirstTurn 作为中断原因', () => {
  const text = buildPrompt('smart', nodes, { awaitingFirstTurn: true }, null);
  assert.match(text, /【中断状态】提示已提交，但首个回合尚未开始/);
});

check('运行中提示会排入下一回合', () => {
  const text = buildPrompt('smart', nodes, { running: true }, null);
  assert.match(text, /当前回合仍在运行（本条将排入下一回合队列）/);
});

check('turn-error 尾部节点被记录', () => {
  const tail = [...nodes, { kind: 'turn-error', code: 'INTERRUPTED', message: '用户中止' }];
  const text = buildPrompt('smart', tail, null, null);
  assert.match(text, /【回合终止】INTERRUPTED 用户中止/);
});

check('turn-max-tokens 尾部节点被记录', () => {
  const tail = [...nodes, { kind: 'turn-max-tokens' }];
  const text = buildPrompt('smart', tail, null, null);
  assert.match(text, /【回合终止】达到单次输出上限，被截断/);
});

check('被中止的 assistant 会标注内容不完整', () => {
  const interrupted = [{ kind: 'assistant', interrupted: true, blocks: [{ kind: 'text', text: '半截话' }] }];
  const text = buildPrompt('smart', interrupted, null, null);
  assert.match(text, /（上一回合被中止，末尾内容不完整）/);
});

check('队列长度进入中断描述', () => {
  const text = buildPrompt('smart', nodes, null, { queue: [1, 2] });
  assert.match(text, /队列中还有 2 条待执行消息/);
});

check('超长输出被截断为尾部 520 字符', () => {
  const long = 'x'.repeat(2000);
  const text = buildPrompt('smart', [{ kind: 'assistant', blocks: [{ kind: 'text', text: long }] }], null, null);
  const marker = text.split('【中断前最后输出（结尾片段）】')[1].split('\n')[0];
  assert.equal(marker.length, 520);
});

check('ContentBlock(type 形状) 也能被识别', () => {
  const text = buildPrompt('smart', [{ kind: 'user', content: [{ type: 'text', text: '兼容旧形状' }] }], null, null);
  assert.match(text, /【当前任务】兼容旧形状/);
});

/* ------------------------------------------------------------------ *
 * 汇总
 * ------------------------------------------------------------------ */
console.log(`\n结果：${checks - failures.length}/${checks} 通过`);
if (failures.length > 0) {
  console.log('\n失败项：');
  for (const failure of failures) console.log(`  - ${failure.label}: ${failure.error.message}`);
  process.exit(1);
}
console.log('全部通过。');
