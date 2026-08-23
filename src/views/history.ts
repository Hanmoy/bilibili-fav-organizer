// ============================================================
// 视图：整理记录（模块 3）—— 历史记录 + 单条/全部导出 + 分类 MD 导入
// ============================================================
import { state } from '../state';
import { exportBackup } from '../storage/store';
import { importMarkdownPlan } from '../task';
import { Icons, esc, fmtNum, fmtTime, downloadText, readFileText } from '../utils/svg';
import { toast } from './settings';
import type { OrganizeRecord } from '../types';

/** 单条/全部记录导出为 MD（人读格式） */
function recordsToMarkdown(records: OrganizeRecord[]): string {
  const lines: string[] = ['# 整理记录导出', ''];
  for (const r of records) {
    lines.push(`## ${r.sourceFolder}（${r.categories?.length || 0} 个分类）`);
    lines.push('');
    lines.push(`- 时间：${new Date(r.time).toLocaleString('zh-CN')}`);
    lines.push(`- 处理：${fmtNum(r.total)} 条 · 已移动 ${fmtNum(r.moved)} 条`);
    lines.push(`- 分类：${(r.categories || []).join('、') || '（无）'}`);
    lines.push('');
  }
  return lines.join('\n');
}

export async function renderHistory(body: HTMLElement): Promise<void> {
  const records = state.records;

  body.innerHTML = `
    <div class="wb-card">
      <div class="wb-card-title">${Icons.clock} 整理记录</div>
      <div class="wb-btn-row" style="margin-top:0;">
        <button class="wb-btn ghost" id="wb-h-export-json">${Icons.download} 导出全部（JSON 备份）</button>
        <button class="wb-btn ghost" id="wb-h-export-md">${Icons.download} 导出全部（MD）</button>
        <button class="wb-btn" id="wb-h-import-md">${Icons.upload} 导入分类 MD</button>
        <input type="file" id="wb-h-import-file" accept=".md,.markdown,text/markdown" style="display:none" />
      </div>
      <div class="wb-hint" style="margin-top:6px;">
        「导入分类 MD」可加载分类预览导出的 .md 文件：跨浏览器迁移整理结果，或把 MD 交给任意 AI 对话整理后导回（保持「## 分类名」+ 链接行格式即可）。导入后进入预览，确认才会移动。
      </div>
      <div id="wb-rec-list"></div>
    </div>`;

  body.querySelector('#wb-h-export-json')!.addEventListener('click', () => {
    downloadText(`organize-records-${new Date().toISOString().slice(0, 10)}.json`, exportBackup());
  });
  body.querySelector('#wb-h-export-md')!.addEventListener('click', () => {
    downloadText(`organize-records-${new Date().toISOString().slice(0, 10)}.md`, recordsToMarkdown(records));
    toast('MD 已导出');
  });

  // 导入分类 MD：构建任务 → 自动跳转智能整理预览
  body.querySelector('#wb-h-import-md')!.addEventListener('click', () => {
    (body.querySelector('#wb-h-import-file') as HTMLInputElement).click();
  });
  body.querySelector('#wb-h-import-file')!.addEventListener('change', async (e) => {
    const file = (e.target as HTMLInputElement).files?.[0];
    if (!file) return;
    try {
      const text = await readFileText(file);
      await importMarkdownPlan(text);
      document.querySelector<HTMLElement>('[data-tab="organize"]')?.click();
    } catch (err) {
      alert(`导入失败：${err instanceof Error ? err.message : err}`);
      if (state.task && !state.task.running && !state.task.suggest && state.task.error) {
        // 导入过程半途失败：清掉残缺任务壳
        state.task = null;
      }
    }
  });

  const listEl = body.querySelector('#wb-rec-list')!;
  if (!records.length) {
    listEl.innerHTML = `
      <div class="wb-empty">${Icons.clock}
        <div>暂无整理记录</div>
        <div style="margin-top:4px;font-size:12px;">去「智能整理」跑一次，这里就会留下完整记录</div>
      </div>`;
    return;
  }

  listEl.innerHTML = records
    .map(
      (r, i) => `
      <div class="wb-rec">
        <div class="wb-rec-top">
          <span style="font-weight:700;font-size:14px;">${esc(r.sourceFolder)}</span>
          <span class="wb-rec-time">${fmtTime(r.time)}</span>
        </div>
        <div style="font-size:12px;color:var(--wb-text-2);margin-bottom:6px;">共 ${fmtNum(r.total)} 条 · 已移动 ${fmtNum(r.moved)} 条</div>
        <div class="wb-rec-tags">${(r.categories || []).map((c) => `<span class="wb-tag">${esc(c)}</span>`).join('')}</div>
        <div class="wb-btn-row" style="margin-top:8px;">
          <button class="wb-btn-mini ghost" data-export-one="${i}">${Icons.download} 导出本条 MD</button>
        </div>
      </div>`,
    )
    .join('');

  listEl.querySelectorAll('[data-export-one]').forEach((b) => {
    b.addEventListener('click', () => {
      const idx = Number((b as HTMLElement).dataset.exportOne);
      const r = records[idx];
      if (!r) return;
      downloadText(`整理记录-${new Date(r.time).toISOString().slice(0, 10)}.md`, recordsToMarkdown([r]));
      toast('本条记录 MD 已导出');
    });
  });
}
