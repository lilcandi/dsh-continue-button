/**
 * dsh-continue-button 安装面自检。
 *
 * 复刻 @deepseek-ai/dsh-client-modules 宿主半边 `ClientModuleRegistry.resolveMeta`
 * + `initialBundleSnapshot` 的判定逻辑，对「已安装到 profile 的那一份副本」
 * 逐条验证：只有全部通过，插件才会被扫描进 __DSH_BOOT__ 图并让浏览器半边加载。
 *
 * 运行：node test/install-check.mjs
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import assert from 'node:assert/strict';

const PROFILE = 'C:\\Users\\candi\\.dsh\\profiles\\web';
const PKG_NAME = 'dsh-continue-button';

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

/* ---- 复刻 client-modules 的校验函数（逐字同语义） ---- */
function optionalStringArray(subject, field, value) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error(`client-modules: ${subject} ${field} must be a string array`);
  }
  return value;
}

function parseDshClient(pkgName, value) {
  if (value === undefined) return undefined;
  if (typeof value !== 'object' || value === null) {
    throw new Error(`client-modules: ${pkgName} has a non-object dsh.client declaration`);
  }
  if (typeof value.platform !== 'string') {
    throw new Error(`client-modules: ${pkgName} dsh.client.platform must be a string`);
  }
  const inject = optionalStringArray(pkgName, 'dsh.client.inject', value.inject);
  const external = optionalStringArray(pkgName, 'dsh.client.external', value.external);
  if (value.immediately !== undefined && typeof value.immediately !== 'boolean') {
    throw new Error(`client-modules: ${pkgName} dsh.client.immediately must be a boolean`);
  }
  return {
    platform: value.platform,
    ...(inject !== undefined ? { inject } : {}),
    ...(external !== undefined ? { external } : {}),
    ...(value.immediately !== undefined ? { immediately: value.immediately } : {}),
  };
}

function clientExportOf(pkgName, exportsField) {
  if (typeof exportsField !== 'object' || exportsField === null) return undefined;
  const client = exportsField['./client'];
  if (client === undefined) return undefined;
  if (typeof client === 'string') return client;
  if (typeof client === 'object' && client !== null) {
    if (typeof client.default === 'string') return client.default;
  }
  throw new Error(`client-modules: ${pkgName} exports["./client"] must be a string or an object with a string default`);
}

function artifactRevision(baseline) {
  const hash = createHash('sha1').update('plugin-artifact').update('\0');
  for (const part of [String(baseline.mtimeMs), String(baseline.ctimeMs), String(baseline.size)]) {
    hash.update(`${Buffer.byteLength(part)}:`).update(part);
  }
  return hash.digest('hex').slice(0, 12);
}

/* ---- 1. profile 登记 ---- */
console.log('\n[1] profile 登记');

const profilePkgPath = join(PROFILE, 'package.json');
const profilePkg = JSON.parse(readFileSync(profilePkgPath, 'utf8'));

check('profile dependencies 含 file: 依赖', () => {
  const spec = profilePkg.dependencies[PKG_NAME];
  assert.ok(spec !== undefined, `${PKG_NAME} 不在 dependencies`);
  assert.match(spec, /^file:/);
});

check('profile dsh.profile.bundles 含插件名', () => {
  assert.ok(profilePkg.dsh.profile.bundles.includes(PKG_NAME), `${PKG_NAME} 不在 bundles`);
});

check('bundles 内无重复项', () => {
  const seen = new Set();
  for (const name of profilePkg.dsh.profile.bundles) {
    assert.ok(!seen.has(name), `重复的 bundle：${name}`);
    seen.add(name);
  }
});

/* ---- 2. 安装副本位置 ---- */
console.log('\n[2] 安装副本');

const pkgPath = join(PROFILE, 'node_modules', PKG_NAME, 'package.json');

check('已解析到 profile 内的 package.json', () => {
  assert.ok(existsSync(pkgPath), `缺少 ${pkgPath}`);
});

const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));

check('包名与 loader 行名一致', () => {
  assert.equal(pkg.name, PKG_NAME);
});

check('导出宿主入口 exports["."]', () => {
  assert.equal(pkg.exports['.'], './index.js');
});

/* ---- 3. resolveMeta 判定链 ---- */
console.log('\n[3] resolveMeta 判定链');

let decl;
check('parseDshClient 接受该声明且不抛错', () => {
  decl = parseDshClient(pkg.name, pkg.dsh ? pkg.dsh.client : undefined);
  assert.ok(decl !== undefined, 'dsh.client 缺失');
});

check('dsh.client.platform === "web"（否则被当作非客户端包跳过）', () => {
  assert.equal(decl.platform, 'web');
});

check('dsh.client.inject 缺省（不产生图边）', () => {
  assert.equal(decl.inject, undefined);
});

check('dsh.client.external 缺省（不请求额外模块）', () => {
  assert.equal(decl.external, undefined);
});

let clientRel;
check('exports["./client"] 可解析为字符串路径', () => {
  clientRel = clientExportOf(pkg.name, pkg.exports);
  assert.equal(clientRel, './client.js');
});

const clientPath = join(dirname(pkgPath), clientRel);

check('client bundle 文件存在（缺失会让 clientModules 抛 MissingClientBundleError）', () => {
  assert.ok(existsSync(clientPath), `缺少 ${clientPath}`);
});

/* ---- 4. initialBundleSnapshot ---- */
console.log('\n[4] bundle 快照与 rev');

let baseline;
check('可读取 stat 基线', () => {
  const stat = statSync(clientPath);
  baseline = { path: clientPath, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs, size: stat.size };
  assert.ok(baseline.size > 0);
});

check('artifactRevision 产出 12 位十六进制 rev', () => {
  const rev = artifactRevision(baseline);
  assert.match(rev, /^[0-9a-f]{12}$/);
});

check('bundle 字节可读且含 __ModuleLoader__ 注册（允许前置注释块）', () => {
  const bytes = readFileSync(clientPath);
  assert.ok(bytes.length > 0);
  const text = bytes.toString('utf8');
  assert.match(text, /window\.__ModuleLoader__\.load\(/);
  assert.match(text, /id:\s*'dsh-continue-button'/);
});

check('注册调用出现在首个非注释语句处（模块体不在脚本执行期运行）', () => {
  const text = readFileSync(clientPath, 'utf8');
  const withoutComments = text.replace(/\/\*[\s\S]*?\*\//gu, '').trimStart();
  assert.match(withoutComments, /^\(\(\)\s*=>\s*\{/);
  assert.match(withoutComments, /window\.__ModuleLoader__\.load\(/);
});

check('bundle 尾部闭合 IIFE', () => {
  const text = readFileSync(clientPath, 'utf8');
  assert.match(text, /return module\.exports;/);
  assert.match(text.trimEnd(), /\}\)\(\);\s*$/u);
});

/* ---- 5. 图谱序约束 ---- */
console.log('\n[5] 图谱序约束');

check('未声明 dsh.client.external，故不参与 orderByModuleGraph 的依赖排序', () => {
  assert.equal(decl.external, undefined);
});

check('宿主半边可被 loader 加载（index.js 存在）', () => {
  assert.ok(existsSync(join(dirname(pkgPath), pkg.exports['.'])));
});

/* ---- 汇总 ---- */
console.log(`\n结果：${checks - failures.length}/${checks} 通过`);
if (failures.length > 0) {
  console.log('\n失败项：');
  for (const failure of failures) console.log(`  - ${failure.label}: ${failure.error.message}`);
  process.exit(1);
}
console.log('全部通过。');
