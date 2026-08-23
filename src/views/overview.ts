// ============================================================
// 视图：收藏夹总览（模块 1）
//  - 多选收藏夹（checkbox），支持批量整理
//  - 显示重复 / 失效检测入口
// ============================================================
import { state } from '../state';
import { getMyFolders, getBiliAuth, isBlocked, getRiskStatus } from '../service/bili';
import { runOrganizeTask } from '../task';
import { Icons, esc, fmtNum } from '../utils/svg';
import type { FavFolder } from '../types';

export async function renderOverview(body: HTMLElement): Promise<void> {
  const auth = getBiliAuth();
  if (!auth) {
    body.innerHTML = `
      <div class="wb-empty">
        ${Icons.lock}
        <div>未检测到 B 站登录态（缺少 DedeUserID / bili_jct）</div>
        <div style="margin-top:12px"><button class="wb-btn" id="wb-refresh-login">刷新检测</button></div>
      </div>`;
    body.querySelector('#wb-refresh-login')!.addEventListener('click', () => renderOverview(body));
    return;
  }

  body.innerHTML = `
    <div class="wb-stats">
      <div class="wb-stat"><div class="wb-stat-num" id="wb-ov-folders">–</div><div class="wb-stat-label">收藏夹</div></div>
      <div class="wb-stat"><div class="wb-stat-num" id="wb-ov-videos">–</div><div class="wb-stat-label">收藏视频</div></div>
      <div class="wb-stat"><div class="wb-stat-num" id="wb-ov-risk">正常</div><div class="wb-stat-label">风控状态</div></div>
    </div>
    <div class="wb-card">
      <div class="wb-card-title">${Icons.box} 我的收藏夹 <span style="font-size:12px;color:var(--wb-text-2);font-weight:400;">（勾选可多选，支持批量整理）</span></div>
      <div class="wb-btn-row" id="wb-batch-bar" style="margin-bottom:10px;">
        <button class="wb-btn" id="wb-organize-selected" disabled>${Icons.spark} 全量整理（<span id="wb-selected-count">0</span>）</button>
        <button class="wb-btn ghost" id="wb-organize-incremental" disabled>${Icons.refresh} 增量分配</button>
        <button class="wb-btn ghost" id="wb-select-all">全选</button>
        <button class="wb-btn ghost" id="wb-clear-select">清空</button>
      </div>
      <div id="wb-folder-list"><div class="wb-empty">加载中…</div></div>
    </div>
    <div class="wb-hint" style="padding:0 4px;">先勾选要整理的收藏夹（可多选），再点「全量整理」（AI 重新分类，可新建夹）或「增量分配」（只处理上次整理后新收藏的视频，归入已有夹）。整理时会自动检测重复与失效视频，重复副本可在预览中一键清理。</div>`;

  // 风控状态
  const riskEl = body.querySelector('#wb-ov-risk') as HTMLElement;
  const risk = getRiskStatus();
  riskEl.textContent = isBlocked() ? '冷却中' : '正常';
  riskEl.style.color = isBlocked() ? 'var(--wb-red)' : '';

  let folders: FavFolder[] = [];
  let loadError = '';
  try {
    folders = await getMyFolders();
  } catch (e) {
    // 区分「加载失败」与「真的没有收藏夹」，避免误导排障
    loadError = e instanceof Error ? e.message : String(e);
  }

  const totalVideos = folders.reduce((s, f) => s + (f.media_count || 0), 0);
  body.querySelector('#wb-ov-folders')!.textContent = loadError ? '–' : fmtNum(folders.length);
  body.querySelector('#wb-ov-videos')!.textContent = loadError ? '–' : fmtNum(totalVideos);

  const listEl = body.querySelector('#wb-folder-list')!;
  if (loadError) {
    listEl.innerHTML = `
      <div class="wb-empty">${Icons.alert}
        <div style="color:var(--wb-red);">收藏夹加载失败：${esc(loadError)}</div>
        <div style="margin-top:4px;font-size:12px;">可能是网络波动或触发风控，稍后会自动恢复</div>
        <div style="margin-top:12px"><button class="wb-btn" id="wb-retry-folders">${Icons.refresh} 重试</button></div>
      </div>`;
    listEl.querySelector('#wb-retry-folders')!.addEventListener('click', () => renderOverview(body));
    return;
  }
  if (!folders.length) {
    listEl.innerHTML = `<div class="wb-empty">${Icons.box}<div>暂无收藏夹，先去 B 站收藏几个视频吧</div></div>`;
    return;
  }

  const selectedSet = new Set<number>(state.selectedFolders.map((f) => f.id));

  function renderList() {
    listEl.innerHTML = folders
      .map(
        (f) => `
      <div class="wb-folder-item" data-fid="${f.id}">
        <label class="wb-check" title="选择该收藏夹">
          <input type="checkbox" data-check="${f.id}" ${selectedSet.has(f.id) ? 'checked' : ''} />
          <span></span>
        </label>
        <div class="wb-folder-icon">${Icons.box}</div>
        <div class="wb-folder-info">
          <div class="wb-folder-name">${esc(f.title)}</div>
          <div class="wb-folder-meta">${fmtNum(f.media_count || 0)} 个视频 · ${f.attr === 1 ? '私密' : '公开'}</div>
        </div>
      </div>`,
      )
      .join('');
    updateBatchBar();
  }

  function updateBatchBar() {
    const countEl = body.querySelector('#wb-selected-count')!;
    state.selectedFolders = folders.filter((f) => selectedSet.has(f.id));
    countEl.textContent = String(state.selectedFolders.length);
    const hasSel = state.selectedFolders.length > 0;
    const fullBtn = body.querySelector('#wb-organize-selected') as HTMLButtonElement;
    const incBtn = body.querySelector('#wb-organize-incremental') as HTMLButtonElement;
    fullBtn.disabled = !hasSel;
    incBtn.disabled = !hasSel;
  }

  renderList();

  // 勾选切换
  listEl.addEventListener('change', (e) => {
    const target = e.target as HTMLInputElement;
    if (target.matches('[data-check]')) {
      const id = Number(target.dataset.check);
      if (target.checked) selectedSet.add(id);
      else selectedSet.delete(id);
      updateBatchBar();
    }
  });

  body.querySelector('#wb-select-all')!.addEventListener('click', () => {
    folders.forEach((f) => selectedSet.add(f.id));
    renderList();
  });
  body.querySelector('#wb-clear-select')!.addEventListener('click', () => {
    selectedSet.clear();
    renderList();
  });
  body.querySelector('#wb-organize-selected')!.addEventListener('click', () => {
    state.selectedFolders = folders.filter((f) => selectedSet.has(f.id));
    if (!state.selectedFolders.length) return;
    // 全量重分类：合并所有视频 → AI 整体分类 → 可新建收藏夹
    runOrganizeTask(state.selectedFolders, 'full');
    document.querySelector<HTMLElement>('[data-tab="organize"]')?.click();
  });
  body.querySelector('#wb-organize-incremental')!.addEventListener('click', () => {
    state.selectedFolders = folders.filter((f) => selectedSet.has(f.id));
    if (!state.selectedFolders.length) return;
    // 增量分配：只把所选夹里的视频分配到已有收藏夹，不新建
    runOrganizeTask(state.selectedFolders, 'incremental');
    document.querySelector<HTMLElement>('[data-tab="organize"]')?.click();
  });
}
