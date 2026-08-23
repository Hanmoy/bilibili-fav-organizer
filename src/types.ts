// ============================================================
// 类型定义（全局共享）
// ============================================================

/** B站收藏夹 */
export interface FavFolder {
  id: number;          // media_id
  fid: number;         // 原始 id
  title: string;
  media_count: number; // 视频数
  attr: number;        // 0 公开 1 私密
}

/** 收藏夹内的视频/资源 */
export interface FavMedia {
  id: number;          // 资源 id（视频为 avid）
  type: number;        // 2=视频
  title: string;
  intro?: string;
  cover?: string;
  duration?: number;
  fav_time?: number;   // 收藏时间戳
  bvid?: string;
  upper?: { name: string };
  /** 资源状态：0 正常 / 1 已删除 / 9 发布者删除（失效检测用） */
  attr?: number;
  /** 分类标记（本工具写入） */
  category?: string;
  /** 来源收藏夹 id（多选批量整理时标记，移动回源用） */
  srcFolderId?: number;
  /** 来源收藏夹名（展示用） */
  srcFolderName?: string;
  /** B站官方分区（弱模型分类强信号，增量模式抓取），如 "科技/计算机技术" */
  zone?: string;
  /** B站官方标签（弱模型分类强信号，增量模式抓取） */
  tags?: string[];
}

/** 分类结果：分类名 -> 资源列表 */
export type CategoryMap = Record<string, FavMedia[]>;

/** 一条整理记录 */
export interface OrganizeRecord {
  id: string;
  time: number;          // 整理完成时间戳
  sourceFolder: string;  // 源收藏夹名
  total: number;         // 处理总数
  moved: number;         // 移动成功数
  categories: string[];  // 涉及的分类名
  detail?: CategoryMap;  // 完整分类明细
}

/** AI 配置（用户自带 Key） */
export interface AiConfig {
  baseUrl: string;   // OpenAI 兼容 API 地址，默认 https://api.deepseek.com/v1
  apiKey: string;
  model: string;     // 默认 deepseek-chat
  enabled: boolean;
}

/** 规则匹配范围 */
export type RuleScope = 'title' | 'title_intro' | 'upper';

/** 分类规则：关键词/正则 -> 分类名（规则优先） */
export interface ClassifyRule {
  id: string;
  pattern: string;        // 关键词或正则表达式
  category: string;       // 目标收藏夹名
  isRegex: boolean;
  enabled: boolean;       // 启用/禁用（新增，默认 true；空 pattern 强制 false）
  caseSensitive: boolean; // 大小写敏感（新增，默认 false 保持原 'i' 行为）
  scope?: RuleScope;      // 匹配范围（新增，默认 'title'）
}

/** 整理偏好 */
export interface OrganizePref {
  /** 是否允许新建收藏夹（AI/规则产生新分类时） */
  allowAiCreate: boolean;
  /** 每批最多多少条给 AI（防止 prompt 过长） */
  aiBatchSize: number;
  /** 上次使用的整理要求（自然语言，注入 AI prompt 的最高优先级指示） */
  lastRequirement: string;
  /** 规则优先于 AI：命中的视频不送 AI（更快更省 token）；关闭时 AI 处理全部，规则仅在无 AI 时兜底 */
  rulesFirst: boolean;
  /** 阶段1 后是否暂停供用户确认分类体系（默认关；开启后阶段1 完成弹出行内可编辑分类列表） */
  confirmTaxonomy: boolean;
}

/** 全部本地配置（GM 存储） */
export interface AppConfig {
  ai: AiConfig;
  rules: ClassifyRule[];
  pref: OrganizePref;
  /** 每个收藏夹上次成功应用整理时见过的最大 fav_time（增量过滤基准；与 fav_time 同单位，避免秒/毫秒换算出错） */
  folderLastRun: Record<string, number>;
}
