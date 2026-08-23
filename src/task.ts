// ============================================================
// 后台整理任务执行器
//  - 从视图解耦：任务状态存全局 state，切换 tab 不中断
//  - 支持多收藏夹批量整理
//  - 自动检测重复视频（同 avid 出现在多个收藏夹）与失效视频
//  - 失效视频单独归入「失效视频」收藏夹（不忽略）
//  - 两种模式：full 全量重分类（可新建夹）/ incremental 增量分配（仅匹配已有夹）
// ============================================================
import { state, startTask, taskLog, endTask, persist, persistTask } from './state';
import { fetchAllMedias, getMyFolders, createFolder, moveResources, deleteResources, isBlocked } from './service/bili';
import { classifyAll, UNC, type OrganizeMode } from './service/classify';
import type { DesignedCategory } from './service/ai';
import { addRecord } from './storage/store';
import { normalizeName } from './utils/zh';
import type { CategoryMap, FavFolder, FavMedia } from './types';

export const INVALID_FOLDER = '失效视频';

/** 按源收藏夹分组（applySuggest / applyDedup 共用） */
function groupBySrc(items: FavMedia[], fallback?: number): Map<number, FavMedia[]> {
  const bySrc = new Map<number, FavMedia[]>();
  for (const m of items) {
    const sid = m.srcFolderId ?? fallback;
    if (sid == null) continue;
    if (!bySrc.has(sid)) bySrc.set(sid, []);
    bySrc.get(sid)!.push(m);
  }
  return bySrc;
}

// 移动进行中离开页面（整页导航/关闭）会中断脚本导致移动停在半途——拦截并提示。
// SPA 内部路由不销毁脚本，不受影响；后台标签页切走仅降低限速节奏，不会中断。
window.addEventListener('beforeunload', (e) => {
  if (state.task?.applying) {
    e.preventDefault();
    e.returnValue = '';
  }
});

/** 检测重复与失效：返回 { 去重后的视频, 重复组, 多余副本, 失效列表 }
 *  保留策略：同一视频出现在多个收藏夹时，保留 fav_time 最早（最先收藏）的一份参与分类，
 *  其余副本进 dupExtras，由预览页「清理重复项」一键从源夹移除 */
export function detectDupAndInvalid(medias: FavMedia[]) {
  const seen = new Map<number, FavMedia[]>();
  const invalid: FavMedia[] = [];
  for (const m of medias) {
    // attr: 0 正常 / 1 已删除 / 9 发布者删除
    if (m.attr !== undefined && m.attr !== 0) {
      invalid.push(m);
      continue;
    }
    const arr = seen.get(m.id) || [];
    arr.push(m);
    seen.set(m.id, arr);
  }
  const unique: FavMedia[] = [];
  const dups: FavMedia[][] = [];
  const dupExtras: FavMedia[] = [];
  for (const arr of seen.values()) {
    const sorted = arr.length > 1 ? [...arr].sort((a, b) => (a.fav_time ?? 0) - (b.fav_time ?? 0)) : arr;
    unique.push(sorted[0]);
    if (sorted.length > 1) {
      dups.push(sorted);
      dupExtras.push(...sorted.slice(1));
    }
  }
  return { unique, dups, dupExtras, invalid };
}

/** 启动后台整理任务：抓取多个收藏夹 → 查重/失效检测 → 分类
 *  增量模式：只处理「上次成功整理后新收藏」的视频（按 fav_time > 上次基准过滤） */
export async function runOrganizeTask(folders: FavFolder[], mode: OrganizeMode = 'full'): Promise<void> {
  if (!folders.length || (state.task && state.task.running)) return;
  // 已有未完成的任务（含分类结果/移动进度）：覆盖前确认，避免误点丢失
  if (state.task && state.task.suggest && !state.task.done) {
    if (!confirm('当前有一个未完成的整理任务（分类结果与移动进度会被丢弃）。确定重新开始？')) return;
  }
  const userRequirement = state.config.pref.lastRequirement.trim();
  startTask(folders, mode);
  taskLog(`🛠️ 模式：${mode === 'incremental' ? '增量分配（只处理新收藏的视频，仅匹配已有收藏夹）' : '全量重分类（可新建收藏夹）'}`);
  if (userRequirement) taskLog(`📝 整理要求：${userRequirement}`);

  try {
    // 1) 全量抓取（多个收藏夹合并）；增量模式下按上次基准过滤旧视频
    const all: FavMedia[] = [];
    for (const f of folders) {
      taskLog(`📦 抓取收藏夹【${f.title}】...`);
      const medias = await fetchAllMedias(f.id, (done, total) => {
        state.task!.progress = { done, total, phase: 'fetch' };
      });
      medias.forEach((m) => {
        m.srcFolderId = f.id;
        m.srcFolderName = f.title;
      });
      // 记录该夹见过的最大 fav_time（增量基准；不换算单位，直接与 fav_time 比较）
      const maxFav = medias.reduce((mx, m) => Math.max(mx, m.fav_time ?? 0), 0);
      state.task!.folderMaxFav[String(f.id)] = maxFav;

      let fresh = medias;
      if (mode === 'incremental') {
        const lastMark = state.config.folderLastRun[String(f.id)] || 0;
        if (lastMark > 0) {
          // fav_time 缺失时保守视为新视频（宁可多整理不可漏）
          fresh = medias.filter((m) => !m.fav_time || m.fav_time > lastMark);
          const skipped = medias.length - fresh.length;
          if (skipped > 0) taskLog(`⏭️ 【${f.title}】跳过 ${skipped} 条上次整理前的旧视频`);
        }
      }
      all.push(...fresh);
      taskLog(`✅ 【${f.title}】待整理 ${fresh.length} 个视频（夹内共 ${medias.length} 个）`, 'ok');
    }
    state.task!.medias = all;
    state.task!.progress = { done: all.length, total: all.length, phase: 'fetch' };
    taskLog(`🎉 共待整理 ${all.length} 个视频（${folders.length} 个收藏夹）`, 'ok');

    // 2) 重复 + 失效检测
    const { unique, dups, dupExtras, invalid } = detectDupAndInvalid(all);
    state.task!.dupExtras = dupExtras;
    if (invalid.length) taskLog(`⚠️ 检测到 ${invalid.length} 个失效视频，将单独归入「${INVALID_FOLDER}」收藏夹`, 'warn');
    if (dupExtras.length) taskLog(`⚠️ 检测到 ${dups.length} 组跨夹重复（多余副本 ${dupExtras.length} 条）：整理保留最早收藏的一份，预览页可一键清理其余副本`, 'warn');

    // 3) 分类（有效视频）
    const result: CategoryMap = {};
    if (unique.length) {
      taskLog('🧠 开始分类（AI 为主 → 规则兜底）...');
      const existing = (await getMyFolders()).map((f) => f.title);
      const { result: aiResult, usedAi, mergeLogs } = await classifyAll(
        unique,
        existing,
        state.config.ai,
        state.config.rules,
        state.config.pref.aiBatchSize,
        userRequirement,
        mode,
        state.config.pref.rulesFirst,
        (done, total, phase) => {
          // 分类阶段进度：done=第几批, total=总批数（追加到抓取后的总进度展示）
          if (state.task) {
            state.task.progress = { done, total, phase };
          }
        },
        // AI 过程日志实时推送（批次开始/思维链摘要/遗漏/补充轮），不再等全部结束
        (msg) => taskLog(msg, msg.startsWith('⚠️') ? 'warn' : 'info'),
        // 新增：confirmTaxonomy 开启时传体系确认回调（阶段1 后暂停等 UI 确认）
        state.config.pref.confirmTaxonomy
          ? async (designed: DesignedCategory[]) => {
              // 暂存到 task 供 UI 渲染，等待用户确认事件
              if (state.task) {
                state.task.taxonomyConfirm = designed.map((c) => ({ ...c }));
                persistTask();
                // 等待 UI 触发的 resolve（通过自定义事件 + Promise）；刷新会重置 state.task，Promise 随之废弃无泄漏
                return new Promise<DesignedCategory[]>((resolve) => {
                  const handler = (e: Event) => {
                    const detail = (e as CustomEvent).detail;
                    if (detail?.type === 'taxonomy-confirm') {
                      window.removeEventListener('wb:taxonomy', handler);
                      resolve(detail.designed as DesignedCategory[]);
                    } else if (detail?.type === 'taxonomy-cancel') {
                      window.removeEventListener('wb:taxonomy', handler);
                      resolve(designed); // 取消则沿用原始
                    }
                  };
                  window.addEventListener('wb:taxonomy', handler);
                });
              }
              return designed;
            }
          : undefined,
      );
      Object.assign(result, aiResult);
      taskLog(`✅ 分类完成：${unique.length} 条${usedAi ? '（AI 已参与）' : '（规则分类）'}`, 'ok');
      mergeLogs.forEach((l) => taskLog(l, 'info'));
    }

    // 4) 失效视频单独一档（可移动入「失效视频」收藏夹）
    if (invalid.length) {
      result[INVALID_FOLDER] = invalid.map((m) => ({ ...m, category: INVALID_FOLDER }));
      taskLog(`📁 已建「${INVALID_FOLDER}」分组（${invalid.length} 条），确认后可移动到该收藏夹`, 'info');
    }

    if (!Object.keys(result).length) {
      taskLog('⚠️ 没有可整理的视频', 'warn');
      endTask();
      return;
    }

    state.task!.suggest = result;
    persistTask(); // 分类结果落盘：刷新/关页后预览可恢复
    taskLog('👇 请到「智能整理」页查看并调整分类，确认后再移动', 'info');
    endTask();
  } catch (e) {
    // 抓取/分类阶段失败：任务没有可恢复的价值，不落盘（避免恢复出残缺任务）
    taskLog(`❌ ${e instanceof Error ? e.message : String(e)}`, 'err');
    endTask(e instanceof Error ? e.message : String(e));
  }
}

/** 确认移动：建夹（复用已有）→ 按源收藏夹分组逐分类移动
 *  幂等设计：已成功移动的资源记入 appliedItems（持久化），中断后重跑自动跳过，
 *  切换 tab / 刷新 / 整页导航后都能从断点继续而不会重复移动
 *  全部成功后更新各源夹的增量基准（folderLastRun），下次增量只处理新收藏 */
export async function applySuggest(): Promise<{ moved: number; error: string }> {
  const suggest = state.task?.suggest;
  if (!suggest || !state.task) return { moved: 0, error: '' };
  const task = state.task;

  task.applying = true;
  // 待移动总量 = 非「未分类」分类中尚未移动过的条数（进度条分母；续跑时自动扣除已完成部分）
  const isApplied = (m: FavMedia) => task.appliedItems.includes(`${m.id}:${m.type}`);
  task.applyProgress = {
    done: 0,
    total: Object.entries(suggest).reduce(
      (s, [cat, items]) => (cat === UNC ? s : s + items.filter((m) => !isApplied(m)).length),
      0,
    ),
  };
  persistTask();
  let moved = 0;
  let error = '';
  try {
    const existingMap = new Map<string, number>();
    (await getMyFolders()).forEach((f) => existingMap.set(f.title, f.id));

    for (const [cat, items] of Object.entries(suggest)) {
      if (!items.length) continue;
      if (isBlocked()) throw new Error('触发风控冷却，剩余分类已暂停（可稍后续跑）');

      // 空分类跳过；未分类不移动（提示用户手动处理）
      if (cat === UNC) {
        taskLog(`⏭️ 跳过「${UNC}」：${items.length} 条未移动（请先手动归类）`, 'warn');
        continue;
      }

      let tarId = existingMap.get(cat);
      if (!tarId) {
        // 「失效视频」是系统归档夹，不受「允许新建收藏夹」开关限制
        if (!state.config.pref.allowAiCreate && cat !== INVALID_FOLDER) continue;
        taskLog(`📁 新建收藏夹【${cat}】...`);
        tarId = await createFolder(cat);
        existingMap.set(cat, tarId);
      }

      // 按源收藏夹分组（视频可能来自不同的收藏夹），剔除已移动过的（断点续跑幂等）
      const bySrc = groupBySrc(
        items.filter((m) => !task.appliedItems.includes(`${m.id}:${m.type}`)),
        task.folders[0]?.id,
      );

      for (const [srcId, group] of bySrc) {
        const resources = group.map((m) => `${m.id}:${m.type}`).join(',');
        taskLog(`🚚 移动 ${group.length} 个视频（来自${group[0]?.srcFolderName || '收藏夹'}）→ 【${cat}】`);
        await moveResources(srcId, tarId, resources);
        moved += group.length;
        task.applyProgress.done += group.length;
        task.appliedItems.push(...group.map((m) => `${m.id}:${m.type}`));
        persistTask(); // 每组移动成功即落盘，中断粒度最小化
        window.dispatchEvent(new CustomEvent('wb:tasklog'));
      }
    }

    const record = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
      time: Date.now(),
      sourceFolder: task.folders.map((f) => f.title).join(' + '),
      total: task.medias.length,
      moved,
      categories: Object.keys(suggest),
    };
    state.records = addRecord(record);
    // 成功（无异常）才推进增量基准；部分失败时保持旧基准，下次增量会重新覆盖未移动的部分
    for (const f of task.folders) {
      const maxFav = task.folderMaxFav[String(f.id)];
      if (maxFav) state.config.folderLastRun[String(f.id)] = maxFav;
    }
    persist();
    task.done = true;
    persistTask();
    taskLog(`🎉 整理完成：本次移动 ${moved} 个视频${task.appliedItems.length > moved ? `（含续跑前累计 ${task.appliedItems.length}）` : ''}，请刷新页面查看！`, 'ok');
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
    taskLog(`❌ ${error}（进度已保存，可重试继续移动剩余部分）`, 'err');
  } finally {
    task.applying = false;
    persistTask();
    window.dispatchEvent(new CustomEvent('wb:tasklog'));
  }
  return { moved, error };
}

/** 放弃当前任务（清空内存与持久化快照） */
export function discardTask(): void {
  state.task = null;
  persistTask();
}

/** 清理跨夹重复：把多余副本从各自源收藏夹移除（保留最早收藏的一份），返回移除数 */
export async function applyDedup(): Promise<number> {
  const task = state.task;
  if (!task || !task.dupExtras.length) return 0;

  task.applying = true;
  task.applyProgress = { done: 0, total: task.dupExtras.length };
  persistTask();
  let removed = 0;
  try {
    const bySrc = groupBySrc(task.dupExtras);
    for (const [srcId, group] of bySrc) {
      if (isBlocked()) throw new Error('触发风控冷却，剩余重复项已暂停');
      const resources = group.map((m) => `${m.id}:${m.type}`).join(',');
      taskLog(`🧹 从【${group[0]?.srcFolderName || srcId}】移除 ${group.length} 个重复副本`);
      await deleteResources(srcId, resources);
      removed += group.length;
      task.applyProgress.done += group.length;
      task.dupExtras = task.dupExtras.filter((m) => m.srcFolderId !== srcId);
      persistTask();
    }
    taskLog(`✅ 重复清理完成：共移除 ${removed} 个多余副本（保留了每组最早收藏的一份）`, 'ok');
  } catch (e) {
    taskLog(`❌ ${e instanceof Error ? e.message : String(e)}`, 'err');
  } finally {
    task.applying = false;
    persistTask();
    window.dispatchEvent(new CustomEvent('wb:tasklog'));
  }
  return removed;
}

// ============================================================
// 分类 MD 导入：跨浏览器迁移 / 交给外部 AI 对话整理后的回导
//  - 解析「## 分类名（N 个）」+「- [标题](url)（来自 源夹）」格式（即导出格式）
//  - 抓取本账号收藏夹建立 BV/av → 视频索引，把 MD 条目还原成可移动的任务
//  - 生成与普通整理一致的任务：预览 → 确认移动（含断点续跑）
// ============================================================

/** MD 中解析出的单个条目 */
interface MdPlanItem {
  bvid?: string;
  id?: number;
  title: string;
  src?: string; // 来源收藏夹名（可缺省）
}

/** 解析分类 MD：返回 [{分类名, 条目列表}]（保序） */
export function parseCategoryMarkdown(text: string): Array<{ cat: string; items: MdPlanItem[] }> {
  const plan: Array<{ cat: string; items: MdPlanItem[] }> = [];
  let cur: { cat: string; items: MdPlanItem[] } | null = null;
  // 行格式：- [标题](https://www.bilibili.com/video/BVxxx)（来自 源夹）——「来自」部分可省略
  // 标题用非贪婪匹配到第一个「](」：标题本身可能含 [ 或 ]（如「[双语] xxx」甚至以 [ 开头）
  const linkRe = /^[-*]\s*\[(.*?)\]\((https?:\/\/www\.bilibili\.com\/video\/(BV[0-9A-Za-z]+|\d+))[^)]*\)(.*)$/;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    const h = line.match(/^#{2,3}\s+(.+)$/);
    if (h) {
      // 去掉标题里的计数后缀「（12 个）」/「(12)」
      const cat = h[1].replace(/[（(]\s*\d+\s*个?\s*[)）]\s*$/, '').trim();
      if (cat) {
        cur = { cat, items: [] };
        plan.push(cur);
      }
      continue;
    }
    if (!cur) continue;
    const m = line.match(linkRe);
    if (!m) continue;
    const srcHit = m[4]?.match(/[（(]来自\s*(.+?)[)）]/);
    cur.items.push({
      title: m[1].trim(),
      bvid: m[3].startsWith('BV') ? m[3] : undefined,
      id: m[3].startsWith('BV') ? undefined : Number(m[3]),
      src: srcHit ? srcHit[1].trim() : undefined,
    });
  }
  return plan.filter((p) => p.items.length);
}

/**
 * 导入分类 MD 并构建整理任务（不调 AI）：
 * 抓取相关收藏夹 → 按 bvid/avid 还原视频 → 生成可预览可移动的任务
 */
export async function importMarkdownPlan(text: string): Promise<void> {
  if (state.task?.running || state.task?.applying) throw new Error('当前有任务在进行，请先完成或放弃');
  if (state.task?.suggest && !state.task.done) {
    if (!confirm('当前有一个未完成的整理任务（分类结果与移动进度会被丢弃）。确定导入新方案？')) return;
  }

  const plan = parseCategoryMarkdown(text);
  const totalItems = plan.reduce((s, p) => s + p.items.length, 0);
  if (!plan.length || !totalItems) {
    throw new Error('MD 中没有解析到分类与视频链接（需要「## 分类名」标题 +「- [标题](https://www.bilibili.com/video/BVxxx)」行，即本工具导出的格式）');
  }

  // 任务壳：mode=full（预览页行为一致），folders 抓取后回填
  state.task = {
    running: true,
    mode: 'full',
    folders: [],
    medias: [],
    suggest: null,
    dupExtras: [],
    folderMaxFav: {},
    logs: [],
    progress: { done: 0, total: totalItems, phase: 'fetch' },
    error: '',
    applying: false,
    appliedItems: [],
    applyProgress: { done: 0, total: 0 },
    done: false,
  };
  taskLog(`📥 MD 解析完成：${plan.length} 个分类 / ${totalItems} 条视频`);

  try {
    const folders = await getMyFolders();
    if (!folders.length) throw new Error('未获取到收藏夹列表（未登录或接口失败）');

    // 收集需要抓取的收藏夹：优先 MD 里标注的来源夹；缺失/匹配不上的走全库兜底
    const srcNames = [...new Set(plan.flatMap((p) => p.items.map((i) => i.src).filter(Boolean) as string[]))];
    const wanted = new Set(srcNames.map(normalizeName));
    let targets = folders.filter((f) => wanted.has(normalizeName(f.title)));
    const needFullScan = srcNames.length > targets.length || plan.some((p) => p.items.some((i) => !i.src));
    if (needFullScan) {
      taskLog('🔎 存在未标注来源或来源名匹配不上的条目，改为抓取全部收藏夹兜底匹配...', 'warn');
      targets = folders;
    }
    if (!targets.length) targets = folders;

    // 抓取并建立索引：bvid → media / id → media
    const byBvid = new Map<string, FavMedia>();
    const byId = new Map<number, FavMedia>();
    let fetched = 0;
    for (const f of targets) {
      taskLog(`📦 抓取收藏夹【${f.title}】...`);
      const medias = await fetchAllMedias(f.id, (done, total) => {
        state.task!.progress = { done: fetched + done, total: fetched + (total || done), phase: 'fetch' };
      });
      fetched += medias.length;
      medias.forEach((m) => {
        m.srcFolderId = f.id;
        m.srcFolderName = f.title;
        if (m.bvid && !byBvid.has(m.bvid)) byBvid.set(m.bvid, m);
        if (!byId.has(m.id)) byId.set(m.id, m);
      });
      taskLog(`✅ 【${f.title}】${medias.length} 条`, 'ok');
    }

    // 逐条还原
    const suggest: CategoryMap = {};
    const usedFolders = new Map<number, FavFolder>();
    const matched: FavMedia[] = [];
    let missed = 0;
    let missingSample: string[] = [];
    for (const { cat, items } of plan) {
      for (const it of items) {
        const src = (it.bvid && byBvid.get(it.bvid)) || (it.id != null && byId.get(it.id)) || undefined;
        if (!src) {
          missed++;
          if (missingSample.length < 5) missingSample.push(it.title);
          continue;
        }
        const media: FavMedia = { ...src, category: cat };
        if (src.srcFolderId != null) {
          const f = targets.find((t) => t.id === src.srcFolderId);
          if (f) usedFolders.set(f.id, f);
        }
        (suggest[cat] ||= []).push(media);
        matched.push(media);
      }
    }

    if (!matched.length) {
      throw new Error('MD 中的视频在当前账号的收藏夹里全部匹配失败（视频可能已取消收藏，或 MD 来自其他账号）');
    }
    state.task.folders = [...usedFolders.values()];
    state.task.medias = matched;
    state.task.suggest = suggest;
    persistTask();
    taskLog(`✅ 匹配成功 ${matched.length}/${totalItems} 条${missed ? `，跳过 ${missed} 条（未在收藏夹中找到）` : ''}`, 'ok');
    if (missingSample.length) taskLog(`⏭️ 未匹配示例：${missingSample.join('、')}`, 'warn');
    taskLog('👇 请到预览确认后移动（未匹配条目不会出现在预览中）', 'info');
    endTask();
  } catch (e) {
    taskLog(`❌ ${e instanceof Error ? e.message : String(e)}`, 'err');
    endTask(e instanceof Error ? e.message : String(e));
  }
}
