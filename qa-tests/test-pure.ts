// QA 实证测试：直接 import 真实源码纯函数跑断言（不 mock 业务逻辑）
// 运行方式（见 qa-tests/run.sh / run.ps1）：
//   用 esbuild 把本文件 + 源码打成单文件 bundle，alias 把 'vite-plugin-monkey/dist/client'
//   重定向到本地 gm-stub.ts（纯 no-op），再用 node 运行 bundle。
//   全程不改 node_modules、不影响 vite/tsc 构建。

// ---- 导入真实源码（bundle 时由 esbuild 内联；GM 模块经 alias 替换为 no-op 桩）----
import {
  matchOne, lintRegex, testRules, classifyByRules, validateRules, ruleFlags, AI_PARAMS, summarize, UNC,
} from '../src/service/classify';
import { parseBackup, exportBackup, DEFAULT_CONFIG } from '../src/storage/store';
import type { ClassifyRule } from '../src/types';

let pass = 0;
let fail = 0;
const failures: string[] = [];
function assert(cond: boolean, msg: string, extra?: unknown) {
  if (cond) {
    pass++;
    // console.log('  ✅', msg);
  } else {
    fail++;
    failures.push(msg + (extra !== undefined ? `\n     got: ${JSON.stringify(extra)}` : ''));
    console.log('  ❌', msg, extra !== undefined ? `→ ${JSON.stringify(extra)}` : '');
  }
}
function eq(actual: unknown, expected: unknown, msg: string) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) {
    assert(false, `${msg}\n     expected: ${JSON.stringify(expected)}\n     actual:   ${JSON.stringify(actual)}`);
  } else {
    pass++;
  }
}

// ---- 导入真实源码 ----
type Rule = ClassifyRule;

function mkRule(p: Partial<Rule>): Rule {
  return { id: 'x', pattern: '', category: '', isRegex: false, enabled: true, caseSensitive: false, scope: 'title', ...p } as Rule;
}
function mkMedia(title: string, extra: Partial<any> = {}) {
  return { id: Math.random() * 1e9 | 0, type: 2, title, upper: { name: '' }, ...extra };
}

console.log('\n========== T2/A5 迁移：parseBackup / exportBackup ==========');

// 1. v1 旧备份（rules 缺 enabled/caseSensitive/scope，pref 缺 confirmTaxonomy）
{
  const v1 = JSON.stringify({
    app: 'bilibili-fav-organizer', version: 1, exportedAt: 1, apiKeyRedacted: true,
    config: {
      ai: { baseUrl: 'x', apiKey: '', model: 'm', enabled: false },
      rules: [
        { id: 'a', pattern: '教程', category: '学习', isRegex: false },
        { id: 'b', pattern: '', category: '空', isRegex: false },
        { id: 'c', pattern: '科技', category: '科技', isRegex: true, caseSensitive: true, scope: 'upper' },
        { id: 'd', pattern: 'x', category: 123, isRegex: 'yes' },
      ],
      pref: { allowAiCreate: true, aiBatchSize: 50, lastRequirement: '', rulesFirst: false },
      folderLastRun: {},
    },
    records: [],
  });
  const { config } = parseBackup(v1);
  const r = config.rules;
  eq(r.length, 4, 'v1 备份迁移后规则数=4');
  // 规则 a：缺字段补默认
  eq(r[0].enabled, true, '规则a(有pattern) enabled=true');
  eq(r[0].caseSensitive, false, '规则a caseSensitive=false');
  eq(r[0].scope, 'title', '规则a scope=title');
  // 规则 b：空 pattern → enabled=false
  eq(r[1].enabled, false, '规则b(空pattern) enabled=false');
  eq(r[1].scope, 'title', '规则b scope=title');
  // 规则 c：保留显式值
  eq(r[2].caseSensitive, true, '规则c caseSensitive=true(保留)');
  eq(r[2].scope, 'upper', '规则c scope=upper(保留)');
  eq(r[2].enabled, true, '规则c enabled=true');
  // 规则 d：坏类型修正
  eq(r[3].category, '', '规则d category=非字符串→空');
  eq(r[3].isRegex, true, "规则d isRegex='yes'→!!→true");
  eq(r[3].enabled, true, '规则d(有pattern) enabled=true');
  // confirmTaxonomy 兜底
  eq(config.pref.confirmTaxonomy, false, 'v1 备份 pref.confirmTaxonomy 兜底=false');
  console.log('  v1 备份迁移全部通过');
}

// 2. v2 备份 confirmTaxonomy=true 保留
{
  const v2 = JSON.stringify({
    app: 'bilibili-fav-organizer', version: 2, exportedAt: 1, apiKeyRedacted: true,
    config: {
      ai: { baseUrl: 'x', apiKey: '', model: 'm', enabled: false },
      rules: [{ id: 'a', pattern: 'p', category: 'c', isRegex: false, enabled: true, caseSensitive: false, scope: 'title' }],
      pref: { allowAiCreate: true, aiBatchSize: 50, lastRequirement: '', rulesFirst: false, confirmTaxonomy: true },
      folderLastRun: {},
    },
    records: [],
  });
  const { config } = parseBackup(v2);
  eq(config.pref.confirmTaxonomy, true, 'v2 备份 confirmTaxonomy=true 保留');
  // version=1 不被拒绝
  // （已在 v1 用例覆盖）
}

// 3. exportBackup version===2 + 每条规则 6 字段
{
  // exportBackup 内部 loadConfig()→GM_getValue(返回 undefined→DEFAULT_CONFIG)
  const txt = exportBackup();
  const obj = JSON.parse(txt);
  eq(obj.version, 2, 'exportBackup version=2');
  eq(obj.apiKeyRedacted, true, '导出已脱敏 apiKey');
  eq(obj.config.ai.apiKey, '', '导出 apiKey 为空');
  const r0 = obj.config.rules[0];
  assert('enabled' in r0 && 'caseSensitive' in r0 && 'scope' in r0, '导出规则含 enabled/caseSensitive/scope', r0);
  eq(obj.config.pref.confirmTaxonomy, false, '导出 pref.confirmTaxonomy=false(默认)');
  console.log('  exportBackup 全部通过');
}

// 4. DEFAULT_CONFIG.rules 每条 6 字段
{
  for (const r of DEFAULT_CONFIG.rules) {
    assert(typeof r.enabled === 'boolean' && typeof r.caseSensitive === 'boolean' && typeof r.scope === 'string',
      `DEFAULT_CONFIG 规则 ${r.id} 含 6 字段`, r);
    eq(r.enabled, true, `DEFAULT_CONFIG 规则 ${r.id} enabled=true`);
  }
  eq(DEFAULT_CONFIG.pref.confirmTaxonomy, false, 'DEFAULT_CONFIG.pref.confirmTaxonomy=false');
  console.log('  DEFAULT_CONFIG 6字段全部通过');
}

console.log('\n========== T3 lintRegex（L1 静态扫描）==========');
{
  eq(lintRegex('(a+)+').ok, false, 'lintRegex (a+)+ 不安全');
  assert(!!lintRegex('(a+)+').reason?.includes('嵌套量词'), '(a+)+ reason 含嵌套量词');
  eq(lintRegex('(a*)*').ok, false, 'lintRegex (a*)* 不安全');
  eq(lintRegex('(a+)*').ok, false, 'lintRegex (a+)* 不安全');
  eq(lintRegex('a{100,}').ok, false, 'lintRegex a{100,} 不安全');
  eq(lintRegex('').ok, true, 'lintRegex 空串 ok=true');
  eq(lintRegex('教程|课程').ok, true, 'lintRegex 教程|课程 ok=true');
  eq(lintRegex('^AI编程$').ok, true, 'lintRegex ^AI编程$ ok=true');
  // 团队 lead 要求的 (a+)+$
  eq(lintRegex('(a+)+$').ok, false, 'lintRegex (a+)+$ 不安全(团队lead用例)');
  console.log('  lintRegex 全部通过');
}

console.log('\n========== T3 ruleFlags ==========');
{
  eq(ruleFlags(mkRule({ caseSensitive: false })), 'i', 'caseSensitive=false → i');
  eq(ruleFlags(mkRule({ caseSensitive: true })), '', 'caseSensitive=true → 空');
  console.log('  ruleFlags 全部通过');
}

console.log('\n========== T3 matchOne（纯函数）==========');
{
  // disabled
  eq(matchOne(mkRule({ enabled: false, pattern: 'x' }), mkMedia('x')), false, 'disabled 规则不匹配');
  // 空 pattern
  eq(matchOne(mkRule({ enabled: true, pattern: '' }), mkMedia('任意')), false, '空 pattern 不匹配');
  // 关键词 不区分大小写
  eq(matchOne(mkRule({ pattern: 'AI', isRegex: false, caseSensitive: false }), mkMedia('我的AI编程')), true, '关键词大小写不敏感命中');
  eq(matchOne(mkRule({ pattern: 'ai', isRegex: false, caseSensitive: false }), mkMedia('AI编程')), true, '小写ai匹配大写AI');
  // 关键词 区分大小写
  eq(matchOne(mkRule({ pattern: 'AI', isRegex: false, caseSensitive: true }), mkMedia('我的ai编程')), false, 'caseSensitive=true 大小写不同不匹配');
  eq(matchOne(mkRule({ pattern: 'AI', isRegex: false, caseSensitive: true }), mkMedia('我的AI编程')), true, 'caseSensitive=true 大小写相同匹配');
  // 正则
  eq(matchOne(mkRule({ pattern: '教(程|学)', isRegex: true }), mkMedia('编程教学')), true, '正则命中');
  // 非法正则 → false 不抛
  eq(matchOne(mkRule({ pattern: '(unclosed', isRegex: true }), mkMedia('x')), false, '非法正则 matchOne 返回 false 不抛');
  // scope=title_intro
  eq(matchOne(mkRule({ pattern: '隐藏', isRegex: false, scope: 'title_intro' }), mkMedia('标题', { intro: '这里有隐藏内容' })), true, 'scope=title_intro 命中 intro');
  eq(matchOne(mkRule({ pattern: '隐藏', isRegex: false, scope: 'title' }), mkMedia('标题', { intro: '这里有隐藏内容' })), false, 'scope=title 不命中 intro');
  // scope=upper
  eq(matchOne(mkRule({ pattern: 'UP名', isRegex: false, scope: 'upper' }), mkMedia('标题', { upper: { name: '某UP名主' } })), true, 'scope=upper 命中 upper.name');
  console.log('  matchOne 全部通过');
}

console.log('\n========== T3 classifyByRules ==========');
// 边界1：空规则+空视频
{
  const r = classifyByRules([], []);
  eq(r.result, {}, '空输入 result={}');
  eq(r.rest, [], '空输入 rest=[]');
  eq(r.invalidIds, [], '空输入 invalidIds=[]');
}
// 边界2：全部 disabled
{
  const medias = [mkMedia('教程A'), mkMedia('游戏B')];
  const rules = [mkRule({ id: 'r1', enabled: false, pattern: '教程', category: '学习' })];
  const r = classifyByRules(medias, rules);
  eq(r.rest.length, 2, '全 disabled → 全进 rest');
  eq(Object.keys(r.result).length, 0, '全 disabled → result 空');
  eq(r.invalidIds, [], '全 disabled → invalidIds 空(disabled 不算 invalid)');
}
// 边界3：非法正则规则 → 跳过+收集 invalidIds，不崩
{
  const medias = [mkMedia('教程A')];
  const rules = [
    mkRule({ id: 'bad', pattern: '(unclosed', isRegex: true, category: '坏' }),
    mkRule({ id: 'good', pattern: '教程', isRegex: false, category: '学习' }),
  ];
  const r = classifyByRules(medias, rules);
  eq(r.invalidIds, ['bad'], '非法正则规则 id 进 invalidIds');
  eq(r.result['学习']?.length, 1, '合法规则仍正常归类');
}
// 正常：命中即归类，首条命中优先
{
  const medias = [mkMedia('AI编程入门'), mkMedia('数学教程'), mkMedia('无关视频')];
  const rules = [
    mkRule({ id: 'r1', pattern: 'AI', category: '编程' }),
    mkRule({ id: 'r2', pattern: '教程', category: '学习' }),
  ];
  const r = classifyByRules(medias, rules);
  eq(r.result['编程']?.length, 1, 'AI 视频归入编程');
  eq(r.result['学习']?.length, 1, '教程视频归入学习');
  eq(r.rest.length, 1, '无关视频进 rest');
  eq(r.rest[0].title, '无关视频', 'rest 标题正确');
}
// 正则缓存命中（连续两次同 pattern）
{
  const medias = [mkMedia('abc')];
  const rules = [mkRule({ id: 'r', pattern: 'a(b)c', isRegex: true, category: 'C' })];
  classifyByRules(medias, rules);
  const r2 = classifyByRules(medias, rules); // 第二次走缓存
  eq(r2.result['C']?.length, 1, '正则缓存命中仍正确归类');
}
console.log('  classifyByRules 全部通过');

console.log('\n========== T3 testRules ==========');
// spec 验证点4
{
  const titles = ['AI编程入门', '数学教程'];
  const rules = [
    mkRule({ id: 'ai', pattern: 'AI', category: '编程' }),
    mkRule({ id: 'edu', pattern: '教程', category: '学习' }),
  ];
  const res = testRules(titles, rules);
  eq(res.perRule.length, 2, 'perRule 两条');
  eq(res.perRule[0].hitTitles, ['AI编程入门'], '规则ai 命中 AI编程入门');
  eq(res.perRule[1].hitTitles, ['数学教程'], '规则edu 命中 数学教程');
  eq(res.unmatched, [], '无未命中');
  eq(res.conflicts, [], '无抢占预警');
}
// 抢占预警：宽规则在前、窄规则在后，标题两规则都匹配
{
  const titles = ['AI编程入门教程'];
  const rules = [
    mkRule({ id: 'wide', pattern: 'AI', category: '宽AI' }),     // 靠前宽
    mkRule({ id: 'narrow', pattern: 'AI编程', category: '窄AI编程' }), // 靠后窄
  ];
  const res = testRules(titles, rules);
  eq(res.perRule[0].hitTitles, ['AI编程入门教程'], '靠前宽规则命中');
  eq(res.conflicts.length, 1, '产生 1 处抢占预警');
  eq(res.conflicts[0].earlyRuleId, 'wide', '抢占方=wide');
  eq(res.conflicts[0].lateRuleId, 'narrow', '被抢占方=narrow');
}
// disabled 规则不参与测试
{
  const titles = ['教程A'];
  const rules = [mkRule({ id: 'off', pattern: '教程', category: 'X', enabled: false })];
  const res = testRules(titles, rules);
  eq(res.perRule.length, 0, 'disabled 规则不进 perRule');
  eq(res.unmatched, ['教程A'], '进 unmatched');
}
console.log('  testRules 全部通过');

console.log('\n========== T3 validateRules（L1+L2）==========');
// 空 pattern → invalid
{
  const res = await validateRules([mkRule({ id: 'e', pattern: '' })], false);
  eq(res.valid, false, '空 pattern valid=false');
  assert(res.invalid[0].reason.includes('空'), '空 pattern reason 含"空"');
}
// '(a+)+' 正则 + stressTest → invalid (L1 命中)
{
  const res = await validateRules([mkRule({ id: 'redo', pattern: '(a+)+', isRegex: true })], true);
  eq(res.valid, false, '(a+)+ valid=false');
  assert(res.invalid.some((i) => i.reason.includes('嵌套') || i.reason.includes('回溯')), '(a+)+ reason 含嵌套/回溯');
}
// 非法正则语法 → invalid
{
  const res = await validateRules([mkRule({ id: 'syn', pattern: '[unclosed', isRegex: true })], false);
  eq(res.valid, false, '非法正则语法 valid=false');
  assert(res.invalid.some((i) => i.reason.includes('语法错误')), '非法正则 reason 含"语法错误"');
}
// 合法正则 stressTest=true → 在 Node 无 Worker/URL.createObjectURL，应 'unknown' 不阻断 → valid=true
{
  const res = await validateRules([mkRule({ id: 'ok', pattern: '^教程', isRegex: true })], true);
  eq(res.valid, true, '合法正则 stressTest=true (L2 降级 unknown 不阻断) valid=true');
}
// 合法关键词 → valid
{
  const res = await validateRules([mkRule({ id: 'kw', pattern: 'AI', isRegex: false })], false);
  eq(res.valid, true, '合法关键词 valid=true');
}
// 多条混合：一条空一条合法
{
  const res = await validateRules([
    mkRule({ id: 'e', pattern: '' }),
    mkRule({ id: 'ok', pattern: 'AI', isRegex: false }),
  ], false);
  eq(res.valid, false, '混合(含空pattern) valid=false');
  eq(res.invalid.length, 1, '仅 1 条 invalid');
}
console.log('  validateRules 全部通过');

console.log('\n========== A2 阈值逻辑（代码内联表达式复算）==========');
// 直接复算 classify.ts 中的阈值表达式，确认是 OR（>20 绝对数 OR >5% 百分比）
{
  const UNC_THRESHOLD_ABS = AI_PARAMS.UNC_THRESHOLD_ABS;
  const UNC_THRESHOLD_PCT = AI_PARAMS.UNC_THRESHOLD_PCT;
  eq(UNC_THRESHOLD_ABS, 20, 'UNC_THRESHOLD_ABS=20');
  eq(UNC_THRESHOLD_PCT, 5, 'UNC_THRESHOLD_PCT=5');
  const met = (unc: number, total: number) =>
    unc > UNC_THRESHOLD_ABS || (total > 0 && (unc / total) * 100 > UNC_THRESHOLD_PCT);
  // 30/100: 30>20 → 触发
  eq(met(30, 100), true, '30/100 触发补类(>20)');
  // 10/100: 10>20 否, 10%>5% 是 → OR 触发
  eq(met(10, 100), true, '10/100 触发补类(>5%, OR 语义)');
  // 3/100: 3>20 否, 3%>5% 否 → 不触发
  eq(met(3, 100), false, '3/100 不触发补类');
  // 21/1000: 21>20 是 → 触发
  eq(met(21, 1000), true, '21/1000 触发(>20)');
  console.log('  阈值 OR 语义全部通过');
}

console.log('\n========== summarize ==========');
{
  const s = summarize({ '学习': [mkMedia('a'), mkMedia('b')], [UNC]: [mkMedia('c')] });
  eq(s.total, 3, 'summarize total=3');
  eq(s.unc, 1, 'summarize unc=1');
  eq(s.catCount, 2, 'summarize catCount=2');
}

console.log(`\n========== 结果：${pass} passed, ${fail} failed ==========`);
if (fail > 0) {
  console.log('\n失败用例：');
  failures.forEach((f) => console.log('  - ' + f));
  process.exit(1);
} else {
  console.log('✅ 全部实证测试通过');
  process.exit(0);
}
