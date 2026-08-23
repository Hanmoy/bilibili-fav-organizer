// ============================================================
// 存储层：GM_storage 封装 + 导出/导入备份 + 整理任务持久化
// 数据 key 统一前缀 wb_favorg_，避免与其他脚本冲突
// ============================================================
import { GM_getValue, GM_setValue, GM_deleteValue } from 'vite-plugin-monkey/dist/client';
import type { AppConfig, ClassifyRule, OrganizeRecord, RuleScope } from '../types';
import type { PersistableTask } from '../state';

const PREFIX = 'wb_favorg_';
const K_CONFIG = `${PREFIX}config`;
const K_RECORDS = `${PREFIX}records`;
const K_TASK = `${PREFIX}task`;

/** 归一化单条规则：补默认字段、类型校验、空 pattern 强制禁用 */
function normalizeRule(r: any, fallbackId: string): ClassifyRule {
  const pattern = typeof r?.pattern === 'string' ? r.pattern : '';
  const scope: RuleScope = r?.scope === 'title_intro' || r?.scope === 'upper' ? r.scope : 'title';
  return {
    id: typeof r?.id === 'string' && r.id ? r.id : fallbackId,
    pattern,
    category: typeof r?.category === 'string' ? r.category : '',
    isRegex: !!r?.isRegex,
    // 空 pattern 永真命中全部(#10)，强制禁用（不删用户数据，UI 红标提示）
    enabled: typeof r?.enabled === 'boolean' ? r.enabled : (pattern ? true : false),
    caseSensitive: !!r?.caseSensitive,
    scope,
  };
}

/** 归一化规则数组（导入/加载统一入口） */
function normalizeRules(rules: any[]): ClassifyRule[] {
  if (!Array.isArray(rules)) return [];
  return rules.map((r, i) => normalizeRule(r, `migrated_${Date.now().toString(36)}_${i}`));
}

export const DEFAULT_CONFIG: AppConfig = {
  ai: {
    baseUrl: 'https://api.deepseek.com/v1',
    apiKey: '',
    model: 'deepseek-chat',
    enabled: false,
  },
  rules: [
    { id: 'r1', pattern: '教程|课程|教学|入门', category: '学习教程', isRegex: false, enabled: true, caseSensitive: false, scope: 'title' },
    { id: 'r2', pattern: '科技|数码|手机|电脑|AI|人工智能', category: '科技数码', isRegex: false, enabled: true, caseSensitive: false, scope: 'title' },
    { id: 'r3', pattern: '音乐|MV|歌曲|演奏', category: '音乐', isRegex: false, enabled: true, caseSensitive: false, scope: 'title' },
    { id: 'r4', pattern: '美食|做饭|料理|探店', category: '美食', isRegex: false, enabled: true, caseSensitive: false, scope: 'title' },
    { id: 'r5', pattern: '游戏|实况|攻略|电竞', category: '游戏', isRegex: false, enabled: true, caseSensitive: false, scope: 'title' },
  ],
  pref: {
    allowAiCreate: true,
    aiBatchSize: 50,
    lastRequirement: '',
    rulesFirst: false,
    confirmTaxonomy: false,
  },
  folderLastRun: {},
};

/** 读取配置（与默认值深合并，兼容旧数据缺字段） */
export function loadConfig(): AppConfig {
  const saved = GM_getValue<Partial<AppConfig> | undefined>(K_CONFIG, undefined);
  if (!saved) return structuredClone(DEFAULT_CONFIG);
  return {
    ...structuredClone(DEFAULT_CONFIG),
    ...saved,
    ai: { ...DEFAULT_CONFIG.ai, ...(saved.ai || {}) },
    rules: saved.rules && saved.rules.length ? normalizeRules(saved.rules) : structuredClone(DEFAULT_CONFIG.rules),
    pref: { ...DEFAULT_CONFIG.pref, ...(saved.pref || {}), confirmTaxonomy: typeof saved.pref?.confirmTaxonomy === 'boolean' ? saved.pref.confirmTaxonomy : DEFAULT_CONFIG.pref.confirmTaxonomy },
    folderLastRun: saved.folderLastRun || {},
  };
}

export function saveConfig(cfg: AppConfig): void {
  GM_setValue(K_CONFIG, cfg);
}

export function loadRecords(): OrganizeRecord[] {
  return GM_getValue<OrganizeRecord[] | undefined>(K_RECORDS, []) || [];
}

export function saveRecords(records: OrganizeRecord[]): void {
  // 只保留最近 200 条，防止无限膨胀
  GM_setValue(K_RECORDS, records.slice(0, 200));
}

export function addRecord(rec: OrganizeRecord): OrganizeRecord[] {
  const all = loadRecords();
  all.unshift(rec);
  saveRecords(all);
  return all;
}

export function clearAllData(): void {
  GM_deleteValue(K_CONFIG);
  GM_deleteValue(K_RECORDS);
  GM_deleteValue(K_TASK);
}

// ---------- 整理任务持久化（刷新/关页后恢复预览与移动进度） ----------

/** 持久化当前任务（含分类结果、重复副本、移动进度）。running 状态不落盘 */
export function saveTask(task: PersistableTask): void {
  GM_setValue(K_TASK, task);
}

/** 读取持久化的任务；无则 null */
export function loadTask(): PersistableTask | null {
  return GM_getValue<PersistableTask | undefined>(K_TASK, undefined) || null;
}

/** 清除持久化任务（任务彻底完成或放弃时） */
export function clearTask(): void {
  GM_deleteValue(K_TASK);
}

/** 导出全量 JSON 备份（含配置 + 记录），返回下载用的文本
 *  安全约束：API Key 永不落盘到导出文件（备份常被分享/上传网盘） */
export function exportBackup(): string {
  const config = loadConfig();
  const redacted = { ...config, ai: { ...config.ai, apiKey: '' } };
  return JSON.stringify(
    {
      app: 'bilibili-fav-organizer',
      version: 2,
      exportedAt: Date.now(),
      // 导出已自动剔除 apiKey，导入时保留本机已保存的 Key
      apiKeyRedacted: true,
      config: redacted,
      records: loadRecords(),
    },
    null,
    2,
  );
}

/** 解析导入的备份 JSON，失败抛错 */
export function parseBackup(text: string): { config: AppConfig; records: OrganizeRecord[] } {
  const data = JSON.parse(text);
  if (!data || typeof data !== 'object') throw new Error('备份文件格式不正确');
  const base = structuredClone(DEFAULT_CONFIG);
  const src = (data.config || {}) as Partial<AppConfig>;
  const cfg: AppConfig = {
    ...base,
    ...src,
    // 嵌套对象深合并，旧版本备份缺新字段时回落默认值；rules 逐条 normalizeRule 补默认
    ai: { ...base.ai, ...(src.ai || {}) },
    rules: src.rules && src.rules.length ? normalizeRules(src.rules) : structuredClone(base.rules),
    pref: { ...base.pref, ...(src.pref || {}), confirmTaxonomy: typeof src.pref?.confirmTaxonomy === 'boolean' ? src.pref.confirmTaxonomy : base.pref.confirmTaxonomy },
    folderLastRun: src.folderLastRun || {},
  };
  const records = Array.isArray(data.records) ? data.records : [];
  return { config: cfg, records };
}

export function importBackup(cfg: AppConfig, records: OrganizeRecord[]): void {
  saveConfig(cfg);
  saveRecords(records);
}
