# QA 覆盖度审计报告

## 测试文件覆盖的功能点

| 测试文件 | 覆盖功能点 |
|---|---|
| `qa-tests/test-pure.ts` | • 备份迁移 (`parseBackup`, `exportBackup`, `DEFAULT_CONFIG`)<br>• L1 正则安全扫描 (`lintRegex`)<br>• 规则字段默认填充 (`ruleFlags`)<br>• 匹配逻辑 (`matchOne` 包含 `scope`、`enabled`、`pattern` 规则)<br>• 分类主流程 (`classifyByRules`，包含 `invalidIds`、`rest`、`result`)<br>• 规则测试接口 (`testRules`，包括 `perRule`、`unmatched`、`conflicts`)<br>• 正则/规则校验 (`validateRules`，L1 嵌套量词、语法错误、空 pattern)<br>• UNC 阈值逻辑 (`AI_PARAMS.UNC_THRESHOLD_ABS/PCT`)<br>• 汇总统计 (`summarize`） |
| `qa-tests/gm-stub.ts` | • GM API 桩，仅为实证测试提供的环境占位符 |

## 自 v0.9.0 以来已变更但无测试覆盖的功能

1. **增量模式候选池截断修复**（v0.13.1 / v0.11.1）：`classify.ts` 中对增量模式 `aiRefs` 取消 `slice(0, AI_PARAMS.CANDIDATE_POOL)`，确保完整 `existingFolders` 参与匹配。
2. **增量模式 AI Prompt 放宽**（v0.11.2）：放宽增量模式强约束，改为允许近似匹配并在无匹配时给出诊断警告。
3. **超大分类检测日志**（v0.8.1 / v0.8.x）：`classify.ts` 在分类结果遍历时对超过 70 条的分类输出警告日志。
4. **失效视频一键清空功能**（v0.10.0 及后续）：`cleanFolderInvalids` 新增 API 调用与 UI 按钮。
5. **分类均衡约束（阶段1 规模预估）**（v0.8.0）：在 `aiDesignCategories` 提示 AI 设计分类时加入每类目标规模约束。
6. **规则编辑 UI 改造**（v0.9.0+）：行内编辑、规则优先级 UI 改动未在单元测试中捕获。
7. **AI 参数集中化（AI_PARAMS）**：如 `CANDIDATE_POOL`, `UNC_THRESHOLD_ABS/PCT` 的新增与默认值调整未直接由现有测试验证。\n## 测试覆盖建议

- 为 **增量模式候选池** 与 **增量模式 Prompt** 添加针对 `mode === 'incremental'` 的实证测试，断言 `aiRefs` 包含全部文件夹并验证在强约束删除后的日志输出。
- 为 **超大分类检测** 增加模拟 `finalResult` 超过阈值的情形，验证 `logs` 包含相应警告信息。
- 为 **失效视频清空** 编写调用 `cleanFolderInvalids` 的单元测试，确保正确的 API 参数构造。
- 为 **分类均衡约束** 在 `aiDesignCategories` 中加入返回的 `categories` 数量与规模评估的断言。
