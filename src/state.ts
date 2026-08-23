// ============================================================
// 全局状态（简易 store，供各视图共享）
// 整理任务在后台运行：状态存这里，切换 tab 不中断
// ============================================================
import type { AppConfig, CategoryMap, FavFolder, FavMedia, OrganizeRecord } from './types';
import type { OrganizeMode } from './service/classify';
import type { DesignedCategory } from './service/ai';
import { loadConfig, saveConfig, loadRecords, saveRecords, loadTask, saveTask, clearTask } from './storage/store';

/** 后台整理任务状态 */
export interface OrganizeTask {
  running: boolean;
  /** 整理模式：full 全量重分类（可新建夹）/ incremental 增量分配（仅匹配已有夹） */
  mode: OrganizeMode;
  /** 源收藏夹（支持多选） */
  folders: FavFolder[];
  /** 抓取到的视频（合并多个收藏夹） */
  medias: FavMedia[];
  /** 分类结果 */
  suggest: CategoryMap | null;
  /** 跨夹重复的多余副本（保留最早收藏的一份参与分类，其余待清理） */
  dupExtras: FavMedia[];
  /** 每个源收藏夹抓取到的最大 fav_time（增量基准，成功应用后写入 config） */
  folderMaxFav: Record<string, number>;
  /** 任务日志 */
  logs: { msg: string; level: 'ok' | 'warn' | 'err' | 'info' }[];
  /** 进度：phase=fetch 抓取中 / ai AI分类中 */
  progress: { done: number; total: number; phase: 'fetch' | 'ai' };
  /** 错误信息（任务失败时非空） */
  error: string;
  /** 正在执行「确认移动」（页面切换后据此禁用按钮/恢复续跑） */
  applying: boolean;
  /** 已成功移动的资源标记（id:type），断点续跑时跳过，保证幂等 */
  appliedItems: string[];
  /** 移动进度（done=已移动条数，total=本次待移动条数；随断点落盘） */
  applyProgress: { done: number; total: number };
  /** 阶段1 分类体系确认态：confirmTaxonomy 开启时，AI 设计的分类体系暂存于此，待 UI 确认 */
  taxonomyConfirm?: DesignedCategory[];
  /** 全部移动流程已走完（含 UNC 剩余提示），任务生命周期结束 */
  done: boolean;
}

/** 可持久化的任务快照（OrganizeTask 本身可 JSON 序列化） */
export type PersistableTask = OrganizeTask;

export const state = {
  config: loadConfig() as AppConfig,
  records: loadRecords() as OrganizeRecord[],
  /** 当前选中的收藏夹（总览页多选） */
  selectedFolders: [] as FavFolder[],
  /** 后台整理任务 */
  task: null as OrganizeTask | null,
};

// 启动时恢复上次未完成的任务（刷新/关页后分类结果不丢）
// running/applying 是瞬态：恢复时强制视为已停止，用户可在预览页续跑
{
  const saved = loadTask();
  if (saved && saved.suggest) {
    // 旧版本持久化的任务缺 applyProgress 字段，恢复时补默认值
    state.task = { ...saved, running: false, applying: false, applyProgress: saved.applyProgress || { done: 0, total: 0 } };
  }
}

export function persist(): void {
  saveConfig(state.config);
  saveRecords(state.records);
}

/** 把当前任务写入持久化存储（分类完成/移动进度变化时调用） */
export function persistTask(): void {
  if (state.task) saveTask(state.task as PersistableTask);
  else clearTask();
}

/** 追加任务日志并触发 UI 刷新（若有任务日志 DOM） */
export function taskLog(msg: string, level: 'ok' | 'warn' | 'err' | 'info' = 'info'): void {
  if (!state.task) return;
  state.task.logs.push({ msg, level });
  // 通知正在监听的视图刷新（通过自定义事件，避免视图与状态耦合）
  window.dispatchEvent(new CustomEvent('wb:tasklog'));
}

/** 清空并初始化任务 */
export function startTask(folders: FavFolder[], mode: OrganizeMode = 'full'): void {
  state.task = {
    running: true,
    mode,
    folders,
    medias: [],
    suggest: null,
    dupExtras: [],
    folderMaxFav: {},
    logs: [],
    progress: { done: 0, total: 0, phase: 'fetch' },
    error: '',
    applying: false,
    appliedItems: [],
    applyProgress: { done: 0, total: 0 },
    done: false,
  };
}

export function endTask(error = ''): void {
  if (!state.task) return;
  state.task.running = false;
  state.task.error = error;
  window.dispatchEvent(new CustomEvent('wb:tasklog'));
}
