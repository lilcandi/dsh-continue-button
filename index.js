/**
 * dsh-continue-button —— 宿主半边（node）。
 *
 * 本插件是「双面」DSH 插件：浏览器半边（./client.js，见 package.json 的
 * dsh.client 声明）负责在对话框发送键旁渲染「继续」按钮；宿主半边只做两件事：
 *   1. 提供一个可被 loader 按包名加载的真实 ESM 入口（exports["."]）；
 *   2. 在宿主日志里留一条装载记录，便于排查「按钮没出现」这类问题。
 *
 * 续接文案的生成完全在浏览器侧完成（读会话快照 + transcript 尾部），
 * 因此这里不注入任何服务，也不注册路由。
 */

export const name = 'dsh-continue-button';

/** 不依赖任何宿主服务：纯客户端插件。 */
export const inject = [];

/**
 * 插件入口。宿主侧无副作用，仅记录装载。
 * @param {import('@deepseek-ai/cordis').Context} ctx - 宿主 Cordis 上下文。
 */
export function apply(ctx) {
  const logger = ctx && ctx.logger;
  if (logger && typeof logger.debug === 'function') {
    logger.debug('[dsh-continue-button] 宿主半边已装载；浏览器半边由 dsh.client 声明提供。');
  }
}

export default { name, inject, apply };
