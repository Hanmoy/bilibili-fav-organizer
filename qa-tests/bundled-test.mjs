// qa-tests/gm-stub.ts
var GM_getValue = (_k, d) => d;

// src/service/classify.ts
var UNC = "\u672A\u5206\u7C7B";
var AI_PARAMS = {
  BATCH_SIZE: 50,
  // 主批大小
  REFINEMENT_ROUNDS: 3,
  // 未分类补充轮上限
  REFINEMENT_BATCH: 50,
  // 补充轮批大小
  CANDIDATE_POOL: 6,
  // 候选名池上限（existingFolders.slice 前几个）
  TITLE_TRUNCATE: 36,
  // 阶段1 标题截断字数
  INTRO_TRUNCATE: 30,
  // toAiVideos intro 截断字数
  UNC_THRESHOLD_PCT: 5,
  // 未分类补类触发百分比阈值
  UNC_THRESHOLD_ABS: 20,
  // 未分类补类触发绝对数阈值
  SRC_CONCENTRATION_PCT: 40
  // 源夹集中度预警百分比阈值
};
var WORKER_SRC = `
self.onmessage = function(e) {
  var pattern = e.data.pattern;
  var flags = e.data.flags;
  var sample = e.data.sample;
  try {
    var re = new RegExp(pattern, flags);
    // \u5BF9"\u6700\u574F\u8F93\u5165"\u8DD1 test\uFF1A\u91CD\u590D\u5B57\u7B26 + \u4E0D\u5339\u914D\u5C3E\uFF0C\u89E6\u53D1\u707E\u96BE\u6027\u56DE\u6EAF
    re.test(sample);
    self.postMessage({ safe: true });
  } catch (err) {
    self.postMessage({ safe: false, error: String(err) });
  }
};
`;
function stressTestRegex(pattern, flags, timeoutMs = 300) {
  return new Promise((resolve) => {
    let worker = null;
    let settled = false;
    const done = (r) => {
      if (settled) return;
      settled = true;
      if (worker) worker.terminate();
      resolve(r);
    };
    try {
      const blob = new Blob([WORKER_SRC], { type: "application/javascript" });
      worker = new Worker(URL.createObjectURL(blob));
      const firstChar = (pattern.match(/[a-zA-Z0-9]/) || ["a"])[0];
      const sample = firstChar.repeat(30) + "!";
      worker.onmessage = (e) => done(e.data.safe ? "safe" : "unsafe");
      worker.onerror = () => done("unknown");
      worker.postMessage({ pattern, flags, sample });
      setTimeout(() => done("unsafe"), timeoutMs);
    } catch {
      done("unknown");
    }
  });
}
function ruleFlags(r) {
  return r.caseSensitive ? "" : "i";
}
function ruleText(m, scope) {
  if (scope === "upper") return m.upper?.name || "";
  if (scope === "title_intro") return `${m.title} ${m.intro || ""}`;
  return m.title;
}
function matchOne(r, m) {
  if (!r.enabled || !r.pattern) return false;
  try {
    if (r.isRegex) {
      return new RegExp(r.pattern, ruleFlags(r)).test(ruleText(m, r.scope || "title"));
    }
    const text = ruleText(m, r.scope || "title");
    const pat = r.pattern;
    return r.caseSensitive ? text.includes(pat) : text.toLowerCase().includes(pat.toLowerCase());
  } catch {
    return false;
  }
}
var regexCache = /* @__PURE__ */ new Map();
function classifyByRules(medias, rules) {
  const result = {};
  const rest = [];
  const invalidIds = [];
  const compiled = rules.map((r) => {
    if (!r.enabled || !r.pattern) return { r, re: null };
    if (!r.isRegex) return { r, re: null };
    const key = `${r.pattern}|${ruleFlags(r)}`;
    if (regexCache.has(key)) return { r, re: regexCache.get(key) };
    try {
      const re = new RegExp(r.pattern, ruleFlags(r));
      regexCache.set(key, re);
      return { r, re };
    } catch {
      invalidIds.push(r.id);
      return { r, re: null };
    }
  });
  for (const m of medias) {
    let hit = "";
    for (const { r, re } of compiled) {
      if (!r.enabled || !r.pattern) continue;
      let matched = false;
      if (r.isRegex && re) {
        matched = re.test(ruleText(m, r.scope || "title"));
      } else if (!r.isRegex) {
        matched = matchOne(r, m);
      }
      if (matched) {
        hit = r.category;
        break;
      }
    }
    if (hit) (result[hit] ||= []).push({ ...m, category: hit });
    else rest.push(m);
  }
  return { result, rest, invalidIds };
}
function lintRegex(pattern) {
  if (!pattern) return { ok: true };
  if (/\([^)]*[+*][^)]*\)[+*{]/.test(pattern)) {
    return { ok: false, reason: "\u68C0\u6D4B\u5230\u5D4C\u5957\u91CF\u8BCD\uFF08\u5982 (a+)+\uFF09\uFF0C\u6781\u6613\u5F15\u53D1\u707E\u96BE\u6027\u56DE\u6EAF\uFF0C\u8BF7\u7B80\u5316" };
  }
  if (/\{\d{3,},\}/.test(pattern)) {
    return { ok: false, reason: "\u91CD\u590D\u6B21\u6570\u8FC7\u5927\uFF08{100+}\uFF09\uFF0C\u53EF\u80FD\u6027\u80FD\u4E0D\u4F73\uFF0C\u8BF7\u7F29\u5C0F\u8303\u56F4" };
  }
  return { ok: true };
}
async function validateRules(rules, stressTest = false) {
  const invalid = [];
  for (const r of rules) {
    if (!r.pattern) {
      invalid.push({ id: r.id, reason: "\u5339\u914D\u5185\u5BB9\u4E3A\u7A7A\uFF08\u5DF2\u81EA\u52A8\u7981\u7528\uFF09" });
      continue;
    }
    if (r.isRegex) {
      try {
        new RegExp(r.pattern, ruleFlags(r));
      } catch (e) {
        invalid.push({ id: r.id, reason: `\u6B63\u5219\u8BED\u6CD5\u9519\u8BEF\uFF1A${e instanceof Error ? e.message : e}` });
        continue;
      }
      const lint = lintRegex(r.pattern);
      if (!lint.ok) {
        invalid.push({ id: r.id, reason: lint.reason });
        continue;
      }
      if (stressTest) {
        const stress = await stressTestRegex(r.pattern, ruleFlags(r));
        if (stress === "unsafe") {
          invalid.push({ id: r.id, reason: "\u6B63\u5219\u5B58\u5728\u56DE\u6EAF\u70B8\u5F39\u98CE\u9669\uFF08\u538B\u6D4B\u8D85\u65F6\uFF09\uFF0C\u8BF7\u7B80\u5316\u6216\u6539\u7528\u5173\u952E\u8BCD\u5339\u914D" });
        }
      }
    }
  }
  return { valid: invalid.length === 0, invalid };
}
function testRules(titles, rules) {
  const active = rules.filter((r) => r.enabled && r.pattern);
  const perRule = active.map((r) => ({
    ruleId: r.id,
    pattern: r.pattern,
    category: r.category,
    hitTitles: []
  }));
  const unmatched = [];
  const conflicts = [];
  for (const title of titles) {
    const fakeMedia = { title, upper: { name: "" } };
    let firstHitIdx = -1;
    const allHitIdx = [];
    active.forEach((r, i) => {
      if (matchOne({ ...r, scope: "title" }, fakeMedia)) {
        allHitIdx.push(i);
        if (firstHitIdx < 0) firstHitIdx = i;
      }
    });
    if (firstHitIdx < 0) {
      unmatched.push(title);
    } else {
      perRule[firstHitIdx].hitTitles.push(title);
      if (allHitIdx.length > 1) {
        for (const lateIdx of allHitIdx.slice(1)) {
          conflicts.push({
            title,
            earlyRuleId: active[firstHitIdx].id,
            lateRuleId: active[lateIdx].id
          });
        }
      }
    }
  }
  return { perRule, unmatched, conflicts };
}
function summarize(result) {
  const total = Object.values(result).reduce((s, arr) => s + arr.length, 0);
  const unc = (result[UNC] || []).length;
  return { total, unc, catCount: Object.keys(result).length };
}

// src/storage/store.ts
var PREFIX = "wb_favorg_";
var K_CONFIG = `${PREFIX}config`;
var K_RECORDS = `${PREFIX}records`;
var K_TASK = `${PREFIX}task`;
function normalizeRule(r, fallbackId) {
  const pattern = typeof r?.pattern === "string" ? r.pattern : "";
  const scope = r?.scope === "title_intro" || r?.scope === "upper" ? r.scope : "title";
  return {
    id: typeof r?.id === "string" && r.id ? r.id : fallbackId,
    pattern,
    category: typeof r?.category === "string" ? r.category : "",
    isRegex: !!r?.isRegex,
    // 空 pattern 永真命中全部(#10)，强制禁用（不删用户数据，UI 红标提示）
    enabled: typeof r?.enabled === "boolean" ? r.enabled : pattern ? true : false,
    caseSensitive: !!r?.caseSensitive,
    scope
  };
}
function normalizeRules(rules) {
  if (!Array.isArray(rules)) return [];
  return rules.map((r, i) => normalizeRule(r, `migrated_${Date.now().toString(36)}_${i}`));
}
var DEFAULT_CONFIG = {
  ai: {
    baseUrl: "https://api.deepseek.com/v1",
    apiKey: "",
    model: "deepseek-chat",
    enabled: false
  },
  rules: [
    { id: "r1", pattern: "\u6559\u7A0B|\u8BFE\u7A0B|\u6559\u5B66|\u5165\u95E8", category: "\u5B66\u4E60\u6559\u7A0B", isRegex: false, enabled: true, caseSensitive: false, scope: "title" },
    { id: "r2", pattern: "\u79D1\u6280|\u6570\u7801|\u624B\u673A|\u7535\u8111|AI|\u4EBA\u5DE5\u667A\u80FD", category: "\u79D1\u6280\u6570\u7801", isRegex: false, enabled: true, caseSensitive: false, scope: "title" },
    { id: "r3", pattern: "\u97F3\u4E50|MV|\u6B4C\u66F2|\u6F14\u594F", category: "\u97F3\u4E50", isRegex: false, enabled: true, caseSensitive: false, scope: "title" },
    { id: "r4", pattern: "\u7F8E\u98DF|\u505A\u996D|\u6599\u7406|\u63A2\u5E97", category: "\u7F8E\u98DF", isRegex: false, enabled: true, caseSensitive: false, scope: "title" },
    { id: "r5", pattern: "\u6E38\u620F|\u5B9E\u51B5|\u653B\u7565|\u7535\u7ADE", category: "\u6E38\u620F", isRegex: false, enabled: true, caseSensitive: false, scope: "title" }
  ],
  pref: {
    allowAiCreate: true,
    aiBatchSize: 50,
    lastRequirement: "",
    rulesFirst: false,
    confirmTaxonomy: false
  },
  folderLastRun: {}
};
function loadConfig() {
  const saved = GM_getValue(K_CONFIG, void 0);
  if (!saved) return structuredClone(DEFAULT_CONFIG);
  return {
    ...structuredClone(DEFAULT_CONFIG),
    ...saved,
    ai: { ...DEFAULT_CONFIG.ai, ...saved.ai || {} },
    rules: saved.rules && saved.rules.length ? normalizeRules(saved.rules) : structuredClone(DEFAULT_CONFIG.rules),
    pref: { ...DEFAULT_CONFIG.pref, ...saved.pref || {}, confirmTaxonomy: typeof saved.pref?.confirmTaxonomy === "boolean" ? saved.pref.confirmTaxonomy : DEFAULT_CONFIG.pref.confirmTaxonomy },
    folderLastRun: saved.folderLastRun || {}
  };
}
function loadRecords() {
  return GM_getValue(K_RECORDS, []) || [];
}
function exportBackup() {
  const config = loadConfig();
  const redacted = { ...config, ai: { ...config.ai, apiKey: "" } };
  return JSON.stringify(
    {
      app: "bilibili-fav-organizer",
      version: 2,
      exportedAt: Date.now(),
      // 导出已自动剔除 apiKey，导入时保留本机已保存的 Key
      apiKeyRedacted: true,
      config: redacted,
      records: loadRecords()
    },
    null,
    2
  );
}
function parseBackup(text) {
  const data = JSON.parse(text);
  if (!data || typeof data !== "object") throw new Error("\u5907\u4EFD\u6587\u4EF6\u683C\u5F0F\u4E0D\u6B63\u786E");
  const base = structuredClone(DEFAULT_CONFIG);
  const src = data.config || {};
  const cfg = {
    ...base,
    ...src,
    // 嵌套对象深合并，旧版本备份缺新字段时回落默认值；rules 逐条 normalizeRule 补默认
    ai: { ...base.ai, ...src.ai || {} },
    rules: src.rules && src.rules.length ? normalizeRules(src.rules) : structuredClone(base.rules),
    pref: { ...base.pref, ...src.pref || {}, confirmTaxonomy: typeof src.pref?.confirmTaxonomy === "boolean" ? src.pref.confirmTaxonomy : base.pref.confirmTaxonomy },
    folderLastRun: src.folderLastRun || {}
  };
  const records = Array.isArray(data.records) ? data.records : [];
  return { config: cfg, records };
}

// qa-tests/test-pure.ts
var pass = 0;
var fail = 0;
var failures = [];
function assert(cond, msg, extra) {
  if (cond) {
    pass++;
  } else {
    fail++;
    failures.push(msg + (extra !== void 0 ? `
     got: ${JSON.stringify(extra)}` : ""));
    console.log("  \u274C", msg, extra !== void 0 ? `\u2192 ${JSON.stringify(extra)}` : "");
  }
}
function eq(actual, expected, msg) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) {
    assert(false, `${msg}
     expected: ${JSON.stringify(expected)}
     actual:   ${JSON.stringify(actual)}`);
  } else {
    pass++;
  }
}
function mkRule(p) {
  return { id: "x", pattern: "", category: "", isRegex: false, enabled: true, caseSensitive: false, scope: "title", ...p };
}
function mkMedia(title, extra = {}) {
  return { id: Math.random() * 1e9 | 0, type: 2, title, upper: { name: "" }, ...extra };
}
console.log("\n========== T2/A5 \u8FC1\u79FB\uFF1AparseBackup / exportBackup ==========");
{
  const v1 = JSON.stringify({
    app: "bilibili-fav-organizer",
    version: 1,
    exportedAt: 1,
    apiKeyRedacted: true,
    config: {
      ai: { baseUrl: "x", apiKey: "", model: "m", enabled: false },
      rules: [
        { id: "a", pattern: "\u6559\u7A0B", category: "\u5B66\u4E60", isRegex: false },
        { id: "b", pattern: "", category: "\u7A7A", isRegex: false },
        { id: "c", pattern: "\u79D1\u6280", category: "\u79D1\u6280", isRegex: true, caseSensitive: true, scope: "upper" },
        { id: "d", pattern: "x", category: 123, isRegex: "yes" }
      ],
      pref: { allowAiCreate: true, aiBatchSize: 50, lastRequirement: "", rulesFirst: false },
      folderLastRun: {}
    },
    records: []
  });
  const { config } = parseBackup(v1);
  const r = config.rules;
  eq(r.length, 4, "v1 \u5907\u4EFD\u8FC1\u79FB\u540E\u89C4\u5219\u6570=4");
  eq(r[0].enabled, true, "\u89C4\u5219a(\u6709pattern) enabled=true");
  eq(r[0].caseSensitive, false, "\u89C4\u5219a caseSensitive=false");
  eq(r[0].scope, "title", "\u89C4\u5219a scope=title");
  eq(r[1].enabled, false, "\u89C4\u5219b(\u7A7Apattern) enabled=false");
  eq(r[1].scope, "title", "\u89C4\u5219b scope=title");
  eq(r[2].caseSensitive, true, "\u89C4\u5219c caseSensitive=true(\u4FDD\u7559)");
  eq(r[2].scope, "upper", "\u89C4\u5219c scope=upper(\u4FDD\u7559)");
  eq(r[2].enabled, true, "\u89C4\u5219c enabled=true");
  eq(r[3].category, "", "\u89C4\u5219d category=\u975E\u5B57\u7B26\u4E32\u2192\u7A7A");
  eq(r[3].isRegex, true, "\u89C4\u5219d isRegex='yes'\u2192!!\u2192true");
  eq(r[3].enabled, true, "\u89C4\u5219d(\u6709pattern) enabled=true");
  eq(config.pref.confirmTaxonomy, false, "v1 \u5907\u4EFD pref.confirmTaxonomy \u515C\u5E95=false");
  console.log("  v1 \u5907\u4EFD\u8FC1\u79FB\u5168\u90E8\u901A\u8FC7");
}
{
  const v2 = JSON.stringify({
    app: "bilibili-fav-organizer",
    version: 2,
    exportedAt: 1,
    apiKeyRedacted: true,
    config: {
      ai: { baseUrl: "x", apiKey: "", model: "m", enabled: false },
      rules: [{ id: "a", pattern: "p", category: "c", isRegex: false, enabled: true, caseSensitive: false, scope: "title" }],
      pref: { allowAiCreate: true, aiBatchSize: 50, lastRequirement: "", rulesFirst: false, confirmTaxonomy: true },
      folderLastRun: {}
    },
    records: []
  });
  const { config } = parseBackup(v2);
  eq(config.pref.confirmTaxonomy, true, "v2 \u5907\u4EFD confirmTaxonomy=true \u4FDD\u7559");
}
{
  const txt = exportBackup();
  const obj = JSON.parse(txt);
  eq(obj.version, 2, "exportBackup version=2");
  eq(obj.apiKeyRedacted, true, "\u5BFC\u51FA\u5DF2\u8131\u654F apiKey");
  eq(obj.config.ai.apiKey, "", "\u5BFC\u51FA apiKey \u4E3A\u7A7A");
  const r0 = obj.config.rules[0];
  assert("enabled" in r0 && "caseSensitive" in r0 && "scope" in r0, "\u5BFC\u51FA\u89C4\u5219\u542B enabled/caseSensitive/scope", r0);
  eq(obj.config.pref.confirmTaxonomy, false, "\u5BFC\u51FA pref.confirmTaxonomy=false(\u9ED8\u8BA4)");
  console.log("  exportBackup \u5168\u90E8\u901A\u8FC7");
}
{
  for (const r of DEFAULT_CONFIG.rules) {
    assert(
      typeof r.enabled === "boolean" && typeof r.caseSensitive === "boolean" && typeof r.scope === "string",
      `DEFAULT_CONFIG \u89C4\u5219 ${r.id} \u542B 6 \u5B57\u6BB5`,
      r
    );
    eq(r.enabled, true, `DEFAULT_CONFIG \u89C4\u5219 ${r.id} enabled=true`);
  }
  eq(DEFAULT_CONFIG.pref.confirmTaxonomy, false, "DEFAULT_CONFIG.pref.confirmTaxonomy=false");
  console.log("  DEFAULT_CONFIG 6\u5B57\u6BB5\u5168\u90E8\u901A\u8FC7");
}
console.log("\n========== T3 lintRegex\uFF08L1 \u9759\u6001\u626B\u63CF\uFF09==========");
{
  eq(lintRegex("(a+)+").ok, false, "lintRegex (a+)+ \u4E0D\u5B89\u5168");
  assert(!!lintRegex("(a+)+").reason?.includes("\u5D4C\u5957\u91CF\u8BCD"), "(a+)+ reason \u542B\u5D4C\u5957\u91CF\u8BCD");
  eq(lintRegex("(a*)*").ok, false, "lintRegex (a*)* \u4E0D\u5B89\u5168");
  eq(lintRegex("(a+)*").ok, false, "lintRegex (a+)* \u4E0D\u5B89\u5168");
  eq(lintRegex("a{100,}").ok, false, "lintRegex a{100,} \u4E0D\u5B89\u5168");
  eq(lintRegex("").ok, true, "lintRegex \u7A7A\u4E32 ok=true");
  eq(lintRegex("\u6559\u7A0B|\u8BFE\u7A0B").ok, true, "lintRegex \u6559\u7A0B|\u8BFE\u7A0B ok=true");
  eq(lintRegex("^AI\u7F16\u7A0B$").ok, true, "lintRegex ^AI\u7F16\u7A0B$ ok=true");
  eq(lintRegex("(a+)+$").ok, false, "lintRegex (a+)+$ \u4E0D\u5B89\u5168(\u56E2\u961Flead\u7528\u4F8B)");
  console.log("  lintRegex \u5168\u90E8\u901A\u8FC7");
}
console.log("\n========== T3 ruleFlags ==========");
{
  eq(ruleFlags(mkRule({ caseSensitive: false })), "i", "caseSensitive=false \u2192 i");
  eq(ruleFlags(mkRule({ caseSensitive: true })), "", "caseSensitive=true \u2192 \u7A7A");
  console.log("  ruleFlags \u5168\u90E8\u901A\u8FC7");
}
console.log("\n========== T3 matchOne\uFF08\u7EAF\u51FD\u6570\uFF09==========");
{
  eq(matchOne(mkRule({ enabled: false, pattern: "x" }), mkMedia("x")), false, "disabled \u89C4\u5219\u4E0D\u5339\u914D");
  eq(matchOne(mkRule({ enabled: true, pattern: "" }), mkMedia("\u4EFB\u610F")), false, "\u7A7A pattern \u4E0D\u5339\u914D");
  eq(matchOne(mkRule({ pattern: "AI", isRegex: false, caseSensitive: false }), mkMedia("\u6211\u7684AI\u7F16\u7A0B")), true, "\u5173\u952E\u8BCD\u5927\u5C0F\u5199\u4E0D\u654F\u611F\u547D\u4E2D");
  eq(matchOne(mkRule({ pattern: "ai", isRegex: false, caseSensitive: false }), mkMedia("AI\u7F16\u7A0B")), true, "\u5C0F\u5199ai\u5339\u914D\u5927\u5199AI");
  eq(matchOne(mkRule({ pattern: "AI", isRegex: false, caseSensitive: true }), mkMedia("\u6211\u7684ai\u7F16\u7A0B")), false, "caseSensitive=true \u5927\u5C0F\u5199\u4E0D\u540C\u4E0D\u5339\u914D");
  eq(matchOne(mkRule({ pattern: "AI", isRegex: false, caseSensitive: true }), mkMedia("\u6211\u7684AI\u7F16\u7A0B")), true, "caseSensitive=true \u5927\u5C0F\u5199\u76F8\u540C\u5339\u914D");
  eq(matchOne(mkRule({ pattern: "\u6559(\u7A0B|\u5B66)", isRegex: true }), mkMedia("\u7F16\u7A0B\u6559\u5B66")), true, "\u6B63\u5219\u547D\u4E2D");
  eq(matchOne(mkRule({ pattern: "(unclosed", isRegex: true }), mkMedia("x")), false, "\u975E\u6CD5\u6B63\u5219 matchOne \u8FD4\u56DE false \u4E0D\u629B");
  eq(matchOne(mkRule({ pattern: "\u9690\u85CF", isRegex: false, scope: "title_intro" }), mkMedia("\u6807\u9898", { intro: "\u8FD9\u91CC\u6709\u9690\u85CF\u5185\u5BB9" })), true, "scope=title_intro \u547D\u4E2D intro");
  eq(matchOne(mkRule({ pattern: "\u9690\u85CF", isRegex: false, scope: "title" }), mkMedia("\u6807\u9898", { intro: "\u8FD9\u91CC\u6709\u9690\u85CF\u5185\u5BB9" })), false, "scope=title \u4E0D\u547D\u4E2D intro");
  eq(matchOne(mkRule({ pattern: "UP\u540D", isRegex: false, scope: "upper" }), mkMedia("\u6807\u9898", { upper: { name: "\u67D0UP\u540D\u4E3B" } })), true, "scope=upper \u547D\u4E2D upper.name");
  console.log("  matchOne \u5168\u90E8\u901A\u8FC7");
}
console.log("\n========== T3 classifyByRules ==========");
{
  const r = classifyByRules([], []);
  eq(r.result, {}, "\u7A7A\u8F93\u5165 result={}");
  eq(r.rest, [], "\u7A7A\u8F93\u5165 rest=[]");
  eq(r.invalidIds, [], "\u7A7A\u8F93\u5165 invalidIds=[]");
}
{
  const medias = [mkMedia("\u6559\u7A0BA"), mkMedia("\u6E38\u620FB")];
  const rules = [mkRule({ id: "r1", enabled: false, pattern: "\u6559\u7A0B", category: "\u5B66\u4E60" })];
  const r = classifyByRules(medias, rules);
  eq(r.rest.length, 2, "\u5168 disabled \u2192 \u5168\u8FDB rest");
  eq(Object.keys(r.result).length, 0, "\u5168 disabled \u2192 result \u7A7A");
  eq(r.invalidIds, [], "\u5168 disabled \u2192 invalidIds \u7A7A(disabled \u4E0D\u7B97 invalid)");
}
{
  const medias = [mkMedia("\u6559\u7A0BA")];
  const rules = [
    mkRule({ id: "bad", pattern: "(unclosed", isRegex: true, category: "\u574F" }),
    mkRule({ id: "good", pattern: "\u6559\u7A0B", isRegex: false, category: "\u5B66\u4E60" })
  ];
  const r = classifyByRules(medias, rules);
  eq(r.invalidIds, ["bad"], "\u975E\u6CD5\u6B63\u5219\u89C4\u5219 id \u8FDB invalidIds");
  eq(r.result["\u5B66\u4E60"]?.length, 1, "\u5408\u6CD5\u89C4\u5219\u4ECD\u6B63\u5E38\u5F52\u7C7B");
}
{
  const medias = [mkMedia("AI\u7F16\u7A0B\u5165\u95E8"), mkMedia("\u6570\u5B66\u6559\u7A0B"), mkMedia("\u65E0\u5173\u89C6\u9891")];
  const rules = [
    mkRule({ id: "r1", pattern: "AI", category: "\u7F16\u7A0B" }),
    mkRule({ id: "r2", pattern: "\u6559\u7A0B", category: "\u5B66\u4E60" })
  ];
  const r = classifyByRules(medias, rules);
  eq(r.result["\u7F16\u7A0B"]?.length, 1, "AI \u89C6\u9891\u5F52\u5165\u7F16\u7A0B");
  eq(r.result["\u5B66\u4E60"]?.length, 1, "\u6559\u7A0B\u89C6\u9891\u5F52\u5165\u5B66\u4E60");
  eq(r.rest.length, 1, "\u65E0\u5173\u89C6\u9891\u8FDB rest");
  eq(r.rest[0].title, "\u65E0\u5173\u89C6\u9891", "rest \u6807\u9898\u6B63\u786E");
}
{
  const medias = [mkMedia("abc")];
  const rules = [mkRule({ id: "r", pattern: "a(b)c", isRegex: true, category: "C" })];
  classifyByRules(medias, rules);
  const r2 = classifyByRules(medias, rules);
  eq(r2.result["C"]?.length, 1, "\u6B63\u5219\u7F13\u5B58\u547D\u4E2D\u4ECD\u6B63\u786E\u5F52\u7C7B");
}
console.log("  classifyByRules \u5168\u90E8\u901A\u8FC7");
console.log("\n========== T3 testRules ==========");
{
  const titles = ["AI\u7F16\u7A0B\u5165\u95E8", "\u6570\u5B66\u6559\u7A0B"];
  const rules = [
    mkRule({ id: "ai", pattern: "AI", category: "\u7F16\u7A0B" }),
    mkRule({ id: "edu", pattern: "\u6559\u7A0B", category: "\u5B66\u4E60" })
  ];
  const res = testRules(titles, rules);
  eq(res.perRule.length, 2, "perRule \u4E24\u6761");
  eq(res.perRule[0].hitTitles, ["AI\u7F16\u7A0B\u5165\u95E8"], "\u89C4\u5219ai \u547D\u4E2D AI\u7F16\u7A0B\u5165\u95E8");
  eq(res.perRule[1].hitTitles, ["\u6570\u5B66\u6559\u7A0B"], "\u89C4\u5219edu \u547D\u4E2D \u6570\u5B66\u6559\u7A0B");
  eq(res.unmatched, [], "\u65E0\u672A\u547D\u4E2D");
  eq(res.conflicts, [], "\u65E0\u62A2\u5360\u9884\u8B66");
}
{
  const titles = ["AI\u7F16\u7A0B\u5165\u95E8\u6559\u7A0B"];
  const rules = [
    mkRule({ id: "wide", pattern: "AI", category: "\u5BBDAI" }),
    // 靠前宽
    mkRule({ id: "narrow", pattern: "AI\u7F16\u7A0B", category: "\u7A84AI\u7F16\u7A0B" })
    // 靠后窄
  ];
  const res = testRules(titles, rules);
  eq(res.perRule[0].hitTitles, ["AI\u7F16\u7A0B\u5165\u95E8\u6559\u7A0B"], "\u9760\u524D\u5BBD\u89C4\u5219\u547D\u4E2D");
  eq(res.conflicts.length, 1, "\u4EA7\u751F 1 \u5904\u62A2\u5360\u9884\u8B66");
  eq(res.conflicts[0].earlyRuleId, "wide", "\u62A2\u5360\u65B9=wide");
  eq(res.conflicts[0].lateRuleId, "narrow", "\u88AB\u62A2\u5360\u65B9=narrow");
}
{
  const titles = ["\u6559\u7A0BA"];
  const rules = [mkRule({ id: "off", pattern: "\u6559\u7A0B", category: "X", enabled: false })];
  const res = testRules(titles, rules);
  eq(res.perRule.length, 0, "disabled \u89C4\u5219\u4E0D\u8FDB perRule");
  eq(res.unmatched, ["\u6559\u7A0BA"], "\u8FDB unmatched");
}
console.log("  testRules \u5168\u90E8\u901A\u8FC7");
console.log("\n========== T3 validateRules\uFF08L1+L2\uFF09==========");
{
  const res = await validateRules([mkRule({ id: "e", pattern: "" })], false);
  eq(res.valid, false, "\u7A7A pattern valid=false");
  assert(res.invalid[0].reason.includes("\u7A7A"), '\u7A7A pattern reason \u542B"\u7A7A"');
}
{
  const res = await validateRules([mkRule({ id: "redo", pattern: "(a+)+", isRegex: true })], true);
  eq(res.valid, false, "(a+)+ valid=false");
  assert(res.invalid.some((i) => i.reason.includes("\u5D4C\u5957") || i.reason.includes("\u56DE\u6EAF")), "(a+)+ reason \u542B\u5D4C\u5957/\u56DE\u6EAF");
}
{
  const res = await validateRules([mkRule({ id: "syn", pattern: "[unclosed", isRegex: true })], false);
  eq(res.valid, false, "\u975E\u6CD5\u6B63\u5219\u8BED\u6CD5 valid=false");
  assert(res.invalid.some((i) => i.reason.includes("\u8BED\u6CD5\u9519\u8BEF")), '\u975E\u6CD5\u6B63\u5219 reason \u542B"\u8BED\u6CD5\u9519\u8BEF"');
}
{
  const res = await validateRules([mkRule({ id: "ok", pattern: "^\u6559\u7A0B", isRegex: true })], true);
  eq(res.valid, true, "\u5408\u6CD5\u6B63\u5219 stressTest=true (L2 \u964D\u7EA7 unknown \u4E0D\u963B\u65AD) valid=true");
}
{
  const res = await validateRules([mkRule({ id: "kw", pattern: "AI", isRegex: false })], false);
  eq(res.valid, true, "\u5408\u6CD5\u5173\u952E\u8BCD valid=true");
}
{
  const res = await validateRules([
    mkRule({ id: "e", pattern: "" }),
    mkRule({ id: "ok", pattern: "AI", isRegex: false })
  ], false);
  eq(res.valid, false, "\u6DF7\u5408(\u542B\u7A7Apattern) valid=false");
  eq(res.invalid.length, 1, "\u4EC5 1 \u6761 invalid");
}
console.log("  validateRules \u5168\u90E8\u901A\u8FC7");
console.log("\n========== A2 \u9608\u503C\u903B\u8F91\uFF08\u4EE3\u7801\u5185\u8054\u8868\u8FBE\u5F0F\u590D\u7B97\uFF09==========");
{
  const UNC_THRESHOLD_ABS = AI_PARAMS.UNC_THRESHOLD_ABS;
  const UNC_THRESHOLD_PCT = AI_PARAMS.UNC_THRESHOLD_PCT;
  eq(UNC_THRESHOLD_ABS, 20, "UNC_THRESHOLD_ABS=20");
  eq(UNC_THRESHOLD_PCT, 5, "UNC_THRESHOLD_PCT=5");
  const met = (unc, total) => unc > UNC_THRESHOLD_ABS || total > 0 && unc / total * 100 > UNC_THRESHOLD_PCT;
  eq(met(30, 100), true, "30/100 \u89E6\u53D1\u8865\u7C7B(>20)");
  eq(met(10, 100), true, "10/100 \u89E6\u53D1\u8865\u7C7B(>5%, OR \u8BED\u4E49)");
  eq(met(3, 100), false, "3/100 \u4E0D\u89E6\u53D1\u8865\u7C7B");
  eq(met(21, 1e3), true, "21/1000 \u89E6\u53D1(>20)");
  console.log("  \u9608\u503C OR \u8BED\u4E49\u5168\u90E8\u901A\u8FC7");
}
console.log("\n========== summarize ==========");
{
  const s = summarize({ "\u5B66\u4E60": [mkMedia("a"), mkMedia("b")], [UNC]: [mkMedia("c")] });
  eq(s.total, 3, "summarize total=3");
  eq(s.unc, 1, "summarize unc=1");
  eq(s.catCount, 2, "summarize catCount=2");
}
console.log(`
========== \u7ED3\u679C\uFF1A${pass} passed, ${fail} failed ==========`);
if (fail > 0) {
  console.log("\n\u5931\u8D25\u7528\u4F8B\uFF1A");
  failures.forEach((f) => console.log("  - " + f));
  process.exit(1);
} else {
  console.log("\u2705 \u5168\u90E8\u5B9E\u8BC1\u6D4B\u8BD5\u901A\u8FC7");
  process.exit(0);
}
