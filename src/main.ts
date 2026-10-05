// ============================================================
// B站收藏整理台 - 入口
// 注入 B 站页面右下角浮动按钮，点击展开工作台面板
// ============================================================
import './style.css';
import { state, persist } from './state';
import { renderOverview } from './views/overview';
import { renderOrganize } from './views/organize';
import { renderSettings, toast } from './views/settings';
import { renderHistory } from './views/history';
import { getBiliAuth, getRiskStatus, isBlocked } from './service/bili';
import { Icons, esc, fmtNum, fmtTime } from './utils/svg';

// 构建时由 vite.config.ts 的 define 注入，与 userscript 版本号同源
declare const __WB_VERSION__: string;

let panelOpen = false;

function ensureRoot(): { fab: HTMLElement; panel: HTMLElement } {
  const rootId = 'wb-favorg-root';
  let root = document.getElementById(rootId) as HTMLElement | null;
  if (!root) {
    root = document.createElement('div');
    root.id = rootId;
    root.innerHTML = `
      <div id="wb-favorg-fab" title="B站收藏整理台">${Icons.spark}</div>
      <div id="wb-favorg-panel">
        <div class="wb-fh">
          <div class="wb-fh-title">${Icons.star} B站收藏整理台<span class="wb-fh-ver">v${__WB_VERSION__}</span></div>
          <button class="wb-fh-close" id="wb-close" title="收起">×</button>
        </div>
        <div class="wb-tabs">
          <button class="wb-tab active" data-tab="overview">${Icons.box} 收藏夹</button>
          <button class="wb-tab" data-tab="organize">${Icons.spark} 智能整理</button>
          <button class="wb-tab" data-tab="history">${Icons.clock} 记录</button>
          <button class="wb-tab" data-tab="settings">${Icons.gear} 设置</button>
        </div>
        <div class="wb-body" id="wb-body"></div>
        <div class="wb-foot">
          <span id="wb-foot-login"></span>
          <span id="wb-foot-task" style="display:none;cursor:pointer;color:var(--wb-pink);font-weight:600;">${Icons.refresh} 整理中…</span>
          <span class="wb-sync" id="wb-sync"><span class="dot"></span><span id="wb-sync-text">本地存储</span></span>
        </div>
      </div>`;
    document.body.appendChild(root);

    // 事件绑定
    (root.querySelector('#wb-favorg-fab') as HTMLElement).addEventListener('click', togglePanel);
    (root.querySelector('#wb-close') as HTMLElement).addEventListener('click', closePanel);
    root.querySelectorAll('.wb-tab').forEach((t) => {
      t.addEventListener('click', () => switchTab((t as HTMLElement).dataset.tab!));
    });
  }
  return { fab: root.querySelector('#wb-favorg-fab') as HTMLElement, panel: root.querySelector('#wb-favorg-panel') as HTMLElement };
}

function togglePanel(): void {
  panelOpen ? closePanel() : openPanel();
}

function closePanel(): void {
  panelOpen = false;
  const panel = document.getElementById('wb-favorg-panel');
  if (panel) panel.classList.remove('open');
  document.getElementById('wb-favorg-root')?.classList.remove('panel-open');
}

async function openPanel(): Promise<void> {
  panelOpen = true;
  const { fab, panel } = ensureRoot();
  panel.classList.add('open');
  // 面板展开时隐藏悬浮按钮，避免重叠抢点击；关闭后由 CSS 过渡恢复
  fab.closest('#wb-favorg-root')?.classList.add('panel-open');
  updateFoot();
  switchTab('overview');
}

async function switchTab(tab: string): Promise<void> {
  ensureRoot();
  document.querySelectorAll('.wb-tab').forEach((t) => t.classList.toggle('active', (t as HTMLElement).dataset.tab === tab));
  const body = document.getElementById('wb-body')!;
  body.innerHTML = '<div class="wb-empty">加载中…</div>';
  switch (tab) {
    case 'overview': await renderOverview(body); break;
    case 'organize': await renderOrganize(body); break;
    case 'history': await renderHistory(body); break;
    case 'settings': await renderSettings(body); break;
  }
  updateFoot();
}

function updateFoot(): void {
  const loginEl = document.getElementById('wb-foot-login');
  const syncEl = document.getElementById('wb-sync');
  if (!loginEl || !syncEl) return;

  const auth = getBiliAuth();
  loginEl.textContent = auth ? `已登录 ${auth.mid}` : '未登录';
  loginEl.style.color = auth ? 'var(--wb-text-2)' : 'var(--wb-red)';

  // 任务运行状态（任意 tab 可见，点击跳转整理页）
  const taskEl = document.getElementById('wb-foot-task');
  if (taskEl) {
    const running = state.task?.running;
    taskEl.style.display = running ? 'inline' : 'none';
    taskEl.onclick = running
      ? () => document.querySelector<HTMLElement>('[data-tab="organize"]')?.click()
      : null;
  }

  const risk = getRiskStatus();
  if (isBlocked()) {
    syncEl.classList.add('offline');
    syncEl.querySelector('#wb-sync-text')!.textContent = `风控冷却中 ${risk.level === 'ip' ? '(IP)' : '(账号)'}`;
  } else {
    syncEl.classList.remove('offline');
    syncEl.querySelector('#wb-sync-text')!.textContent = '本地存储';
  }
}

// 任务状态变化时刷新页脚（后台任务更新不经过 switchTab）
window.addEventListener('wb:tasklog', () => {
  updateFoot();
  // 任务刚完成 → 自动切到整理页展示预览
  const t = state.task;
  if (t && !t.running && t.suggest) {
    const activeTab = document.querySelector('.wb-tab.active')?.getAttribute('data-tab');
    if (activeTab !== 'organize') {
      document.querySelector<HTMLElement>('[data-tab="organize"]')?.click();
    }
  }
});

// ---------- 启动 ----------
function main(): void {
  ensureRoot();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', main);
} else {
  main();
}
