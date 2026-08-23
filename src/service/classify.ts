// ============================================================
// 分类引擎：AI 为主 + 规则兜底（2026 最佳实践，两阶段版）
//  - 全量模式两阶段：
//    阶段1：AI 通读全部标题 → 设计 10~18 个全局分类体系（杜绝批间重复建类）
//    阶段2：所有批次严格按固定体系归类（禁止新建、禁止杂项）
//  - 增量模式：只匹配已有收藏夹
//  - AI 不可用：按规则分类，未命中进「未分类」
//  - 规则引擎加固（v0.9）：enabled/caseSensitive/scope 字段、正则缓存、
//    ReDoS 静态 Lint + Blob Worker 压测、规则测试钩子、源夹分布与未分类补类
// ============================================================
import type { CategoryMap, ClassifyRule, FavMedia, RuleScope } from '../types';
import { aiClassify, aiDesignCategories, type DesignedCategory } from './ai';
import { getVideoTags } from './bili';
import type { AiConfig } from '../types';
import { matchExistingFolders, normalizeName } from '../utils/zh';

export const UNC = '未分类';
export type OrganizeMode = 'full' | 'incremental';

/** AI 分类可调参数集中管理（便于调参，避免魔法数字散落） */
export const AI_PARAMS = {
  BATCH_SIZE: 50,            // 主批大小
  REFINEMENT_ROUNDS: 3,      // 未分类补充轮上限
  REFINEMENT_BATCH: 50,      // 补充轮批大小
  CANDIDATE_POOL: 6,         // 候选名池上限（existingFolders.slice 前几个）
  TITLE_TRUNCATE: 36,        // 阶段1 标题截断字数
  INTRO_TRUNCATE: 120,       // toAiVideos intro 截断字数（加长：弱模型仅凭30字易误判，如"零元购→远程控制主机"被截掉）
  UNC_THRESHOLD_PCT: 5,      // 未分类补类触发百分比阈值
  UNC_THRESHOLD_ABS: 20,     // 未分类补类触发绝对数阈值
  SRC_CONCENTRATION_PCT: 40, // 源夹集中度预警百分比阈值
};

// ---- L2: Blob Worker 压测正则（CSP 失败时降级返回 'unknown'） ----
const WORKER_SRC = `
self.onmessage = function(e) {
  var pattern = e.data.pattern;
  var flags = e.data.flags;
  var sample = e.data.sample;
  try {
    var re = new RegExp(pattern, flags);
    // 对"最坏输入"跑 test：重复字符 + 不匹配尾，触发灾难性回溯
    re.test(sample);
    self.postMessage({ safe: true });
  } catch (err) {
    self.postMessage({ safe: false, error: String(err) });
  }
};
`;

/** L2: Blob Worker 压测正则（CSP 失败时降级返回 'unknown'） */
function stressTestRegex(pattern: string, flags: string, timeoutMs = 300): Promise<'safe' | 'unsafe' | 'unknown'> {
  return new Promise((resolve) => {
    let worker: Worker | null = null;
    let settled = false;
    const done = (r: 'safe' | 'unsafe' | 'unknown') => {
      if (settled) return;
      settled = true;
      if (worker) worker.terminate();
      resolve(r);
    };
    try {
      const blob = new Blob([WORKER_SRC], { type: 'application/javascript' });
      worker = new Worker(URL.createObjectURL(blob));
      // 构造最坏输入：pattern 首字符重复 30 次 + 一个不匹配尾字符
      const firstChar = (pattern.match(/[a-zA-Z0-9]/) || ['a'])[0];
      const sample = firstChar.repeat(30) + '!';
      worker.onmessage = (e: MessageEvent) => done(e.data.safe ? 'safe' : 'unsafe');
      worker.onerror = () => done('unknown');
      worker.postMessage({ pattern, flags, sample });
      setTimeout(() => done('unsafe'), timeoutMs);
    } catch {
      // CSP 拦截 blob worker 或环境不支持
      done('unknown');
    }
  });
}

/** 计算正则 flags：caseSensitive=false 时加 'i'（保持原行为） */
export function ruleFlags(r: ClassifyRule): string {
  return r.caseSensitive ? '' : 'i';
}

/** 按 scope 取待匹配文本 */
function ruleText(m: FavMedia, scope: RuleScope): string {
  if (scope === 'upper') return m.upper?.name || '';
  if (scope === 'title_intro') return `${m.title} ${m.intro || ''}`;
  return m.title;
}

/** 单条规则对单条视频的匹配判定（纯函数，classifyByRules 与 testRules 共用内核） */
export function matchOne(r: ClassifyRule, m: FavMedia): boolean {
  if (!r.enabled || !r.pattern) return false; // 禁用/空 pattern 跳过
  try {
    if (r.isRegex) {
      return new RegExp(r.pattern, ruleFlags(r)).test(ruleText(m, r.scope || 'title'));
    }
    const text = ruleText(m, r.scope || 'title');
    const pat = r.pattern;
    return r.caseSensitive ? text.includes(pat) : text.toLowerCase().includes(pat.toLowerCase());
  } catch {
    return false; // 非法正则视为不匹配（invalid 由 validateRules 收集）
  }
}

// 模块级 RegExp 缓存（key = pattern|flags）
const regexCache = new Map<string, RegExp>();

/** 规则引擎：命中即归类，返回 { 结果, 剩余, invalidIds } */
export function classifyByRules(
  medias: FavMedia[],
  rules: ClassifyRule[],
): { result: CategoryMap; rest: FavMedia[]; invalidIds: string[] } {
  const result: CategoryMap = {};
  const rest: FavMedia[] = [];
  const invalidIds: string[] = [];
  // 预编译正则，收集 invalid
  const compiled: Array<{ r: ClassifyRule; re: RegExp | null }> = rules.map((r) => {
    if (!r.enabled || !r.pattern) return { r, re: null };
    if (!r.isRegex) return { r, re: null };
    const key = `${r.pattern}|${ruleFlags(r)}`;
    if (regexCache.has(key)) return { r, re: regexCache.get(key)! };
    try {
      const re = new RegExp(r.pattern, ruleFlags(r));
      regexCache.set(key, re);
      return { r, re };
    } catch {
      invalidIds.push(r.id);
      return { r, re: null };
    }
  });
  for (const m of medias) {
    let hit = '';
    for (const { r, re } of compiled) {
      if (!r.enabled || !r.pattern) continue;
      let matched = false;
      if (r.isRegex && re) {
        matched = re.test(ruleText(m, r.scope || 'title'));
      } else if (!r.isRegex) {
        matched = matchOne(r, m);
      }
      if (matched) { hit = r.category; break; }
    }
    if (hit) (result[hit] ||= []).push({ ...m, category: hit });
    else rest.push(m);
  }
  return { result, rest, invalidIds };
}

/** L1: 静态扫描正则源码，拦截已知灾难性回溯模式 */
export function lintRegex(pattern: string): { ok: boolean; reason?: string } {
  if (!pattern) return { ok: true };
  // 嵌套量词：(a+)+ / (a*)* / (a+)* 等
  if (/\([^)]*[+*][^)]*\)[+*{]/.test(pattern)) {
    return { ok: false, reason: '检测到嵌套量词（如 (a+)+），极易引发灾难性回溯，请简化' };
  }
  // 超长重复：a{100,}（量级过大）
  if (/\{\d{3,},\}/.test(pattern)) {
    return { ok: false, reason: '重复次数过大（{100+}），可能性能不佳，请缩小范围' };
  }
  return { ok: true };
}

export interface RuleValidation {
  valid: boolean;
  invalid: Array<{ id: string; reason: string }>;
}

/**
 * 校验规则集：空 pattern 标记、非法正则标记、ReDoS 风险标记
 * @param rules 待校验规则
 * @param stressTest 是否对正则跑 L2 Worker 压测（保存时 true，运行时 false）
 */
export async function validateRules(
  rules: ClassifyRule[],
  stressTest = false,
): Promise<RuleValidation> {
  const invalid: Array<{ id: string; reason: string }> = [];
  for (const r of rules) {
    if (!r.pattern) {
      invalid.push({ id: r.id, reason: '匹配内容为空（已自动禁用）' });
      continue;
    }
    if (r.isRegex) {
      // 语法校验
      try {
        new RegExp(r.pattern, ruleFlags(r));
      } catch (e) {
        invalid.push({ id: r.id, reason: `正则语法错误：${e instanceof Error ? e.message : e}` });
        continue;
      }
      // L1 静态扫描
      const lint = lintRegex(r.pattern);
      if (!lint.ok) {
        invalid.push({ id: r.id, reason: lint.reason! });
        continue;
      }
      // L2 Worker 压测（仅保存时）
      if (stressTest) {
        const stress = await stressTestRegex(r.pattern, ruleFlags(r));
        if (stress === 'unsafe') {
          invalid.push({ id: r.id, reason: '正则存在回溯炸弹风险（压测超时），请简化或改用关键词匹配' });
        }
        // 'unknown'(CSP 降级) 不阻断，仅 L1 已过
      }
    }
  }
  return { valid: invalid.length === 0, invalid };
}

export interface RuleTestResult {
  perRule: Array<{ ruleId: string; pattern: string; category: string; hitTitles: string[] }>;
  unmatched: string[];                 // 未被任何启用规则命中的标题
  conflicts: Array<{ title: string; earlyRuleId: string; lateRuleId: string }>; // 抢占预警
}

/** 规则测试：对给定标题列表逐规则匹配，返回命中明细与抢占预警 */
export function testRules(titles: string[], rules: ClassifyRule[]): RuleTestResult {
  const active = rules.filter((r) => r.enabled && r.pattern);
  const perRule = active.map((r) => ({
    ruleId: r.id,
    pattern: r.pattern,
    category: r.category,
    hitTitles: [] as string[],
  }));
  const unmatched: string[] = [];
  const conflicts: RuleTestResult['conflicts'] = [];
  for (const title of titles) {
    const fakeMedia = { title, upper: { name: '' } } as FavMedia; // 测试仅按 title（scope=title 时）
    let firstHitIdx = -1;
    const allHitIdx: number[] = [];
    active.forEach((r, i) => {
      // 测试时 scope 固定 title（不测 upper/intro，因测试输入是纯标题列表）
      if (matchOne({ ...r, scope: 'title' }, fakeMedia)) {
        allHitIdx.push(i);
        if (firstHitIdx < 0) firstHitIdx = i;
      }
    });
    if (firstHitIdx < 0) {
      unmatched.push(title);
    } else {
      perRule[firstHitIdx].hitTitles.push(title);
      // 抢占预警：被靠前规则命中，靠后规则也匹配
      if (allHitIdx.length > 1) {
        for (const lateIdx of allHitIdx.slice(1)) {
          conflicts.push({
            title,
            earlyRuleId: active[firstHitIdx].id,
            lateRuleId: active[lateIdx].id,
          });
        }
      }
    }
  }
  return { perRule, unmatched, conflicts };
}

/** 构建 AI 入参（id/bvid/type/title/intro/upper/srcFolder 精简；intro 截 30 字） */
function toAiVideos(medias: FavMedia[]) {
  return medias.map((m) => ({
    id: m.id,
    bvid: m.bvid || '',
    type: m.type,
    title: m.title,
    intro: m.intro ? m.intro.substring(0, AI_PARAMS.INTRO_TRUNCATE) : '',
    upper: m.upper?.name || '',
    srcFolder: m.srcFolderName || '',  // 新增：源夹分布弱信号
    tags: m.tags || [],
  }));
}

/**
 * 主流程：AI 为主 → 规则兜底 → 分类名归并（繁简/近义）
 * 关键改进（v0.6，基于真实 614 条数据复盘）：
 *  - 多批处理时批间传递已确定分类名，AI 在同一分类体系内延续，杜绝批间重复建类
 *  - 匹配优先用 bvid（AI 输出 id 不可靠），bvid 缺失再用 id
 *  - 全量模式不把用户已有收藏夹当分类依据
 *  - AI 遗漏的未分类视频做「二次补充分类」：单批再次交给 AI 强制全部分类
 *  - v0.9 新增：阶段1 传源夹分布（覆盖率信号）、未分类补类循环、源夹集中度预警、体系确认暂停态
 * @param mode full=全量重分类 / incremental=增量分配
 * @param rulesFirst 规则优先于 AI：命中的视频不送 AI（用户显式意图，直接定分类）
 * @param onProgress 分类进度回调（done, total, phase）
 * @param onLog 实时日志回调（批次进行中即推送，供 UI 实时展示 AI 过程）
 * @param onTaxonomyConfirm 阶段1 后的体系确认回调（confirmTaxonomy 开启时传入，返回确认后的体系）
 * @returns { result, logs, usedAi, mergeLogs }
 */
export async function classifyAll(
  medias: FavMedia[],
  existingFolders: string[],
  cfg: AiConfig,
  rules: ClassifyRule[],
  aiBatchSize: number,
  userRequirement = '',
  mode: OrganizeMode = 'full',
  rulesFirst = false,
  onProgress?: (done: number, total: number, phase: 'fetch' | 'ai') => void,
  onLog?: (msg: string) => void,
  onTaxonomyConfirm?: (designed: DesignedCategory[]) => Promise<DesignedCategory[]>,
): Promise<{ result: CategoryMap; logs: string[]; usedAi: boolean; mergeLogs: string[] }> {
  const logs: string[] = [];
  const mergeLogs: string[] = [];
  let usedAi = false;
  // 关键过程日志实时推送（否则要等全部批次结束才可见）
  const emit = (msg: string) => { logs.push(msg); onLog?.(msg); };

  // AI 可用 → AI 处理（rulesFirst 时规则命中的先剥离，不送 AI）
  if (cfg.enabled && cfg.apiKey) {
    usedAi = true;

    const result: CategoryMap = {};

    // ---- 规则优先：命中的直接归类（省 AI 调用，且是用户显式意图） ----
    let ruleResult: CategoryMap | null = null;
    let pending = medias;
    if (rulesFirst) {
      const { result: hitMap, rest, invalidIds } = classifyByRules(medias, rules);
      if (invalidIds.length) emit(`⚠️ 有 ${invalidIds.length} 条规则正则无效已跳过，请在设置页检查`);
      if (Object.keys(hitMap).length) {
        ruleResult = hitMap;
        pending = rest;
        const hitCount = Object.values(hitMap).reduce((s, arr) => s + arr.length, 0);
        emit(`⚡ 规则优先：命中 ${hitCount} 条直接归类（不送 AI），剩余 ${rest.length} 条交给 AI`);
        for (const cat of Object.keys(hitMap)) mergeLogs.push(`📌 规则命中 →「${cat}」（${hitMap[cat].length} 条）`);
      }
    }

    if (!pending.length) {
      emit('全部视频已被规则命中，未调用 AI');
    }

    // 增量模式：抓取 B站官方标签作为弱模型分类强信号（仅增量：视频少、调用可控；全量不动以免海量请求触发风控）
    // 移到规则拆分之后：只对 pending 抓取，省掉规则命中视频的无效请求
    if (mode === 'incremental') {
      emit('🔍 增量模式：抓取 B站官方标签作分类强信号...');
      let done = 0;
      for (const m of pending) {
        if (m.bvid) {
          try {
            const tags = await getVideoTags(m.bvid);
            if (tags.length) m.tags = tags;
          } catch { /* 单条失败不影响整体 */ }
        }
        done++;
        onProgress?.(done, pending.length, 'fetch');
      }
      emit('✅ 标签抓取完成（' + pending.filter((m) => m.tags?.length).length + '/' + pending.length + ' 条获得标签信号）');
    }

    const batches: FavMedia[][] = [];
    for (let i = 0; i < pending.length; i += aiBatchSize) batches.push(pending.slice(i, i + aiBatchSize));
    const establishedCats: string[] = []; // 批间延续：已确定的分类名
    const assignedIds = new Set<number>();
    const assignedBvids = new Set<string>();

    // ---- 阶段1（仅全量模式）：AI 通读全部标题，设计全局分类体系（含分类定义） ----
    // 根治批间重复建类（游戏/游戏竞技/独立与休闲游戏/电竞 四胞胎问题）
    let fixedCategories: string[] = [];
    let fixedDescs: Record<string, string> = {};
    if (mode === 'full' && pending.length) {
      try {
        emit(`🧠 阶段1：AI 通读全部 ${pending.length} 条标题，设计全局分类体系（这一步需要 30~90 秒，请耐心等待）...`);
        // 阶段1 进度标记（done=-1 表示阶段1 进行中，UI 显示特殊文案）
        onProgress?.(-1, batches.length, 'ai');
        // 从 pending 统计源夹分布（覆盖率信号，帮助 AI 发现可能遗漏的主题块）
        const folderDistribution: Record<string, number> = {};
        for (const m of pending) {
          const fn = m.srcFolderName || '未知夹';
          folderDistribution[fn] = (folderDistribution[fn] || 0) + 1;
        }
        const designed: DesignedCategory[] = await aiDesignCategories(
          cfg,
          pending.map((m) => m.title),
          existingFolders,
          userRequirement,
          folderDistribution,  // 新增参数
        );
        fixedCategories = designed.map((c) => c.name);
        fixedDescs = Object.fromEntries(designed.filter((c) => c.desc).map((c) => [c.name, c.desc]));
        const descText = designed.map((c) => (c.desc ? `${c.name}（${c.desc}）` : c.name)).join('、');
        emit(`✅ 分类体系设计完成：${fixedCategories.length} 个分类 → ${descText}`);
        // confirmTaxonomy 暂停态：交由 UI 确认后覆盖体系
        if (onTaxonomyConfirm) {
          emit('⏸️ 阶段1 完成，等待用户确认分类体系...');
          try {
            const confirmed = await onTaxonomyConfirm(designed);
            // 用确认后的体系覆盖
            fixedCategories = confirmed.map((c) => c.name);
            fixedDescs = Object.fromEntries(confirmed.filter((c) => c.desc).map((c) => [c.name, c.desc]));
            emit('✅ 用户已确认分类体系');
          } catch {
            emit('⚠️ 用户取消确认，沿用 AI 原始体系');
          }
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        emit(`⚠️ 阶段1 分类体系设计失败（${msg}），回退为逐批自由分类`);
        fixedCategories = [];
        fixedDescs = {};
      }
    }

    // ---- 阶段2：分批归类 ----
    // 增量候选目标：完整夹列表排除视频原本所在的【源夹】（避免模型把视频归回源夹=静默漏分）
    const srcFolderSet = new Set(medias.map((m) => m.srcFolderName).filter(Boolean) as string[]);
    const incCandidates = existingFolders.filter((f) => !srcFolderSet.has(f));
    for (let bi = 0; bi < batches.length; bi++) {
      const batch = batches[bi];
      onProgress?.(bi, batches.length, 'ai');
      try {
        emit(`AI 处理第 ${bi + 1}/${batches.length} 批（${batch.length} 条）...`);
        // 候选目标池：全量只取前 N 个（弱模型对长列表会迷惑、截断输出）；增量用「完整夹列表排除源夹」
        const aiRefs = mode === 'incremental' ? incCandidates : existingFolders.slice(0, AI_PARAMS.CANDIDATE_POOL);
        const aiRes = await aiClassify(cfg, aiRefs, toAiVideos(batch), userRequirement, mode, establishedCats, fixedCategories, fixedDescs);
        // 思维链摘要：让用户看到 AI 每批的归类思路（进度可视化的核心）
        const thought = (aiRes.thoughts || '').trim();
        if (thought) emit(`💭 「${thought.slice(0, 120)}${thought.length > 120 ? '…' : ''}」`);
        for (const [cat, vids] of Object.entries(aiRes.categories || {})) {
          if (!vids?.length) continue;
          const key = (cat || UNC).trim();
          if (!key) continue;
          for (const v of vids) {
            // 用 bvid 匹配优先，其次 id
            const src =
              (v.bvid && batch.find((m) => m.bvid === v.bvid)) ||
              batch.find((m) => !m.bvid && m.id === v.id) ||
              batch.find((m) => m.id === v.id);
            if (!src) continue;
            const already = assignedIds.has(src.id) || (src.bvid ? assignedBvids.has(src.bvid) : false);
            if (already) continue;
            // 不能归入「未分类」作为正常分类键（AI 有时会偷懒输出未分类）
            if (key === UNC) continue;
            (result[key] ||= []).push({ ...src, category: key });
            assignedIds.add(src.id);
            if (src.bvid) assignedBvids.add(src.bvid);
            if (!establishedCats.includes(key)) establishedCats.push(key);
          }
        }
        // AI 遗漏的进「未分类」，稍后统一二次补充
        const missed = batch.filter((m) => !assignedIds.has(m.id) && !(m.bvid && assignedBvids.has(m.bvid)));
        if (missed.length) {
          (result[UNC] ||= []).push(...missed.map((m) => ({ ...m, category: UNC })));
          emit(`AI 第 ${bi + 1} 批遗漏 ${missed.length} 条，稍后二次补充分类`);
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        emit(`⚠️ AI 第 ${bi + 1} 批失败（${msg}），该批放入「${UNC}」待二次补充`);
        (result[UNC] ||= []).push(...batch.map((m) => ({ ...m, category: UNC })));
      }
    }

    // ---- 二次补充：未分类视频分批再交给 AI，最多 REFINEMENT_ROUNDS 轮，强制全部分类 ----
    // 关键：未分类可能很多（如 390 条），必须分批（≤50/批）且循环多轮，
    // 否则一次性喂给弱模型照样超长漏输出
    let uncMedias = result[UNC] || [];
    for (let round = 1; round <= AI_PARAMS.REFINEMENT_ROUNDS && uncMedias.length; round++) {
      emit(`🔁 补充分类第 ${round} 轮：${uncMedias.length} 条未分类视频重新交给 AI ...`);
      const subBatches: FavMedia[][] = [];
      const subSize = Math.min(AI_PARAMS.REFINEMENT_BATCH, aiBatchSize);
      for (let i = 0; i < uncMedias.length; i += subSize) subBatches.push(uncMedias.slice(i, i + subSize));

      const newly = new Set<number>();
      for (let sbi = 0; sbi < subBatches.length; sbi++) {
        const sub = subBatches[sbi];
        try {
          // 二次补充：增量用「排除源夹的完整候选池」，全量用前 N 个
          const refCands = mode === 'incremental' ? incCandidates : existingFolders.slice(0, AI_PARAMS.CANDIDATE_POOL);
          const aiRes2 = await aiClassify(cfg, refCands, toAiVideos(sub), userRequirement, mode, establishedCats, fixedCategories, fixedDescs);
          const thought2 = (aiRes2.thoughts || '').trim();
          if (thought2) emit(`💭 「${thought2.slice(0, 120)}${thought2.length > 120 ? '…' : ''}」`);
          for (const [cat, vids] of Object.entries(aiRes2.categories || {})) {
            if (!vids?.length) continue;
            const key = (cat || UNC).trim();
            if (!key || key === UNC) continue;
            for (const v of vids) {
              const src =
                (v.bvid && sub.find((m) => m.bvid === v.bvid)) ||
                sub.find((m) => m.id === v.id);
              if (!src || newly.has(src.id)) continue;
              (result[key] ||= []).push({ ...src, category: key });
              newly.add(src.id);
              if (!establishedCats.includes(key)) establishedCats.push(key);
            }
          }
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          emit(`⚠️ 补充第 ${round} 轮子批 ${sbi + 1} 失败（${msg}）`);
        }
      }
      if (newly.size) {
        uncMedias = uncMedias.filter((m) => !newly.has(m.id));
        result[UNC] = uncMedias;
        emit(`✅ 补充第 ${round} 轮成功 ${newly.size} 条，剩余 ${uncMedias.length} 条`);
      } else {
        // 本轮一条都没分出来，说明 AI 卡住了，停止循环
        emit(`⚠️ 补充第 ${round} 轮无进展，停止补充`);
        break;
      }
    }
    onProgress?.(batches.length, batches.length, 'ai');

    // 分类名归并策略按模式区分：
    // - 全量模式：AI 已按用户语义重新设计分类体系，仅做「近似分类名合并」防碎类（不做已有收藏夹匹配）
    // - 增量模式：强制只匹配已有收藏夹，未匹配进未分类
    const finalResult: CategoryMap = {};

    if (mode === 'incremental') {
      const newNames = Object.keys(result).filter((k) => k !== UNC);
      const { matched } = matchExistingFolders(newNames, existingFolders);
      for (const [cat, items] of Object.entries(result)) {
        if (cat === UNC) { (finalResult[UNC] ||= []).push(...items); continue; }
        const target = matched.get(cat);
        if (target) {
          (finalResult[target] ||= []).push(...items.map((m) => ({ ...m, category: target })));
          mergeLogs.push(`🔀 新分类「${cat}」已并入已有收藏夹「${target}」`);
        } else {
          (finalResult[UNC] ||= []).push(...items.map((m) => ({ ...m, category: UNC })));
          mergeLogs.push(`⚠️ 增量模式下「${cat}」未匹配已有收藏夹，放入「${UNC}」`);
        }
      }
    } else {
      // 全量：合并"近似重复/同主题"的分类名，减少冗余（如「AI与编程」「AI技术」「AI与技术」→ 合并）
      const catKeys = Object.keys(result).filter((k) => k !== UNC);
      const used = new Set<string>();
      const catList = catKeys.map((cat) => ({ cat, norm: normalizeName(cat) }));

      for (const { cat, norm } of catList) {
        if (!norm) { (finalResult[cat] ||= []).push(...result[cat]); continue; }
        let merged = '';
        // 1) 完全相等 / 包含（≥2字，如「游戏」⊂「游戏竞技」；AI ⊂ AI编程）
        for (const k of used) {
          const kn = normalizeName(k);
          if (kn === norm || (kn.length >= 2 && norm.length >= 2 && (kn.includes(norm) || norm.includes(kn)))) {
            merged = k;
            break;
          }
        }
        // 2) 共享 2 字核心词（如「AI技术」vs「AI与编程」共享「ai」）
        if (!merged) {
          for (const k of used) {
            const kn = normalizeName(k);
            if (kn.length >= 4 && norm.length >= 4) {
              const prefixA = kn.slice(0, 2);
              const prefixB = norm.slice(0, 2);
              const tailA = kn.slice(-2);
              const tailB = norm.slice(-2);
              // 前两字相同 或 后两字相同（如「健身运动」「健身训练」）
              if (prefixA === prefixB || tailA === tailB) {
                merged = k;
                break;
              }
            }
          }
        }
        if (merged) {
          (finalResult[merged] ||= []).push(...result[cat].map((m) => ({ ...m, category: merged })));
          mergeLogs.push(`🔀 分类「${cat}」已合并到「${merged}」`);
        } else {
          used.add(cat);
          (finalResult[cat] ||= []).push(...result[cat]);
        }
      }
      if (result[UNC]) (finalResult[UNC] ||= []).push(...result[UNC]);
    }

    // ---- 规则优先结果合入：规则目标是用户显式意图，不参与已有夹匹配/近似合并 ----
    if (ruleResult) {
      for (const [cat, items] of Object.entries(ruleResult)) {
        (finalResult[cat] ||= []).push(...items);
      }
    }

    // ---- 未分类补类：未分类 > 阈值时，取未分类标题回阶段1 补类，再对未分类子集重跑阶段2 ----
    // 仅全量模式：增量模式不允许新建分类，补类无意义（会浪费 token 且结果仍进未分类）
    if (mode === 'full') {
      const total = Object.values(finalResult).reduce((s, arr) => s + arr.length, 0);
      const uncItems = finalResult[UNC] || [];
      const thresholdMet = uncItems.length > AI_PARAMS.UNC_THRESHOLD_ABS
        || (total > 0 && (uncItems.length / total) * 100 > AI_PARAMS.UNC_THRESHOLD_PCT);
      if (thresholdMet && uncItems.length) {
        emit(`🔁 未分类 ${uncItems.length} 条超过阈值，启动补类（回阶段1 设计补充分类）...`);
        try {
          const uncTitles = uncItems.map((m) => m.title);
          const uncFolderDist: Record<string, number> = {};
          for (const m of uncItems) {
            const fn = m.srcFolderName || '未知夹';
            uncFolderDist[fn] = (uncFolderDist[fn] || 0) + 1;
          }
          const extraDesigned = await aiDesignCategories(cfg, uncTitles, existingFolders, userRequirement, uncFolderDist);
          const extraCats = extraDesigned.map((c) => c.name);
          const extraDescs = Object.fromEntries(extraDesigned.filter((c) => c.desc).map((c) => [c.name, c.desc]));
          // 合并到固定体系
          const mergedCats = [...new Set([...fixedCategories, ...extraCats])];
          const mergedDescs = { ...fixedDescs, ...extraDescs };
          emit(`✅ 补类完成：新增 ${extraCats.length} 个分类 → ${extraCats.join('、')}`);
          // 对未分类子集重跑阶段2（小批）
          const subBatches: FavMedia[][] = [];
          for (let i = 0; i < uncItems.length; i += AI_PARAMS.REFINEMENT_BATCH) {
            subBatches.push(uncItems.slice(i, i + AI_PARAMS.REFINEMENT_BATCH));
          }
          const newlyClassified = new Set<number>();
          for (const sub of subBatches) {
            try {
              const aiRes = await aiClassify(cfg, existingFolders.slice(0, AI_PARAMS.CANDIDATE_POOL), toAiVideos(sub), userRequirement, mode, mergedCats, mergedCats, mergedDescs);
              for (const [cat, vids] of Object.entries(aiRes.categories || {})) {
                if (!vids?.length) continue;
                const key = (cat || UNC).trim();
                if (!key || key === UNC) continue;
                for (const v of vids) {
                  const src = (v.bvid && sub.find((m) => m.bvid === v.bvid)) || sub.find((m) => m.id === v.id);
                  if (!src || newlyClassified.has(src.id)) continue;
                  (finalResult[key] ||= []).push({ ...src, category: key });
                  newlyClassified.add(src.id);
                }
              }
            } catch (e) {
              emit(`⚠️ 补类子批失败（${e instanceof Error ? e.message : e}）`);
            }
          }
          // 从未分类移除已补类的
          if (newlyClassified.size) {
            finalResult[UNC] = uncItems.filter((m) => !newlyClassified.has(m.id));
            emit(`✅ 补类成功归位 ${newlyClassified.size} 条，剩余未分类 ${finalResult[UNC].length} 条`);
          } else {
            emit('⚠️ 补类无进展，未分类保持原样');
          }
        } catch (e) {
          emit(`⚠️ 补类失败（${e instanceof Error ? e.message : e}），未分类保持原样`);
        }
      }
    }

    // ---- 源夹集中度预警：分类 >40% 来自单一源夹且源夹名与分类名语义不符 → 疑似错分 ----
    for (const [cat, items] of Object.entries(finalResult)) {
      if (cat === UNC || cat === '失效视频') continue;
      // 统计源夹分布
      const srcCount = new Map<string, number>();
      for (const m of items) {
        const fn = m.srcFolderName || '未知夹';
        srcCount.set(fn, (srcCount.get(fn) || 0) + 1);
      }
      const maxSrc = [...srcCount.entries()].sort((a, b) => b[1] - a[1])[0];
      if (maxSrc && items.length >= 10) {
        const pct = (maxSrc[1] / items.length) * 100;
        if (pct > AI_PARAMS.SRC_CONCENTRATION_PCT) {
          // 语义判定：源夹名与分类名归一化后无共同 2 字核心词
          const srcNorm = normalizeName(maxSrc[0]);
          const catNorm = normalizeName(cat);
          const shareCore = srcNorm.length >= 2 && catNorm.length >= 2
            && (srcNorm.includes(catNorm) || catNorm.includes(srcNorm)
              || srcNorm.slice(0, 2) === catNorm.slice(0, 2));
          if (!shareCore) {
            logs.push(
              `⚠️ 分类「${cat}」${items.length} 条中 ${maxSrc[1]} 条(${Math.round(pct)}%)来自「${maxSrc[0]}」，` +
              `源夹名与分类名无主题关联，疑似混入不相关内容，建议在预览中复查`,
            );
          }
        }
      }
    }

    logs.push(...mergeLogs);
    return { result: finalResult, logs, usedAi, mergeLogs };
  }

  // 无 AI → 规则兜底
  logs.push('未配置 AI Key，使用规则分类；未命中进「未分类」（可手动归类或补配 AI）');
  const { result, rest, invalidIds } = classifyByRules(medias, rules);
  if (invalidIds.length) logs.push(`⚠️ 有 ${invalidIds.length} 条规则正则无效已跳过，请在设置页检查`);
  if (rest.length) {
    (result[UNC] ||= []).push(...rest.map((m) => ({ ...m, category: UNC })));
    logs.push(`规则未命中 ${rest.length} 条，已放入「${UNC}」`);
  }
  return { result, logs, usedAi, mergeLogs };
}

/** 统计分类结果：分类数、总数、未分类数 */
export function summarize(result: CategoryMap) {
  const total = Object.values(result).reduce((s, arr) => s + arr.length, 0);
  const unc = (result[UNC] || []).length;
  return { total, unc, catCount: Object.keys(result).length };
}
