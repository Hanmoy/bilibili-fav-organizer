// ============================================================
// 视图：智能整理（模块 2）
//  - 从全局 state.task 渲染：任务后台运行，切换 tab 不中断
//  - 运行中：显示进度 + 日志（实时刷新）
//  - 完成：分类预览可编辑（改名/移视频/新建/删除分类）→ 确认移动
// ============================================================
import { state, persist, persistTask } from '../state';
import { runOrganizeTask, applySuggest, applyDedup, discardTask, INVALID_FOLDER } from '../task';
import { summarize, UNC } from '../service/classify';
import { cleanFolderInvalids } from '../service/bili';
import type { DesignedCategory } from '../service/ai';
import { Icons, esc, fmtNum, fmtTime, fmtDuration, downloadText } from '../utils/svg';
import { toast } from './settings';
import type { CategoryMap, FavMedia } from '../types';

let refreshTimer: number | null = null;
/** 阶段1 体系确认态的编辑缓冲（renderOrganize 重入不丢失编辑） */
let taxonomyEditBuffer: DesignedCategory[] | null = null;

/** 检查某分类是否有源夹集中度预警日志（A2 推送的 ⚠️ 预警） */
function hasSrcConcentrationWarning(cat: string, logs?: { msg: string }[]): boolean {
  if (!logs) return false;
  return logs.some((l) => l.msg.includes(`分类「${cat}」`) && l.msg.includes('疑似混入'));
}

/** 启动任务前从 DOM 同步「整理要求」到 config（不依赖 blur 时序） */
function syncRequirement(body: HTMLElement): void {
  const ta = body.querySelector<HTMLTextAreaElement>('#wb-requirement');
  if (!ta) return;
  const val = ta.value.trim();
  if (val !== state.config.pref.lastRequirement) {
    state.config.pref.lastRequirement = val;
    persist();
  }
}

export async function renderOrganize(body: HTMLElement): Promise<void> {
  // 清掉上一个定时器
  if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }

  const task = state.task;
  const folder = state.selectedFolders[0] || null;

  // 从未整理过：空态引导
  if (!task) {
    body.innerHTML = `
      <div class="wb-empty">${Icons.folder}
        <div>${folder ? '已选择 ' + state.selectedFolders.length + ' 个收藏夹' : '尚未选择收藏夹'}</div>
        <div style="margin-top:4px;font-size:12px;">${folder ? '选择整理方式，任务在后台运行，切换页面不中断' : '请先到「收藏夹总览」勾选一个或多个收藏夹'}</div>
        ${
          folder
            ? `<div class="wb-card" style="margin-top:14px;text-align:left;">
                <div class="wb-field" style="margin-bottom:8px;">
                  <label class="wb-label">整理要求（可选，会作为最高优先级指示传给 AI）</label>
                  <textarea class="wb-textarea" id="wb-requirement" placeholder="例：把 AI 相关的拆细一点；数学和编程分开；不要出现「其他」类…">${esc(state.config.pref.lastRequirement)}</textarea>
                  <div class="wb-hint">留空则由 AI 自主设计分类体系；内容会记住，下次整理自动沿用</div>
                </div>
                <div style="display:flex;flex-direction:column;gap:8px;align-items:center;">
                  <button class="wb-btn" data-start-full>${Icons.spark} 全量整理（重新分类，可新建收藏夹）</button>
                  <button class="wb-btn ghost" data-start-inc>${Icons.refresh} 增量分配（只处理新收藏，归入已有夹）</button>
                  <div style="font-size:12px;color:var(--wb-text-2);">${state.selectedFolders.map((f) => esc(f.title)).join('、')}</div>
                </div>
              </div>`
            : `<div style="margin-top:12px;"><button class="wb-btn" data-goto="overview">${Icons.box} 去选择收藏夹</button></div>`
        }
      </div>`;
    body.querySelector('[data-goto="overview"]')?.addEventListener('click', () => {
      document.querySelector<HTMLElement>('[data-tab="overview"]')?.click();
    });
    // 整理要求：失焦即保存（启动任务时从 config 读取）
    body.querySelector('#wb-requirement')?.addEventListener('blur', (e) => {
      state.config.pref.lastRequirement = (e.target as HTMLTextAreaElement).value.trim();
      persist();
    });
    body.querySelector('[data-start-full]')?.addEventListener('click', () => {
      syncRequirement(body);
      runOrganizeTask(state.selectedFolders, 'full');
      renderOrganize(body);
    });
    body.querySelector('[data-start-inc]')?.addEventListener('click', () => {
      syncRequirement(body);
      runOrganizeTask(state.selectedFolders, 'incremental');
      renderOrganize(body);
    });
    return;
  }

  // 阶段1 体系确认态（confirmTaxonomy 开启时，阶段1 后暂停供用户确认分类体系）
  // 规格未覆盖自行决策点：spec 写 `!task.running`，但暂停期 running 仍为 true（classifyAll 在 await Promise），
  // 故去掉 running 检查、置于 running 分支之前，确保暂停期确认 UI 可见。
  if (task.taxonomyConfirm?.length) {
    if (!taxonomyEditBuffer) taxonomyEditBuffer = task.taxonomyConfirm.map((c) => ({ ...c }));
    const editableCats = taxonomyEditBuffer;
    body.innerHTML = `
      <div class="wb-card">
        <div class="wb-card-title">${Icons.gear} 阶段1 分类体系确认</div>
        <div class="wb-hint">AI 设计了 ${editableCats.length} 个分类。可改名/删除/新增分类后确认，确认后才开始归类。</div>
        <div id="wb-tax-list">
          ${editableCats.map((c, i) => `
            <div class="wb-rule-edit">
              <input class="wb-input" data-tname="${i}" value="${esc(c.name)}" placeholder="分类名" />
              <input class="wb-input" data-tdesc="${i}" value="${esc(c.desc)}" placeholder="一句话定义" />
              <button class="wb-btn-mini ghost danger-text" data-tdel="${i}">${Icons.trash}</button>
            </div>`).join('')}
        </div>
        <div class="wb-btn-row">
          <button class="wb-btn-mini" id="wb-tax-add">＋ 新增分类</button>
          <button class="wb-btn" id="wb-tax-confirm">${Icons.check} 确认并开始归类</button>
          <button class="wb-btn ghost" id="wb-tax-cancel">沿用 AI 原始</button>
        </div>
      </div>`;
    // 同步编辑（改名/改定义）
    body.querySelectorAll('[data-tname]').forEach((el) => {
      el.addEventListener('input', () => { editableCats[Number((el as HTMLElement).dataset.tname)].name = (el as HTMLInputElement).value; });
    });
    body.querySelectorAll('[data-tdesc]').forEach((el) => {
      el.addEventListener('input', () => { editableCats[Number((el as HTMLElement).dataset.tdesc)].desc = (el as HTMLInputElement).value; });
    });
    body.querySelectorAll('[data-tdel]').forEach((b) => {
      b.addEventListener('click', () => { editableCats.splice(Number((b as HTMLElement).dataset.tdel), 1); renderOrganize(body); });
    });
    body.querySelector('#wb-tax-add')?.addEventListener('click', () => { editableCats.push({ name: '', desc: '' }); renderOrganize(body); });
    body.querySelector('#wb-tax-confirm')?.addEventListener('click', () => {
      const filtered = editableCats.filter((c) => c.name.trim());
      taxonomyEditBuffer = null;
      // 规格未覆盖自行决策点：确认/取消后必须清 taxonomyConfirm，否则 renderOrganize 重入仍命中确认态
      if (state.task) { state.task.taxonomyConfirm = undefined; persistTask(); }
      window.dispatchEvent(new CustomEvent('wb:taxonomy', { detail: { type: 'taxonomy-confirm', designed: filtered } }));
      renderOrganize(body);
    });
    body.querySelector('#wb-tax-cancel')?.addEventListener('click', () => {
      taxonomyEditBuffer = null;
      if (state.task) { state.task.taxonomyConfirm = undefined; persistTask(); }
      window.dispatchEvent(new CustomEvent('wb:taxonomy', { detail: { type: 'taxonomy-cancel' } }));
      renderOrganize(body);
    });
    return;
  }

  // 运行中：进度 + 日志
  if (task.running) {
    const pct = task.progress.total ? Math.round((task.progress.done / task.progress.total) * 100) : 0;
    // done=-1 表示阶段1（全局分类体系设计），该阶段无进度百分比
    const phaseText =
      task.progress.phase === 'ai' && task.progress.done === -1
        ? `AI 正在通读全部标题、设计分类体系…（约 30~90 秒，请稍候）`
        : task.progress.phase === 'ai'
          ? `AI 分类中…（第 ${task.progress.done}/${task.progress.total} 批）`
          : `抓取视频中… ${fmtNum(task.progress.done)}/${fmtNum(task.progress.total)}`;
    body.innerHTML = `
      <div class="wb-card">
        <div class="wb-card-title">${Icons.refresh} 整理进行中…</div>
        <div class="wb-hint">模式：${task.mode === 'incremental' ? '增量分配（不新建）' : '全量重分类'} · 源收藏夹：${task.folders.map((f) => esc(f.title)).join('、')}</div>
        <div class="wb-progress"><div style="width:${pct}%"></div></div>
        <div class="wb-hint" style="text-align:center;margin-top:6px;" id="wb-phase-text">${phaseText}</div>
        <div class="wb-log" id="wb-log" style="max-height:300px"></div>
      </div>`;
    renderLogs(body);
    refreshTimer = window.setInterval(() => {
      // 任务已完成 → 自动切换显示预览
      const t = state.task!;
      if (!t.running) {
        if (refreshTimer !== null) { clearInterval(refreshTimer); refreshTimer = null; }
        renderOrganize(body);
        return;
      }
      const pctEl = body.querySelector('.wb-progress > div');
      if (pctEl) {
        const np = t.progress.total ? Math.round((t.progress.done / t.progress.total) * 100) : 0;
        (pctEl as HTMLElement).style.width = `${np}%`;
      }
      const phaseEl = body.querySelector('#wb-phase-text');
      if (phaseEl) {
        phaseEl.textContent =
          t.progress.phase === 'ai' && t.progress.done === -1
            ? `AI 正在通读全部标题、设计分类体系…（约 30~90 秒，请稍候）`
            : t.progress.phase === 'ai'
              ? `AI 分类中…（第 ${t.progress.done}/${t.progress.total} 批）`
              : `抓取视频中… ${fmtNum(t.progress.done)}/${fmtNum(t.progress.total)}`;
      }
      renderLogs(body);
    }, 800);
    return;
  }

  // 完成：分类预览（可编辑）
  if (task.suggest) {
    renderSuggest(body, task.suggest);
    return;
  }

  // 无错误也无结果：本次没有待整理视频（常见于增量模式无新收藏）
  if (!task.error) {
    body.innerHTML = `
      <div class="wb-empty">${Icons.check}
        <div>本次没有需要整理的视频</div>
        <div style="margin-top:4px;font-size:12px;">${task.mode === 'incremental' ? '所选收藏夹在上次整理成功后没有新收藏，无需增量整理' : '所选收藏夹内没有可分类的视频'}</div>
        <div style="margin-top:12px;"><button class="wb-btn ghost" data-goto="overview">${Icons.box} 返回收藏夹总览</button></div>
      </div>`;
    body.querySelector('[data-goto="overview"]')?.addEventListener('click', () => {
      document.querySelector<HTMLElement>('[data-tab="overview"]')?.click();
    });
    return;
  }

  // 出错
  body.innerHTML = `
    <div class="wb-empty">${Icons.alert}
      <div>整理任务出错</div>
      <div style="margin-top:4px;font-size:12px;color:var(--wb-red)">${esc(task.error || '未知错误')}</div>
      <div style="margin-top:12px;"><button class="wb-btn" data-retry>${Icons.refresh} 重新整理</button></div>
    </div>`;
  body.querySelector('[data-retry]')?.addEventListener('click', () => {
    runOrganizeTask(state.task!.folders);
    renderOrganize(body);
  });
}

/** 渲染任务日志（追加式） */
function renderLogs(body: HTMLElement): void {
  const logEl = body.querySelector('#wb-log');
  if (!logEl || !state.task) return;
  const count = Number(logEl.getAttribute('data-count') || 0);
  const logs = state.task.logs;
  if (logs.length > count) {
    const frag = document.createDocumentFragment();
    for (let i = count; i < logs.length; i++) {
      const d = document.createElement('div');
      const lvl = logs[i].level;
      if (lvl === 'ok') d.className = 'ok';
      if (lvl === 'warn') d.className = 'warn';
      if (lvl === 'err') d.className = 'err';
      d.textContent = `➜ ${logs[i].msg}`;
      frag.appendChild(d);
    }
    logEl.appendChild(frag);
    logEl.setAttribute('data-count', String(logs.length));
    logEl.scrollTop = logEl.scrollHeight;
  }
}

/** 编辑后的分类数据：用稳定 id 定位（避免排序后下标错位） */
interface EditableCat {
  id: number;       // 稳定标识
  key: string;      // 展示名（可编辑）
  items: FavMedia[];
}

/** 渲染可编辑分类预览 */
function renderSuggest(body: HTMLElement, result: CategoryMap): void {
  // 转成可编辑结构
  let nextId = 0;
  let cats: EditableCat[] = Object.entries(result).map(([key, items]) => ({ id: nextId++, key, items: [...items] }));

  const catById = (id: number) => cats.find((c) => c.id === id);

  // 目标分类下拉选项（所有分类名 + 新建）
  // 第一个是占位「移动到…」，避免默认选中首项导致 change 不触发
  const moveOptions = (current: string, cid: number, mi: number) => `
    <select class="wb-move-select" data-move="${cid}:${mi}">
      <option value="" disabled selected>移动到…</option>
      ${cats
        .filter((c) => c.key !== current)
        .map((c) => `<option value="${esc(c.key)}">移到「${esc(c.key)}」</option>`)
        .join('')}
      <option value="__new__">＋ 新建分类…</option>
    </select>`;

  const { total, unc } = summarize(Object.fromEntries(cats.map((c) => [c.key, c.items])));

  function render() {
    // 排序：失效视频放最后（仅影响显示，id 定位不受影响）
    const sorted = [...cats].sort((a, b) => {
      if (a.key === INVALID_FOLDER) return 1;
      if (b.key === INVALID_FOLDER) return -1;
      return b.items.length - a.items.length;
    });
    const dupExtras = state.task?.dupExtras || [];
    const task = state.task;
    const applying = !!task?.applying;
    const done = !!task?.done;
    const appliedCount = task?.appliedItems.length || 0;
    const remaining = total - unc - appliedCount;
    // 中断续跑提示：有已移动记录但流程未完成（刷新/页面销毁/风控中断后恢复）
    const resumeHint =
      appliedCount > 0 && !done
        ? `<div class="wb-todo" style="margin-bottom:10px;">
            <div class="wb-todo-title">${Icons.alert} 检测到上次移动中断</div>
            <div class="wb-todo-item"><span class="dot green"></span><span>已成功移动 ${fmtNum(appliedCount)} 条（进度已保存）</span><span class="grow"></span><span>剩余约 ${fmtNum(Math.max(0, remaining))} 条未移动</span></div>
            <div style="font-size:12px;color:var(--wb-text-2);margin-top:4px;">点击下方按钮可从断点继续，不会重复移动已完成的视频</div>
          </div>`
        : '';

    body.innerHTML = `
      <div class="wb-card">
        <div class="wb-card-title">${Icons.spark} 分类预览（可编辑，确认后再移动）</div>
        <div class="wb-stats">
          <div class="wb-stat"><div class="wb-stat-num">${cats.length}</div><div class="wb-stat-label">分类数</div></div>
          <div class="wb-stat"><div class="wb-stat-num">${fmtNum(total)}</div><div class="wb-stat-label">视频总数</div></div>
          <div class="wb-stat"><div class="wb-stat-num" ${unc ? 'style="color:var(--wb-red)"' : ''}>${fmtNum(unc)}</div><div class="wb-stat-label">未分类</div></div>
        </div>
        ${resumeHint}
        ${
          dupExtras.length
            ? `<div class="wb-cat" style="border-color:#fde68a;background:#fffdf5;">
                <div class="wb-cat-head">
                  <span style="flex:1;font-weight:700;font-size:14px;">⚠️ 跨夹重复（多余副本 ${dupExtras.length} 条）</span>
                  <span class="wb-cat-count">${dupExtras.length}</span>
                  <button class="wb-btn-mini ghost" data-collapse="cat-dups">展开</button>
                  <button class="wb-btn-mini" id="wb-dedup-now" ${applying || done ? 'disabled' : ''}>清理重复项</button>
                </div>
                <div class="wb-cat-items" id="cat-dups" style="display:none;">
                  <div class="wb-hint" style="margin:6px 0;">以下副本将从所在收藏夹移除（每组保留最早收藏的一份参与分类）。这是删除操作，请确认列表无误后再清理。</div>
                  ${dupExtras
                    .map(
                      (m) => `
                    <div class="wb-media-item">
                      <div style="flex:1;min-width:0">
                        <div class="wb-media-title"><a href="https://www.bilibili.com/video/${m.bvid || m.id}" target="_blank" rel="noopener">${esc(m.title)}</a></div>
                        <div class="wb-media-meta">${m.srcFolderName ? '将移出【' + esc(m.srcFolderName) + '】' : ''}${m.fav_time ? ' · 收藏于 ' + fmtTime(m.fav_time) : ''}</div>
                      </div>
                    </div>`,
                    )
                    .join('')}
                </div>
              </div>`
            : ''
        }
        <div id="wb-cat-list"></div>
        ${
          applying
            ? `<div class="wb-progress" style="margin-top:10px;" id="wb-apply-progress"><div style="width:${task?.applyProgress.total ? Math.round((task.applyProgress.done / task.applyProgress.total) * 100) : 0}%"></div></div>
              <div class="wb-hint" style="text-align:center;margin-top:4px;" id="wb-apply-progress-text">正在移动… ${fmtNum(task?.applyProgress.done || 0)}/${fmtNum(task?.applyProgress.total || 0)}（${task?.applyProgress.total ? Math.round(((task?.applyProgress.done || 0) / task.applyProgress.total) * 100) : 0}%）· 保持本页在前台可全速执行</div>`
            : ''
        }
        <div class="wb-btn-row">
          <button class="wb-btn ghost" id="wb-add-cat" ${applying || done ? 'disabled' : ''}>${Icons.folder} 新建分类</button>
          <button class="wb-btn ghost" id="wb-export-md">${Icons.download} 导出分类预览 MD</button>
          ${
            done
              ? `<button class="wb-btn green" id="wb-apply-all" disabled>${Icons.check} 已完成（${fmtNum(appliedCount)} 条），刷新查看</button>`
              : applying
                ? `<button class="wb-btn green" id="wb-apply-all" disabled>${Icons.refresh} 正在移动…</button>`
                : appliedCount > 0
                  ? `<button class="wb-btn green" id="wb-apply-all">${Icons.check} 继续移动剩余视频（已完成 ${fmtNum(appliedCount)} 条）</button>`
                  : `<button class="wb-btn green" id="wb-apply-all">${Icons.check} 确认并移动全部视频</button>`
          }
          <button class="wb-btn danger" id="wb-discard" ${applying ? 'disabled' : ''}>${Icons.trash} 放弃本次整理</button>
        </div>
        <div class="wb-hint" style="margin-top:8px;">
          点击分类名可改名；视频可下拉移动到其他分类或新建分类；「未分类」不会移动，「失效视频」单独进失效收藏夹。移动进度会实时保存，中断后可续跑。移动是写操作，触发风控会自动暂停。
        </div>
        <div class="wb-log" id="wb-log" style="max-height:200px"></div>
      </div>`;

    const catList = body.querySelector('#wb-cat-list')!;
    catList.innerHTML = sorted
      .map((c) => {
        const isInvalid = c.key === INVALID_FOLDER;
        const isUnc = c.key === UNC;
        return `
        <div class="wb-cat ${isInvalid ? 'wb-cat-invalid' : ''} ${isUnc ? 'wb-cat-unc' : ''}">
          <div class="wb-cat-head">
            <input class="wb-cat-name-input" data-catid="${c.id}" value="${esc(c.key)}" title="点击修改分类名" />
            ${hasSrcConcentrationWarning(c.key, state.task?.logs) ? '<span title="疑似混入不相关内容，建议复查" style="color:var(--wb-red);flex-shrink:0;">⚠️</span>' : ''}
            <span class="wb-cat-count">${fmtNum(c.items.length)}</span>
            <button class="wb-btn-mini ghost" data-collapse="cat-${c.id}">${c.items.length > 5 ? '展开' : '收起'}</button>
            ${isInvalid ? `<button class="wb-btn-mini" id="wb-clean-invalid" ${applying || done ? 'disabled' : ''} title="直接清空失效视频（不可逆）">${Icons.trash} 一键清空</button>` : ''}
            ${isInvalid || isUnc ? '' : `<button class="wb-btn-mini ghost danger-text" data-delcat="${c.id}" title="删除该分类（视频移到未分类）">${Icons.trash}</button>`}
          </div>
          <div class="wb-cat-items" id="cat-${c.id}" style="${c.items.length > 5 ? 'display:none' : ''}">
            ${c.items
              .map((m, mi) => `
                <div class="wb-media-item">
                  <div style="flex:1;min-width:0">
                    <div class="wb-media-title"><a href="https://www.bilibili.com/video/${m.bvid || m.id}" target="_blank" rel="noopener">${esc(m.title)}</a></div>
                    <div class="wb-media-meta">${m.upper?.name ? esc(m.upper.name) + ' · ' : ''}${m.fav_time ? '收藏于 ' + fmtTime(m.fav_time) : ''}${m.duration ? ' · ' + fmtDuration(m.duration) : ''}${m.srcFolderName ? ' · 来自【' + esc(m.srcFolderName) + '】' : ''}</div>
                  </div>
                  <div style="flex-shrink:0;">${moveOptions(c.key, c.id, mi)}</div>
                </div>`)
              .join('')}
            ${c.items.length === 0 ? '<div class="wb-empty" style="padding:12px;">（空分类，确认后自动忽略）</div>' : ''}
          </div>
        </div>`;
      })
      .join('');

    // ---- 分类改名（失焦/回车保存） ----
    catList.querySelectorAll('[data-catid]').forEach((input) => {
      const el = input as HTMLInputElement;
      const apply = () => {
        const cid = Number(el.dataset.catid);
        const cat = catById(cid);
        if (!cat) return;
        const oldName = cat.key;
        const newName = el.value.trim() || oldName;
        if (newName !== oldName) {
          cat.key = newName;
          render();
        } else {
          el.value = oldName;
        }
      };
      el.addEventListener('blur', apply);
      el.addEventListener('keydown', (e) => { if (e.key === 'Enter') (el as HTMLInputElement).blur(); });
    });

    // ---- 折叠/展开 ----
    catList.querySelectorAll('[data-collapse]').forEach((h) => {
      h.addEventListener('click', () => {
        const target = document.getElementById((h as HTMLElement).dataset.collapse!);
        if (target) target.style.display = target.style.display === 'none' ? '' : 'none';
      });
    });

    // ---- 删除分类（视频移到未分类） ----
    catList.querySelectorAll('[data-delcat]').forEach((b) => {
      b.addEventListener('click', () => {
        const cid = Number((b as HTMLElement).dataset.delcat);
        const idx = cats.findIndex((c) => c.id === cid);
        if (idx < 0) return;
        const [removed] = cats.splice(idx, 1);
        if (removed && removed.items.length) {
          const uncCat = cats.find((c) => c.key === UNC);
          if (uncCat) uncCat.items.push(...removed.items);
          else cats.push({ id: nextId++, key: UNC, items: removed.items });
        }
        render();
      });
    });

    // ---- 一键清空失效视频（B站 clean 接口，不可逆；保留"移动到失效夹"双按钮） ----
    body.querySelector('#wb-clean-invalid')?.addEventListener('click', async () => {
      const invalidItems = cats.find((c) => c.key === INVALID_FOLDER)?.items || [];
      if (!invalidItems.length || state.task?.applying || state.task?.done) return;
      if (!confirm(`⚠️ 确认清空 ${invalidItems.length} 个失效视频？此操作不可逆，将直接从收藏夹删除（非移动）。建议先确认列表均为失效视频。`)) return;
      try {
        // 失效视频可能来自多个源夹，逐夹 clean
        const bySrc = new Map<number, FavMedia[]>();
        for (const m of invalidItems) {
          const sid = m.srcFolderId ?? state.task?.folders[0]?.id;
          if (sid == null) continue;
          if (!bySrc.has(sid)) bySrc.set(sid, []);
          bySrc.get(sid)!.push(m);
        }
        let cleaned = 0;
        for (const [srcId] of bySrc) {
          await cleanFolderInvalids(srcId);
          cleaned += bySrc.get(srcId)!.length;
        }
        // 从预览移除已清空的失效视频
        const invalidCat = cats.find((c) => c.key === INVALID_FOLDER);
        if (invalidCat) invalidCat.items = [];
        toast(`已清空 ${cleaned} 个失效视频`);
        render();
      } catch (e) {
        toast(`清空失败：${e instanceof Error ? e.message : e}`);
      }
    });

    // ---- 移动视频到其他分类 / 新建分类 ----
    catList.querySelectorAll('[data-move]').forEach((sel) => {
      sel.addEventListener('change', () => {
        const [cid, mi] = (sel as HTMLSelectElement).dataset.move!.split(':').map(Number);
        const target = (sel as HTMLSelectElement).value;
        // 占位项「移动到…」为禁用态，理论不会到这里；防御处理
        if (!target) { (sel as HTMLSelectElement).value = ''; return; }
        const srcCat = catById(cid);
        if (!srcCat || mi < 0 || mi >= srcCat.items.length) { render(); return; }
        const [m] = srcCat.items.splice(mi, 1);
        if (!m) { render(); return; }
        if (target === '__new__') {
          const name = prompt('新分类名：', '');
          if (name && name.trim()) {
            const existing = cats.find((c) => c.key === name.trim());
            if (existing) existing.items.push(m);
            else cats.push({ id: nextId++, key: name.trim(), items: [m] });
          } else {
            srcCat.items.splice(mi, 0, m); // 取消，放回原位
          }
        } else {
          const targetCat = cats.find((c) => c.key === target);
          if (targetCat) targetCat.items.push(m);
          else srcCat.items.splice(mi, 0, m); // 目标不存在，放回
        }
        render();
      });
    });

    // ---- 新建分类 ----
    body.querySelector('#wb-add-cat')!.addEventListener('click', () => {
      const name = prompt('新分类名：', '');
      if (name && name.trim() && !cats.some((c) => c.key === name.trim())) {
        cats.push({ id: nextId++, key: name.trim(), items: [] });
      }
      render();
    });

    // ---- 导出分类预览为 MD（便于复盘分类规则 / 交给 AI 反思） ----
    body.querySelector('#wb-export-md')!.addEventListener('click', () => {
      const mode = state.task?.mode === 'incremental' ? '增量分配' : '全量重分类';
      const lines: string[] = [];
      lines.push(`# 分类预览导出`);
      lines.push('');
      lines.push(`- 时间：${new Date().toLocaleString('zh-CN')}`);
      lines.push(`- 模式：${mode}`);
      lines.push(`- 分类数：${cats.length}，视频总数：${fmtNum(total)}，未分类：${fmtNum(unc)}`);
      lines.push('');
      for (const c of cats) {
        lines.push(`## ${c.key}（${c.items.length} 个）`);
        lines.push('');
        for (const m of c.items) {
          const url = `https://www.bilibili.com/video/${m.bvid || m.id}`;
          const src = m.srcFolderName ? `（来自 ${m.srcFolderName}）` : '';
          lines.push(`- [${m.title}](${url})${src}`);
        }
        lines.push('');
      }
      downloadText(`分类预览-${new Date().toISOString().slice(0, 10)}.md`, lines.join('\n'));
      toast('MD 已导出：可导入本工具恢复整理，也可交给 AI 对话调整后导回（保持「## 分类名」+ 链接行格式）');
    });

    // ---- 清理跨夹重复（删除操作，双重确认） ----
    body.querySelector('#wb-dedup-now')?.addEventListener('click', async () => {
      const extras = state.task?.dupExtras || [];
      if (!extras.length || state.task?.applying || state.task?.done) return;
      if (!confirm(`确认从源收藏夹移除 ${extras.length} 个重复副本？（每组保留最早收藏的一份，此操作不可撤销）`)) return;
      render(); // 立即进入 applying 态（按钮禁用），后续由轮询恢复
      const removed = await applyDedup();
      render(); // dupExtras 已更新/按钮恢复
      renderLogs(body); // render 重建了日志容器，重新填充
      if (removed > 0) toast(`已移除 ${removed} 个重复副本`);
    });

    // ---- 确认移动（含断点续跑：applySuggest 按条目幂等跳过已移动的） ----
    body.querySelector('#wb-apply-all')?.addEventListener('click', async () => {
      if (state.task?.applying || state.task?.done) return;
      // 回写编辑结果到 state
      if (state.task) {
        state.task.suggest = Object.fromEntries(
          cats.map((c) => [c.key, c.items]),
        ) as CategoryMap;
      }
      render(); // 立即进入 applying 态
      await applySuggest();
      render(); // done / 恢复可续跑态
      renderLogs(body);
      if (state.task?.done) toast(`整理完成，共移动 ${state.task.appliedItems.length} 条`);
    });

    // ---- 放弃本次整理（清空任务与持久化快照） ----
    body.querySelector('#wb-discard')?.addEventListener('click', () => {
      if (state.task?.applying) return;
      const movedSoFar = state.task?.appliedItems.length || 0;
      const msg = movedSoFar
        ? `已移动的 ${movedSoFar} 条不会回退（仅放弃剩余部分与本次预览），确认放弃？`
        : '确认放弃本次整理？（分类结果将被清空）';
      if (!confirm(msg)) return;
      discardTask();
      renderOrganize(body);
    });

    // ---- applying 期间轮询：进度条/文本轻量更新，结束时才整页重绘 ----
    if (state.task?.applying && refreshTimer === null) {
      refreshTimer = window.setInterval(() => {
        const t = state.task;
        if (!t) {
          if (refreshTimer !== null) { clearInterval(refreshTimer); refreshTimer = null; }
          return;
        }
        if (t.applying) {
          const { done, total } = t.applyProgress;
          const pct = total ? Math.round((done / total) * 100) : 0;
          const bar = body.querySelector('#wb-apply-progress > div') as HTMLElement | null;
          if (bar) bar.style.width = `${pct}%`;
          const txt = body.querySelector('#wb-apply-progress-text') as HTMLElement | null;
          if (txt) txt.textContent = `正在移动… ${fmtNum(done)}/${fmtNum(total)}（${pct}%）· 保持本页在前台可全速执行`;
          return;
        }
        if (refreshTimer !== null) { clearInterval(refreshTimer); refreshTimer = null; }
        render();
      }, 500);
    }
  }

  render();
}
