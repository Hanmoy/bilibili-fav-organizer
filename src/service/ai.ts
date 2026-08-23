// ============================================================
// AI 服务层：OpenAI 兼容 Chat Completions（用户自带 Key）
//  - 通过 GM_xmlhttpRequest 发起（跨域不受 CORS 限制）
//  - 强制 JSON 结构化输出（response_format json_object + 提示约束）
//  - temperature 0.1 保证匹配严谨
// ============================================================
import { GM_xmlhttpRequest } from 'vite-plugin-monkey/dist/client';
import type { AiConfig } from '../types';

export interface AiCategoryResult {
  thoughts: string;
  categories: Record<string, Array<{ id: number; type: number; bvid?: string }>>;
}

function gmRequest<T>(url: string, headers: Record<string, string>, body: string, timeoutMs = 120000): Promise<T> {
  return new Promise((resolve, reject) => {
    GM_xmlhttpRequest({
      method: 'POST',
      url,
      headers,
      data: body,
      timeout: timeoutMs,
      onload: (resp) => {
        // 响应片段：用于诊断（只截前 300 字）
        const snippet = (resp.responseText || '').slice(0, 300);
        try {
          if (resp.status !== 200) {
            let detail = '';
            try {
              detail = JSON.parse(resp.responseText)?.error?.message || '';
            } catch { /* ignore */ }
            reject(new Error(`AI 接口报错 HTTP ${resp.status}${detail ? '：' + detail : ''}${!detail && snippet ? '。响应内容：' + snippet : ''}`));
            return;
          }
          let parsed: unknown;
          try {
            parsed = JSON.parse(resp.responseText);
          } catch {
            // 返回非 JSON（很可能是 HTML 错误页 / 路径不对）
            const isHtml = /^\s*</.test(resp.responseText || '');
            reject(
              new Error(
                isHtml
                  ? `AI 返回了 HTML 页面而非 JSON——大概率是 API 地址路径不对（响应开头：${snippet.replace(/\s+/g, ' ')}）。请检查 baseUrl 是否已含 /v1 或 /chat/completions`
                  : `AI 响应解析失败，返回非 JSON（响应开头：${snippet.replace(/\s+/g, ' ')}）`,
              ),
            );
            return;
          }
          resolve(parsed as T);
        } catch (e) {
          reject(new Error(`AI 响应解析失败：${e instanceof Error ? e.message : e}。响应开头：${snippet.replace(/\s+/g, ' ')}`));
        }
      },
      onerror: () => reject(new Error('AI 请求网络失败，请检查网络或 Key')),
      ontimeout: () => reject(new Error('AI 请求超时（120s）')),
    });
  });
}

/** 统一端点拼接：baseUrl 可能填 https://host / https://host/v1 / 完整 /chat/completions */
function chatEndpoint(cfg: AiConfig): string {
  const endpoint = cfg.baseUrl.trim().replace(/\/+$/, '');
  if (!endpoint) throw new Error('AI 配置缺失：请先填写 API 地址');
  return /\/chat\/completions$/.test(endpoint) ? endpoint : endpoint + '/chat/completions';
}

/** 调用 chat/completions 的公共封装（system 角色 + user 内容，统一鉴权头） */
function chat(cfg: AiConfig, system: string, user: string, extra: Record<string, unknown> = {}): Promise<{ choices: Array<{ message: { content: string } }> }> {
  const payload: Record<string, unknown> = {
    model: cfg.model,
    // 角色与输出契约放 system：弱模型对 system 指令的遵循度普遍高于 user 内嵌描述
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    temperature: 0.1,
    response_format: { type: 'json_object' },
    ...extra,
  };
  return gmRequest<{ choices: Array<{ message: { content: string } }> }>(
    chatEndpoint(cfg),
    { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
    JSON.stringify(payload),
  ).catch((e) => {
    // 部分公益站不支持 response_format，去掉后重试一次
    if (e instanceof Error && e.message.includes('response_format')) {
      delete payload.response_format;
      return gmRequest<{ choices: Array<{ message: { content: string } }> }>(
        chatEndpoint(cfg),
        { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
        JSON.stringify(payload),
      );
    }
    throw e;
  });
}

/** 剥掉模型输出里可能包裹的 markdown 代码块 */
function stripCodeFence(raw: string): string {
  return raw.replace(/```json/g, '').replace(/```/g, '').trim();
}

/**
 * 最小连通性验证：只发一条极简消息，确认接口地址/Key/模型可用
 * 不做分类任务（速度快、不产生"测试归档"这类垃圾分类）
 * @returns 模型回复的原文（截断）
 */
export async function aiTestConnection(cfg: AiConfig): Promise<string> {
  const resp = await gmRequest<{ choices: Array<{ message: { content: string } }> }>(
    chatEndpoint(cfg),
    { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
    JSON.stringify({
      model: cfg.model,
      messages: [{ role: 'user', content: '请只回复两个字：正常' }],
      temperature: 0.1,
      max_tokens: 20,
    }),
    30000, // 30s 超时（测试不宜久等）
  );
  const text = resp.choices?.[0]?.message?.content || '';
  return text.trim().slice(0, 50) || '(空回复)';
}

/** 设计好的分类：名字 + 一句话定义（定义会注入阶段2 prompt，消除同名歧义、提升归类准确度） */
export interface DesignedCategory {
  name: string;
  desc: string;
}

/**
 * 阶段1：全局分类体系设计
 * 让 AI 一次性通读全部视频标题，设计 10~18 个覆盖全部内容的分类（含定义）
 * @returns 分类数组（兼容模型返回纯字符串数组的降级输出，desc 为空）
 */
export async function aiDesignCategories(
  cfg: AiConfig,
  allTitles: string[],
  existingFolders: string[],
  userRequirement = '',
  folderDistribution?: Record<string, number>,  // 新增：源夹分布 {夹名:条数}
): Promise<DesignedCategory[]> {
  const customRuleText = userRequirement.trim()
    ? `\n\n【最高优先级】用户的特别指示是："${userRequirement.trim()}"\n分类体系设计必须满足用户指示。`
    : '';
  const namePoolText = existingFolders.length
    ? `用户过去的收藏夹出现过以下名字（仅供命名参考，是否使用由你判断）：\n[ ${existingFolders.join(', ')} ]\n`
    : '';
  // 新增：源夹分布（覆盖率信号，非候选名池）
  const distText = folderDistribution && Object.keys(folderDistribution).length
    ? `\n【用户原有收藏夹分布】（仅供理解内容整体构成，帮助发现可能遗漏的主题块；分类名由你重新设计，不要照搬原夹名）：\n${Object.entries(folderDistribution).map(([k, v]) => `${k}: ${v} 条`).join(' | ')}\n`
    : '';

  const trimmedTitles = allTitles.map((t) => (t.length > 36 ? t.slice(0, 36) + '…' : t));

  const prompt = `现在有一批收藏视频（共 ${allTitles.length} 条）需要设计一套分类体系。

请通读下面的全部视频标题，理解内容的整体构成，然后设计 **10~18 个**分类：
- 分类名简洁（2~6 字），语义明确（如"数学学习""AI编程""健身运动""历史故事"）
- **同一分类内的视频必须主题一致**：如果某个分类会混入主题不相关的视频（如把"艺考生改造"和"AI编程"放一起），说明分类太宽泛，必须拆分
- 同类必须合并：不允许出现两个分类含义重叠（如"游戏"和"游戏竞技"只能留一个）
- 覆盖全部视频内容，不要留"其他""杂项""综合"这类垃圾桶分类
- 分类数量控制在 10~18 个，宁少勿碎
- **分类规模自然**：各分类大小由内容分布决定，可大可小（有些分类可能 100+ 条，有些可能只有几条），**不要为了凑条数刻意拆分类或合并**；关键是"一个分类里的视频确实属于同一主题"，而不是"每个分类条数差不多"
- 每个分类附一句 15 字以内的定义，说明该分类**收什么、不收什么**（如"AI编程：AI 辅助编程工具与教程，不含纯数学"），用于后续归类时消除歧义

【易混类边界参考】（你的分类定义应明确收/不收）：
- "AI编程"：用 AI 辅助写代码的工具/教程/实战。不含：AI 对社会/就业的影响、AI 科学应用(造病毒/造脑)、AI 哲学讨论 → 这些应另立"AI前沿/评论"类
- "编程开发"：具体编程语言/框架/工具教程。不含：求职/面试/职业规划 → 这些应另立"职业发展"类
- "数据算法"：机器学习/统计算法本身。不含：生物学"数字脑"等字面含"数字"但非算法的内容

【步骤3 覆盖自检】设计完分类后，对照上面的【用户原有收藏夹分布】，逐个原夹检查：该夹的视频是否都有合适的分类？若发现某原夹（如"社会纪实"）整体无类可归，必须新增对应分类（如"社会时事/财经调查"）。绝不允许某原夹大量视频无类可归。
${namePoolText}${distText}${customRuleText}

只输出合法 JSON（不要 markdown 代码块），格式：
{"categories":[{"name":"分类1","desc":"一句定义"},...]}

全部视频标题（每条截断至前 36 字）：
${trimmedTitles.join('\n')}`;

  const resp = await chat(
    cfg,
    '你是一位逻辑极其严密的 B 站收藏夹整理专家，擅长设计主题一致、语义明确、规模自然的分类体系。只输出合法 JSON，不要输出任何多余内容。',
    prompt,
  );
  const raw = resp.choices?.[0]?.message?.content || '';
  const cleaned = stripCodeFence(raw);
  const parsed = JSON.parse(cleaned) as { categories?: Array<string | { name?: string; desc?: string }> };
  const cats = (parsed.categories || [])
    .map((c) => (typeof c === 'string' ? { name: c.trim(), desc: '' } : { name: String(c?.name || '').trim(), desc: String(c?.desc || '').trim() }))
    .filter((c) => c.name);
  if (!cats.length) throw new Error('AI 未返回分类体系');
  return cats.slice(0, 18);
}

/**
 * 调用 OpenAI 兼容接口进行收藏夹分类
 * @param cfg AI 配置
 * @param existingFolders 已有收藏夹名（incremental 强制匹配；full 作为候选分类名池参考）
 * @param videos 待分类视频 [{id, bvid, type, title, intro, upper}]
 * @param userRequirement 用户附加要求（可空）
 * @param mode full=全量重分类 / incremental=增量分配
 * @param establishedCats 本任务已确定的分类名（full 多批延续用；AI 优先归入这些分类，避免批间重复建类）
 * @param fixedCategories 阶段2固定分类体系：仅能使用这些分类名（full 两阶段模式）
 * @param fixedDescs 分类定义（阶段1 输出），注入 prompt 消除归类歧义
 */
export async function aiClassify(
  cfg: AiConfig,
  existingFolders: string[],
  videos: Array<{ id: number; bvid?: string; type: number; title: string; intro?: string; upper?: string; srcFolder?: string; tags?: string[] }>,
  userRequirement = '',
  mode: 'full' | 'incremental' = 'full',
  establishedCats: string[] = [],
  fixedCategories: string[] = [],
  fixedDescs: Record<string, string> = {},
): Promise<AiCategoryResult> {
  const customRuleText = userRequirement.trim()
    ? `\n\n【最高优先级】用户的特别指示是："${userRequirement.trim()}"\n必须遵守用户的分类指示。`
    : '';

  // 视频字段说明（upper=UP主名，是归类的强参考信号）
  const videoFieldHint = `待处理视频（JSON 字段：id/bvid/type 为标识，title 标题，intro 简介，upper 为UP主名（同类UP主内容往往同主题，可作参考），srcFolder 为原所在收藏夹名（仅参考，以内容为准），tags 为 B站官方标签（强信号，优先级高于标题关键词）：`;

  // 分类定义文本：有定义的分类以「名：定义」呈现，帮助阶段2 按语义而非仅按字面归类
  const fixedListText = fixedCategories
    .map((c) => (fixedDescs[c] ? `${c}：${fixedDescs[c]}` : c))
    .join('\n');

  // 全量 vs 增量，prompt 语义完全不同
  let prompt: string;
  if (mode === 'incremental') {
    // 增量模式专用长 prompt：增量单次只处理几十个视频，token 充裕，
    // 故用「详细规则 + 逐步推理 + 理由输出 + 背景知识注入」强引导弱模型（如混元3），
    // 多轮（classify.ts 的 REFINEMENT）补未分类时复用此长 prompt 做复核
    prompt = `用户已整理好收藏夹，现需把新收藏的视频归入最合适的一个已有夹。这是一个需要仔细判断的任务，请严格按步骤推理，不要跳步。

【候选目标收藏夹】（请从这些里面选，系统会自动归并近似名如"做飯"/"做饭"）：
[ ${existingFolders.length ? existingFolders.join(', ') : '暂无'} ]

【推理步骤（每一条视频都走一遍）】
1. 先读 tags（B站官方标签，强信号），再结合标题+简介，判断它的【真实内容主题】（标题可能误导，务必以 tags 为准）。
2. 对照候选夹，判断该主题与哪个夹【明显相关】。
3. 归入该夹，并写一句简短理由。

【核心原则】
- 按【内容主题】归类，绝不只看标题关键词。反例：标题含"AI"但讲就业→归"求职就业"而非"AI"；标题含"历史"但是游戏→归"游戏"；"零元购/远程控制主机"讲技术→归"技术"类而非"手工DIY"。
- 仅当视频主题与某候选夹【明显相关】才归入；不确定或无法归入任何候选夹时，放入"未分类"（宁可放未分类，也不要强行塞入不相关的夹，更不要塞回视频原本所在的源夹）。
- 【B站官方标签 tags 是强信号，优先级高于标题关键词】：tags 是 UP主/系统打的细分标签。判主题时先读 tags，再从【候选目标收藏夹】里选主题最贴切的：tags 含"远程控制/电脑/终端/DIY"→选技术/编程向的候选夹；tags 含"DeepSeek/AI/大模型"→选AI向的候选夹；tags 含"房车/旅游/出行"→选生活/旅行向的候选夹；tags 含"经济/社会"→选社会/财经向的候选夹。当 tags 与标题字面冲突时，以 tags 为准。
- 不新建任何分类。

【用户补充背景知识（最高优先级，必须严格遵守）】
${customRuleText || '（无）'}

【输出要求】必须逐条输出列表中的每一个视频（核对 id/bvid，一个都不能少）每条附归类理由：
{"thoughts":"整体判断","categories":{"分类名":[{"id":111,"bvid":"BVxxx","type":2,"reason":"归类理由"}...]}}

${videoFieldHint}
${JSON.stringify(videos)}`;
  } else if (fixedCategories.length) {
    // 两阶段模式（全量）：严格按阶段1设计的固定分类体系归类，禁止新建、禁止杂项
    prompt = `已经为用户设计好了一套分类体系，现在只需把每个视频归入最合适的分类。

【唯一允许使用的分类】（分类键名必须一字不差使用，绝不允许新建分类；冒号后是该分类的定义，按定义归类）：
${fixedListText}

严格按步骤执行：
【归类陷阱提醒】标题含某关键词≠归该类，按视频【实际内容主题】归类：
- 含"AI"但讲 AI 对社会/就业影响 → 归"AI评论/社会"，不归"AI编程"
- 含"数字"但是生物/物理的数字仿真 → 不归"数据算法"
- 含"历史"但是游戏/猜谜 → 不归"历史政治"
- 含"生产/计划"但是 ERP/管理 → 不归"编程开发"
【步骤1 逐个归类】通读每个视频标题与UP主，归入【唯一允许使用的分类】中最贴切的一个。
【步骤2 主题一致】每个分类下的视频必须主题一致；如果发现某视频与任何分类都不匹配，放入最贴近的分类，不要留空。
【步骤3 绝无遗漏】**必须在输出中包含列表中的每一个视频，一个都不能少**：输出前逐条核对 ID/BV号。${customRuleText}

只输出合法 JSON（不要 markdown 代码块），格式：
{"thoughts":"简述归类思路","categories":{"分类名":[{"id":111,"bvid":"BVxxx","type":2},...]}}

${videoFieldHint}
${JSON.stringify(videos)}`;
  } else {
    // 全量：AI 自由构建完整分类体系；已有收藏夹名作为"候选分类名池"参考（不是强约束）
    // 多批时已有分类仅供参考，允许自由新建（靠最后的归一化合并去重），
    // 避免 AI 被"优先归入已有分类"约束到漏输出
    const establishedText = establishedCats.length
      ? `之前批次的视频已经用到了以下分类名（仅供参考，视频匹配就沿用，不匹配就新建）：\n[ ${establishedCats.join(', ')} ]\n`
      : `（这是第一批视频）\n`;
    const namePoolText = existingFolders.length
      ? `用户过去的收藏夹出现过以下名字（仅供命名参考，是否使用由你判断）：\n[ ${existingFolders.join(', ')} ]\n`
      : '';
    prompt = `用户希望彻底重新整理收藏夹，由你为所有视频设计一套完整的分类体系。

${establishedText}
${namePoolText}
严格按步骤执行：
【归类陷阱提醒】标题含某关键词≠归该类，按视频【实际内容主题】归类：
- 含"AI"但讲 AI 对社会/就业影响 → 归"AI评论/社会"，不归"AI编程"
- 含"数字"但是生物/物理的数字仿真 → 不归"数据算法"
- 含"历史"但是游戏/猜谜 → 不归"历史政治"
- 含"生产/计划"但是 ERP/管理 → 不归"编程开发"
【步骤1 通读全局】先通读列表中的全部视频标题，理解整体内容构成（如：数学/编程/健身/AI/美食…）。
【步骤2 设计分类体系】设计 5~20 个合理的分类，分类名要简洁且语义明确（2~6 个字为宜，如"数学学习""AI前沿""健身运动"）。**同一分类内的视频必须主题一致**：如果你发现某个分类会混入主题不相关的视频（例如把"艺考生改造"和"AI编程"放一起），说明分类太宽泛了，必须拆分成更精确的分类。分类太少会导致漏分，分类太碎（单个视频一类）同样不行——同类视频必须合并。
【步骤3 全部归类】把每一个视频归入最合适的分类。**必须在输出中包含列表中的每一个视频，一个都不能少**：输出前逐条核对 ID/BV号，确保所有视频都已分配。不允许出现"未分类"或无法归类的视频。${customRuleText}

只输出合法 JSON（不要 markdown 代码块），格式：
{"thoughts":"简述分类体系设计思路","categories":{"分类名":[{"id":111,"bvid":"BVxxx","type":2},...]}}

${videoFieldHint}
${JSON.stringify(videos)}`;
  }

  const resp = await chat(
    cfg,
    '你是一个逻辑极其严密的 B 站收藏夹整理专家，擅长按主题一致性归类视频。输出必须是合法 JSON（不要 markdown 代码块）：{"thoughts":"简述思路","categories":{"分类名":[{"id":111,"bvid":"BVxxx","type":2},...]}}，必须包含输入列表中的每一个视频。',
    prompt,
  );
  const raw = resp.choices?.[0]?.message?.content || '';
  return JSON.parse(stripCodeFence(raw)) as AiCategoryResult;
}
