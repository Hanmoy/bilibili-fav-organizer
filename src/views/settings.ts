// ============================================================
// 视图：设置（AI 配置 / 分类规则 / 整理偏好 / 数据备份）
// ============================================================
import { state, persist } from '../state';
import { exportBackup, parseBackup, importBackup, clearAllData, DEFAULT_CONFIG, loadMoveRecords } from '../storage/store';
import { aiTestConnection } from '../service/ai';
import { validateRules, testRules } from '../service/classify';
import { Icons, esc, downloadText, readFileText, uid } from '../utils/svg';
import type { ClassifyRule } from '../types';

export async function renderSettings(body: HTMLElement): Promise<void> {
  const { config } = state;

  body.innerHTML = `
    <div class="wb-card">
      <div class="wb-card-title">${Icons.spark} AI 配置（OpenAI 兼容，自带 Key）</div>
      <div class="wb-field">
        <label class="wb-label">API 地址 (baseUrl)</label>
        <input class="wb-input" id="wb-set-baseurl" value="${esc(config.ai.baseUrl)}" placeholder="https://api.deepseek.com/v1" />
        <div class="wb-hint">支持 DeepSeek / 通义千问 / Kimi / OpenAI 等任意 OpenAI 兼容接口</div>
      </div>
      <div class="wb-field">
        <label class="wb-label">API Key</label>
        <input class="wb-input" id="wb-set-key" type="password" value="${esc(config.ai.apiKey)}" placeholder="sk-..." />
        <div class="wb-hint">仅保存在本机浏览器（GM 存储），不会上传到任何服务器</div>
      </div>
      <div class="wb-field">
        <label class="wb-label">模型</label>
        <input class="wb-input" id="wb-set-model" value="${esc(config.ai.model)}" placeholder="deepseek-chat" />
      </div>
      <div class="wb-field">
        <label class="wb-toggle" style="justify-content:space-between;">
          <span class="wb-label" style="margin:0;">启用 AI 辅助分类</span>
          <input type="checkbox" id="wb-set-ai-enabled" ${config.ai.enabled ? 'checked' : ''} />
          <span class="track"></span>
        </label>
      </div>
      <div class="wb-btn-row">
        <button class="wb-btn" id="wb-save-ai">${Icons.check} 保存 AI 配置</button>
        <button class="wb-btn ghost" id="wb-test-ai">${Icons.spark} 测试连接</button>
      </div>
      <div class="wb-log" id="wb-ai-log" style="display:none"></div>
    </div>

    <div class="wb-card">
      <div class="wb-card-title">${Icons.folder} 分类规则（规则优先，确定性兜底）</div>
      <div id="wb-rule-list"></div>
<div class="wb-btn-row">
          <button class="wb-btn ghost" id="wb-add-rule">${Icons.spark} 添加规则</button>
          <button class="wb-btn ghost" id="wb-reset-rules">恢复默认规则</button>
          <button class="wb-btn ghost" id="wb-gen-rule-from-moves">🔧 从移动记录生成规则</button>
        </div>
      <div class="wb-hint" style="margin-top:6px;">规则先行命中，AI 只处理规则未命中的视频；即使 AI 不可用也不会把整批丢进「未分类」。</div>
      <div class="wb-rule-test" id="wb-rule-test-panel">
        <button class="wb-btn ghost" id="wb-rule-test-toggle">${Icons.search} 测试规则</button>
        <div id="wb-rule-test-body" style="display:none">
          <textarea class="wb-textarea wb-rule-test-in" id="wb-rule-test-input" placeholder="每行一个视频标题（默认填入上次整理的视频标题），点下方测试看命中情况"></textarea>
          <div class="wb-btn-row">
            <button class="wb-btn-mini" id="wb-rule-test-run">测试命中</button>
            <button class="wb-btn-mini ghost" id="wb-rule-test-fetch">抓取选中收藏夹标题</button>
          </div>
          <div id="wb-rule-test-out"></div>
        </div>
      </div>
    </div>

    <div class="wb-card">
      <div class="wb-card-title">${Icons.gear} 整理偏好</div>
      <div class="wb-hint" style="margin-bottom:10px;">整理策略：默认 AI 处理全部视频，规则仅在无 AI 时兜底；开启「规则优先」后规则命中的视频不再送 AI。</div>
      <div class="wb-field">
        <label class="wb-toggle" style="justify-content:space-between;">
          <span class="wb-label" style="margin:0;">允许新建收藏夹</span>
          <input type="checkbox" id="wb-pref-ai-create" ${config.pref.allowAiCreate ? 'checked' : ''} />
          <span class="track"></span>
        </label>
      </div>
      <div class="wb-field">
        <label class="wb-toggle" style="justify-content:space-between;">
          <span class="wb-label" style="margin:0;">规则优先于 AI</span>
          <input type="checkbox" id="wb-pref-rules-first" ${config.pref.rulesFirst ? 'checked' : ''} />
          <span class="track"></span>
        </label>
        <div class="wb-hint">开启后规则命中的视频直接归入规则指定的收藏夹（更快、更省 token）；规则目标名是明确意图，不做 AI 归并。规则过宽可能抢走本该细分到其他分类的视频，请按需维护规则列表。</div>
      </div>
      <div class="wb-field">
        <label class="wb-toggle" style="justify-content:space-between;">
          <span class="wb-label" style="margin:0;">阶段1 后确认分类体系</span>
          <input type="checkbox" id="wb-pref-confirm-tax" ${config.pref.confirmTaxonomy ? 'checked' : ''} />
          <span class="track"></span>
        </label>
        <div class="wb-hint">开启后 AI 设计完分类体系会暂停，供你改名/删除/新增分类后再开始归类，避免体系不对要全量重跑。默认关闭（一键整理）。</div>
      </div>
      <div class="wb-field">
        <label class="wb-toggle" style="justify-content:space-between;">
          <span class="wb-label" style="margin:0;">超大分类自动拆分</span>
          <input type="checkbox" id="wb-pref-auto-split" ${config.pref.autoSplitLargeCategories ? 'checked' : ''} />
          <span class="track"></span>
        </label>
        <div class="wb-hint">当分类条目 >70 条时，自动二次 AI 拆分为子分类，子分类名带原分类前缀（如 "历史政治·近代史"）。默认关闭。</div>
      </div>
      <div class="wb-field">
        <label class="wb-label">AI 每批处理条数</label>
        <input class="wb-input" id="wb-pref-batch" type="number" min="10" max="200" value="${config.pref.aiBatchSize}" />
        <div class="wb-hint">每批越小 AI 分类越完整（弱模型大列表会漏输出）；建议 ≤50。总视频会自动分批并多轮补充分类。</div>
      </div>
      <div class="wb-btn-row">
        <button class="wb-btn" id="wb-save-pref">${Icons.check} 保存偏好</button>
      </div>
    </div>

    <div class="wb-card">
      <div class="wb-card-title">${Icons.download} 数据备份</div>
      <div class="wb-btn-row">
        <button class="wb-btn" id="wb-export">${Icons.download} 导出 JSON 备份</button>
        <button class="wb-btn ghost" id="wb-import">${Icons.upload} 导入恢复</button>
        <input type="file" id="wb-import-file" accept="application/json" style="display:none" />
        <button class="wb-btn danger" id="wb-clear">${Icons.trash} 清空全部数据</button>
      </div>
      <div class="wb-hint" style="margin-top:6px;">备份含 AI 配置、分类规则与整理记录；出于安全考虑<b>不包含 API Key</b>（导入时自动沿用本机已保存的 Key）。建议数据积累较多时定期导出。</div>
    </div>`;

  // --- 规则列表（行内编辑，弃用 prompt/confirm） ---
  const ruleList = body.querySelector('#wb-rule-list')!;
  let editingId: string | null = null; // 当前展开编辑的规则 id（null=无）
  let editingDraft: Partial<ClassifyRule> = {};

  function renderRules() {
    // 目标分类下拉源：已选收藏夹名（settings 页可能无选中夹，用空数组兜底，用户可自定义新名）
    const folders = state.selectedFolders.length
      ? state.selectedFolders.map((f) => f.title)
      : [];
    ruleList.innerHTML = state.config.rules
      .map((r, i) => {
        const isEditing = editingId === r.id;
        if (isEditing) {
          return `
          <div class="wb-rule-edit">
            <div class="wb-rule-row">
              <input class="wb-input wb-rule-pat-input" data-field="pattern" value="${esc(editingDraft.pattern ?? r.pattern)}" placeholder="关键词或正则" />
            </div>
            <div class="wb-rule-row">
              <select class="wb-select wb-rule-cat-select" data-field="category">
                <option value="">选择目标收藏夹…</option>
                ${folders.map((f) => `<option value="${esc(f)}" ${(editingDraft.category ?? r.category) === f ? 'selected' : ''}>${esc(f)}</option>`).join('')}
                <option value="__custom__" ${(editingDraft.category ?? r.category) && !folders.includes(editingDraft.category ?? r.category) ? 'selected' : ''}>自定义新名…</option>
              </select>
              <input class="wb-input wb-rule-cat-custom" data-field="categoryCustom" value="${(editingDraft.category ?? r.category) && !folders.includes(editingDraft.category ?? r.category) ? esc(editingDraft.category ?? r.category) : ''}" placeholder="自定义分类名" style="display:none" />
            </div>
            <div class="wb-rule-row">
              <label class="wb-rule-flag"><input type="radio" name="regex-${r.id}" data-field="isRegex" value="false" ${!(editingDraft.isRegex ?? r.isRegex) ? 'checked' : ''} /> 关键词</label>
              <label class="wb-rule-flag"><input type="radio" name="regex-${r.id}" data-field="isRegex" value="true" ${(editingDraft.isRegex ?? r.isRegex) ? 'checked' : ''} /> 正则</label>
              <label class="wb-rule-toggle-mini"><input type="checkbox" data-field="caseSensitive" ${(editingDraft.caseSensitive ?? r.caseSensitive) ? 'checked' : ''} /> 区分大小写</label>
              <label class="wb-rule-toggle-mini"><input type="checkbox" data-field="enabled" ${(editingDraft.enabled ?? r.enabled) ? 'checked' : ''} /> 启用</label>
            </div>
            <div class="wb-rule-row">
              <button class="wb-btn-mini" data-action="save">保存</button>
              <button class="wb-btn-mini ghost" data-action="cancel">取消</button>
              <button class="wb-btn-mini ghost" data-action="up" ${i === 0 ? 'disabled' : ''}>↑</button>
              <button class="wb-btn-mini ghost" data-action="down" ${i === state.config.rules.length - 1 ? 'disabled' : ''}>↓</button>
            </div>
            <div class="wb-rule-test-hint" id="wb-rule-test-result"></div>
          </div>`;
        }
        const invalidClass = !r.pattern ? 'wb-rule-invalid' : '';
        return `
        <div class="wb-rule ${invalidClass}" data-rule-id="${r.id}">
          <span class="wb-rule-pat">${esc(r.pattern) || '<span style="color:var(--wb-red)">(空规则·已禁用)</span>'}${r.isRegex ? ' <span style="color:#9ca3af">(正则)</span>' : ''}</span>
          <span class="wb-rule-cat">→ ${esc(r.category) || '(未设置)'}</span>
          ${r.enabled ? '' : '<span class="wb-rule-disabled-badge">已禁用</span>'}
          <button class="wb-rule-del" data-edit="${r.id}" title="编辑">${Icons.gear}</button>
          <button class="wb-rule-del" data-del="${r.id}" title="删除">${Icons.trash}</button>
        </div>`;
      })
      .join('');
    bindRuleEvents();
  }

  function bindRuleEvents() {
    // 编辑/展开
    ruleList.querySelectorAll('[data-edit]').forEach((b) => {
      b.addEventListener('click', () => {
        const id = (b as HTMLElement).dataset.edit!;
        const r = state.config.rules.find((x) => x.id === id);
        if (!r) return;
        editingId = id;
        editingDraft = { ...r };
        renderRules();
      });
    });
    // 删除（改用 id 定位）
    ruleList.querySelectorAll('[data-del]').forEach((b) => {
      b.addEventListener('click', () => {
        const id = (b as HTMLElement).dataset.del!;
        const idx = state.config.rules.findIndex((x) => x.id === id);
        if (idx < 0) return;
        state.config.rules.splice(idx, 1);
        persist();
        renderRules();
      });
    });
    // 编辑态字段同步
    ruleList.querySelectorAll('[data-field]').forEach((el) => {
      const field = (el as HTMLElement).dataset.field!;
      const handler = () => {
        const input = el as HTMLInputElement | HTMLSelectElement;
        if (field === 'isRegex') {
          editingDraft.isRegex = (input as HTMLInputElement).value === 'true';
        } else if (field === 'category') {
          const val = (input as HTMLSelectElement).value;
          editingDraft.category = val === '__custom__' ? '' : val;
          const customInput = ruleList.querySelector('[data-field="categoryCustom"]') as HTMLElement;
          if (customInput) customInput.style.display = val === '__custom__' ? '' : 'none';
        } else if (field === 'categoryCustom') {
          editingDraft.category = (input as HTMLInputElement).value;
        } else if (typeof editingDraft[field as keyof ClassifyRule] === 'boolean' || field === 'caseSensitive' || field === 'enabled') {
          (editingDraft as any)[field] = (input as HTMLInputElement).checked;
        } else {
          (editingDraft as any)[field] = (input as HTMLInputElement).value;
        }
      };
      el.addEventListener('input', handler);
      el.addEventListener('change', handler);
    });
    // 保存
    ruleList.querySelectorAll('[data-action="save"]').forEach((b) => {
      b.addEventListener('click', async () => {
        const id = editingId!;
        const r = state.config.rules.find((x) => x.id === id);
        if (!r) return;
        const draft = { ...r, ...editingDraft } as ClassifyRule;
        // 合并 categoryCustom（自定义分类名兜底）
        if (!draft.category) {
          const custom = (ruleList.querySelector('[data-field="categoryCustom"]') as HTMLInputElement)?.value || '';
          draft.category = custom;
        }
        // 校验（保存时跑 L1+L2 压测）
        const { valid, invalid } = await validateRules([draft], true);
        if (!valid) {
          const reason = invalid[0]?.reason || '校验失败';
          (ruleList.querySelector('#wb-rule-test-result') as HTMLElement).innerHTML = `<span style="color:var(--wb-red)">${esc(reason)}</span>`;
          return;
        }
        Object.assign(r, draft);
        persist();
        editingId = null;
        editingDraft = {};
        renderRules();
        toast('规则已保存');
      });
    });
    // 取消
    ruleList.querySelectorAll('[data-action="cancel"]').forEach((b) => {
      b.addEventListener('click', () => { editingId = null; editingDraft = {}; renderRules(); });
    });
    // 上移/下移
    ruleList.querySelectorAll('[data-action="up"],[data-action="down"]').forEach((b) => {
      b.addEventListener('click', () => {
        const id = editingId!;
        const idx = state.config.rules.findIndex((x) => x.id === id);
        if (idx < 0) return;
        const dir = (b as HTMLElement).dataset.action === 'up' ? -1 : 1;
        const ni = idx + dir;
        if (ni < 0 || ni >= state.config.rules.length) return;
        [state.config.rules[idx], state.config.rules[ni]] = [state.config.rules[ni], state.config.rules[idx]];
        persist();
        renderRules();
      });
    });
  }

  renderRules();

  // --- 添加规则（行内插入空白可编辑行）---
  body.querySelector('#wb-add-rule')!.addEventListener('click', () => {
    const newRule: ClassifyRule = {
      id: uid(),
      pattern: '',
      category: '',
      isRegex: false,
      enabled: true,
      caseSensitive: false,
      scope: 'title',
    };
    state.config.rules.unshift(newRule); // 顶部插入
    persist();
    editingId = newRule.id;
    editingDraft = { ...newRule };
    renderRules();
    // 聚焦 pattern 输入
    setTimeout(() => (ruleList.querySelector('[data-field="pattern"]') as HTMLElement)?.focus(), 0);
  });
  body.querySelector('#wb-reset-rules')!.addEventListener('click', () => {
    if (!confirm('恢复默认 5 条示例规则？当前自定义规则将被覆盖。')) return;
    state.config.rules = structuredClone(DEFAULT_CONFIG.rules);
    persist();
    renderRules();
  });

  // 从移动记录生成规则
  body.querySelector('#wb-gen-rule-from-moves')!.addEventListener('click', () => {
    const moves = loadMoveRecords();
    if (!moves.length) { toast('暂无移动记录'); return; }
    const newRules: ClassifyRule[] = [];
    moves.forEach(rec => {
      const pattern = rec.srcTitle.replace(/[\-\/\^$*+?.()|[\]{}]/g, '\\$&');
      const rule: ClassifyRule = {
        id: uid(),
        pattern,
        category: rec.targetCategory,
        isRegex: false,
        enabled: true,
        caseSensitive: false,
        scope: 'title',
      };
      if (!state.config.rules.some(r => r.pattern === rule.pattern && r.category === rule.category)) {
        newRules.push(rule);
      }
    });
    if (newRules.length === 0) { toast('所有移动记录已对应已有规则'); return; }
    state.config.rules = [...newRules, ...state.config.rules];
    persist();
    renderRules();
    toast(`已生成 ${newRules.length} 条规则并加入规则列表`);
  });

  // --- 规则测试面板 ---
  const testPanel = body.querySelector('#wb-rule-test-toggle');
  testPanel?.addEventListener('click', () => {
    const testBody = body.querySelector('#wb-rule-test-body') as HTMLElement;
    const show = testBody.style.display === 'none';
    testBody.style.display = show ? '' : 'none';
    if (show) {
      // 默认预填上次整理的视频标题
      const titles = (state.task?.medias || []).map((m) => m.title);
      (body.querySelector('#wb-rule-test-input') as HTMLTextAreaElement).value = titles.join('\n');
    }
  });
  body.querySelector('#wb-rule-test-fetch')?.addEventListener('click', async () => {
    if (!state.selectedFolders.length) { toast('请先在收藏夹总览选中收藏夹'); return; }
    const ta = body.querySelector('#wb-rule-test-input') as HTMLTextAreaElement;
    ta.value = '抓取中…';
    try {
      const { getMyFolders, fetchAllMedias } = await import('../service/bili');
      const folders = await getMyFolders();
      const sel = folders.filter((f) => state.selectedFolders.some((s) => s.id === f.id));
      const titles: string[] = [];
      for (const f of sel) {
        const medias = await fetchAllMedias(f.id);
        titles.push(...medias.map((m) => m.title));
      }
      ta.value = titles.join('\n');
    } catch (e) { ta.value = ''; toast(`抓取失败：${e instanceof Error ? e.message : e}`); }
  });
  body.querySelector('#wb-rule-test-run')?.addEventListener('click', () => {
    const text = (body.querySelector('#wb-rule-test-input') as HTMLTextAreaElement).value;
    const titles = text.split('\n').map((s) => s.trim()).filter(Boolean);
    if (!titles.length) { toast('请输入或抓取标题'); return; }
    const { perRule, unmatched, conflicts } = testRules(titles, state.config.rules);
    const out = body.querySelector('#wb-rule-test-out') as HTMLElement;
    const html = perRule.map((r) => `
      <div class="wb-rule-hit">
        <span class="wb-rule-pat">${esc(r.pattern)}</span> → <span class="wb-rule-cat">${esc(r.category)}</span>
        <span class="wb-cat-count">${r.hitTitles.length}</span>
        ${r.hitTitles.length ? `<details><summary>命中标题</summary>${r.hitTitles.map((t) => `<div>${esc(t)}</div>`).join('')}</details>` : ''}
      </div>`).join('')
      + `<div class="wb-rule-hit"><b>未命中（将送 AI/未分类）：${unmatched.length}</b></div>`
      + (conflicts.length ? `<div class="wb-rule-conflict">⚠️ 抢占预警：${conflicts.length} 处。靠前宽规则抢占了靠后窄规则的潜在命中，建议调窄前置规则或调整顺序</div>` : '');
    out.innerHTML = html;
  });

  // --- AI 配置保存/测试 ---
  body.querySelector('#wb-save-ai')!.addEventListener('click', () => {
    config.ai.baseUrl = (body.querySelector('#wb-set-baseurl') as HTMLInputElement).value.trim() || config.ai.baseUrl;
    config.ai.apiKey = (body.querySelector('#wb-set-key') as HTMLInputElement).value.trim();
    config.ai.model = (body.querySelector('#wb-set-model') as HTMLInputElement).value.trim() || 'deepseek-chat';
    config.ai.enabled = (body.querySelector('#wb-set-ai-enabled') as HTMLInputElement).checked;
    persist();
    toast('AI 配置已保存');
  });

  body.querySelector('#wb-test-ai')!.addEventListener('click', async () => {
    const log = body.querySelector('#wb-ai-log') as HTMLElement;
    log.style.display = 'block';
    log.innerHTML = '<div>➜ 测试中…</div>';
    try {
      const base = (body.querySelector('#wb-set-baseurl') as HTMLInputElement).value.trim();
      const key = (body.querySelector('#wb-set-key') as HTMLInputElement).value.trim();
      const model = (body.querySelector('#wb-set-model') as HTMLInputElement).value.trim() || 'deepseek-chat';
      if (!base || !key) { log.innerHTML = '<div class="err">➜ 请先填写 API 地址与 Key</div>'; return; }
      // 最小连通性验证（不跑分类任务，快且不产生测试垃圾分类）
      const reply = await aiTestConnection({ baseUrl: base, apiKey: key, model, enabled: true });
      log.innerHTML = `<div class="ok">➜ 连接成功！模型回复：${esc(reply)}</div>`;
    } catch (e) {
      log.innerHTML = `<div class="err">➜ ${e instanceof Error ? e.message : String(e)}</div>`;
    }
  });

  // --- 偏好保存 ---
  body.querySelector('#wb-save-pref')!.addEventListener('click', () => {
    config.pref.allowAiCreate = (body.querySelector('#wb-pref-ai-create') as HTMLInputElement).checked;
    config.pref.rulesFirst = (body.querySelector('#wb-pref-rules-first') as HTMLInputElement).checked;
    config.pref.confirmTaxonomy = (body.querySelector('#wb-pref-confirm-tax') as HTMLInputElement).checked;
    config.pref.autoSplitLargeCategories = (body.querySelector('#wb-pref-auto-split') as HTMLInputElement).checked;
    const batch = Number((body.querySelector('#wb-pref-batch') as HTMLInputElement).value);
    config.pref.aiBatchSize = Math.min(200, Math.max(10, batch || 50));
    persist();
    toast('偏好已保存');
  });

  // --- 备份 ---
  body.querySelector('#wb-export')!.addEventListener('click', () => {
    downloadText(`bilibili-fav-organizer-backup-${new Date().toISOString().slice(0, 10)}.json`, exportBackup());
    toast('已导出备份');
  });
  body.querySelector('#wb-import')!.addEventListener('click', () => (body.querySelector('#wb-import-file') as HTMLInputElement).click());
  body.querySelector('#wb-import-file')!.addEventListener('change', async (e) => {
    const file = (e.target as HTMLInputElement).files?.[0];
    if (!file) return;
    try {
      const { config: cfg, records } = parseBackup(await readFileText(file));
      // 导出的备份不含 API Key（安全设计）：导入时保留本机已保存的 Key
      if (!cfg.ai.apiKey) cfg.ai.apiKey = state.config.ai.apiKey;
      importBackup(cfg, records);
      state.config = cfg;
      state.records = records;
      persist();
      toast('导入成功，数据已恢复');
      renderSettings(body);
    } catch (err) {
      alert(`导入失败：${err instanceof Error ? err.message : err}`);
    }
  });
  body.querySelector('#wb-clear')!.addEventListener('click', () => {
    if (!confirm('⚠️ 确定清空全部数据（AI 配置 + 规则 + 整理记录）？此操作不可恢复，建议先导出备份。')) return;
    clearAllData();
    location.reload();
  });
}

/** 简单 toast 提示 */
export function toast(msg: string): void {
  const el = document.createElement('div');
  el.textContent = msg;
  el.style.cssText = 'position:fixed;left:50%;top:20px;transform:translateX(-50%);background:#1f2329;color:#fff;padding:8px 16px;border-radius:8px;font-size:13px;z-index:2147483647;box-shadow:0 4px 12px rgba(0,0,0,0.25);';
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 2200);
}
