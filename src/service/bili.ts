// ============================================================
// B站 API 服务层：收藏夹读取 / 建夹 / 移动
// 稳定性设计（2026 实践）：
//  - 完整请求头（Referer / UA / Cookie）
//  - 写操作 POST 节流 ≥3s，读操作 GET ≥1s
//  - 指数退避重试（最多 3 次）
//  - 412 风控检测 + 分级冷却（IP 级 10min / 账号级 1h）
// ============================================================
import type { FavFolder, FavMedia } from '../types';

const API_HOST = 'https://api.bilibili.com';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 与 B站页面一致的请求头，降低风控权重 */
function headers(): Record<string, string> {
  return {
    'User-Agent': navigator.userAgent,
    Referer: `${location.origin}${location.pathname}`,
    'Accept': 'application/json, text/plain, */*',
  };
}

/** 从 Cookie 解析登录态 */
export function getBiliAuth(): { mid: string; csrf: string } | null {
  const mid = document.cookie.match(/DedeUserID=([^;]+)/)?.[1] || '';
  const csrf = document.cookie.match(/bili_jct=([^;]+)/)?.[1] || '';
  if (!mid || !csrf) return null;
  return { mid, csrf };
}

// ---------- 风控状态 ----------
type RiskLevel = 'none' | 'ip' | 'account';
let risk: RiskLevel = 'none';
let riskUntil = 0;

export function getRiskStatus(): { level: RiskLevel; until: number } {
  return { level: risk, until: riskUntil };
}

function setRisk(level: RiskLevel) {
  risk = level;
  riskUntil = Date.now() + (level === 'ip' ? 10 * 60 * 1000 : level === 'account' ? 60 * 60 * 1000 : 0);
}

export function isBlocked(): boolean {
  return risk !== 'none' && Date.now() < riskUntil;
}

/** 412 判定：HTTP 412 或 body.code === -412 / -403 风控类 */
function detectRisk(status: number, code: number | undefined): RiskLevel {
  if (status === 412) return 'ip';
  if (code === -412) return 'ip';
  if (code === -403 || code === -352) return 'account';
  if (status === 403) return 'account';
  return 'none';
}

// ---------- 请求原语（带节流 + 重试 + 风控） ----------
interface ReqOptions {
  method?: 'GET' | 'POST';
  url: string;
  params?: Record<string, string | number>;
  body?: URLSearchParams;
}

async function request<T>(opts: ReqOptions, retries = 3): Promise<T> {
  if (isBlocked()) {
    throw new Error(`风控冷却中：${risk === 'ip' ? 'IP 级（约 10 分钟）' : '账号级（约 1 小时）'}，请稍后再试`);
  }

  // 节流：读 ≥1s，写 ≥3s（按全局最近请求时间）
  const now = Date.now();
  const minGap = opts.method === 'POST' ? 3000 : 1000;
  const lastReqAt = (globalThis as any).__wbFavLastReq || 0;
  const gap = now - lastReqAt;
  if (gap < minGap) await sleep(minGap - gap);
  (globalThis as any).__wbFavLastReq = Date.now();

  try {
    const url = new URL(opts.url);
    Object.entries(opts.params || {}).forEach(([k, v]) => url.searchParams.set(k, String(v)));

    const resp = await fetch(url.toString(), {
      method: opts.method || 'GET',
      headers: headers(),
      credentials: 'include',
      body: opts.body,
    });
    let parseFailed = false;
    const json = await resp.json().catch(() => {
      // 网关拦截/CDN 错误页等会返回 HTML：标记后走重试，而不是当成业务错误直接抛
      parseFailed = true;
      return {} as { code?: number; message?: string; data?: unknown };
    });

    const riskLevel = detectRisk(resp.status, json.code);
    if (riskLevel !== 'none') {
      setRisk(riskLevel);
      throw new Error(`触发 B站风控（${riskLevel === 'ip' ? 'IP 级' : '账号级'}），已暂停操作`);
    }

    if (parseFailed) {
      throw new Error(`B站响应非 JSON（HTTP ${resp.status}，可能被网关拦截），将重试`);
    }

    if (json.code !== 0) {
      // 业务错误：-400 参数错误、-101 未登录 等，重试无意义，直接抛
      throw new Error(`B站接口错误 [${json.code}]: ${json.message || '未知'}`);
    }
    return json.data as T;
  } catch (e) {
    // 网络异常/超时才重试，风控与业务错误直接抛
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes('风控') || msg.includes('B站接口错误') || retries <= 0) throw e;
    const backoff = 1000 * 2 ** (3 - retries); // 1s, 2s, 4s
    await sleep(backoff);
    return request<T>(opts, retries - 1);
  }
}

// ---------- 收藏夹 API ----------
/** 获取我创建的全部收藏夹（含默认收藏夹） */
export async function getMyFolders(): Promise<FavFolder[]> {
  const auth = getBiliAuth();
  if (!auth) return [];
  const data = await request<{ list: FavFolder[] }>({
    url: `${API_HOST}/x/v3/fav/folder/created/list-all`,
    params: { up_mid: auth.mid },
  });
  return data.list || [];
}

/** 分页读取收藏夹内资源（ps 上限 20） */
export async function getFolderMedias(mediaId: number, pn = 1, ps = 20): Promise<{ medias: FavMedia[]; hasMore: boolean; total: number }> {
  const data = await request<{ medias?: FavMedia[]; has_more?: boolean; info?: { media_count?: number } }>({
    url: `${API_HOST}/x/v3/fav/resource/list`,
    params: { media_id: mediaId, pn, ps, platform: 'web' },
  });
  const medias = data.medias || [];
  const hasMore = typeof data.has_more === 'undefined' ? medias.length === ps : data.has_more;
  return { medias, hasMore, total: data.info?.media_count ?? medias.length };
}

/** 全量抓取收藏夹资源（自动翻页 + 限速） */
export async function fetchAllMedias(mediaId: number, onProgress?: (done: number, total: number) => void): Promise<FavMedia[]> {
  const all: FavMedia[] = [];
  let pn = 1;
  let total = 0;
  for (;;) {
    const { medias, hasMore, total: t } = await getFolderMedias(mediaId, pn, 20);
    total = t;
    if (medias.length) all.push(...medias);
    onProgress?.(all.length, total || all.length);
    if (!hasMore || medias.length === 0) break;
    pn++;
    await sleep(500);
  }
  return all;
}

/** 新建收藏夹，返回 media_id；privacy=0 公开 */
export async function createFolder(title: string, privacy = 0): Promise<number> {
  const auth = getBiliAuth();
  if (!auth) throw new Error('未登录 B站');
  const data = await request<{ id: number }>({
    method: 'POST',
    url: `${API_HOST}/x/v3/fav/folder/add`,
    body: new URLSearchParams({ title, privacy: String(privacy), csrf: auth.csrf }),
  });
  return data.id;
}

/** 把资源从源收藏夹移动到目标收藏夹 */
export async function moveResources(srcMediaId: number, tarMediaId: number, resources: string): Promise<void> {
  const auth = getBiliAuth();
  if (!auth) throw new Error('未登录 B站');
  await request<{ id: number }>({
    method: 'POST',
    url: `${API_HOST}/x/v3/fav/resource/move`,
    body: new URLSearchParams({
      src_media_id: String(srcMediaId),
      tar_media_id: String(tarMediaId),
      mid: auth.mid,
      resources,
      csrf: auth.csrf,
    }),
  });
}

/** 从指定收藏夹批量移除资源（去重清理用；resources 格式同 move：id:type 逗号分隔） */
export async function deleteResources(mediaId: number, resources: string): Promise<void> {
  const auth = getBiliAuth();
  if (!auth) throw new Error('未登录 B站');
  await request<unknown>({
    method: 'POST',
    url: `${API_HOST}/x/v3/fav/resource/batch-del`,
    body: new URLSearchParams({
      resources,
      media_id: String(mediaId),
      platform: 'web',
      csrf: auth.csrf,
    }),
  });
}

/** 一键清空指定收藏夹内的失效视频（B站 clean 接口，不可逆）
 *  返回清理数量（接口不返回明细，返回请求成功即视为清空） */
export async function cleanFolderInvalids(mediaId: number): Promise<void> {
  const auth = getBiliAuth();
  if (!auth) throw new Error('未登录 B站');
  await request<unknown>({
    method: 'POST',
    url: `${API_HOST}/x/v3/fav/resource/clean`,
    body: new URLSearchParams({
      media_id: String(mediaId),
      platform: 'web',
      csrf: auth.csrf,
    }),
  });
}

/** 抓取视频的 B站官方分区(zone)与标签(tags)，作为弱模型分类的强信号
 *  - 分区来自 /x/web-interface/view 的 tname(主分区)+typename(子分区)
 *  - 标签来自 /x/tag/archive/tags
 *  - 任一接口失败不影响整体（降级为空），调用方应容忍空值 */
export async function getVideoZoneTags(bvid: string): Promise<{ zone: string; tags: string[] }> {
  let zone = '';
  let tags: string[] = [];
  try {
    const view = await request<{ tname?: string; typename?: string }>({
      url: `${API_HOST}/x/web-interface/view`,
      params: { bvid },
    });
    zone = [view.tname, view.typename].filter(Boolean).join('/');
  } catch { /* 单条失败降级为空，不阻断整体 */ }
  try {
    const tagData = await request<Array<{ tag_name?: string }>>({
      url: `${API_HOST}/x/tag/archive/tags`,
      params: { bvid },
    });
    tags = (tagData || []).map((t) => t.tag_name || '').filter(Boolean).slice(0, 8);
  } catch { /* 单条失败降级为空，不阻断整体 */ }
  return { zone, tags };
}
