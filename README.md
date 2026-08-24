# B站收藏整理台

> 一个 Tampermonkey / Violentmonkey 油猴脚本：把 B站收藏夹交给 AI 做两阶段分类，预览可编辑，一键确认后自动移动到对应收藏夹。

## 功能特性

- **两阶段 AI 分类**：先让 AI 设计分类体系，再逐条归类；每条带思维链 reason，日志实时可审查
- **两种整理模式**：
  - **增量分配**：只处理新收藏 / 少量视频，归入已有收藏夹。适合「只选 1–2 个、视频不多但分类较乱」的收藏夹做**精细化分类**
  - **全量整理**：重新设计分类体系，可新建收藏夹。适合「一整个杂乱收藏夹」做**大致分类**
- **弱模型友好**：增量模式自动抓取 B站官方标签（`/x/tag/archive/tags`）作为分类强信号，混元3 / GLM 等弱模型也能稳定归类；标签抓取失败自动降级，不影响流程
- **预览可编辑**：改名 / 视频下拉移分类 / 新建 / 删除分类，确认后再移动
- **移动进度条 + 断点续跑**：点击「确认并移动」立即显示进度；中断、刷新、风控暂停后可从断点继续，不重复移动
- **真增量**：记录各源夹基准，只处理新收藏
- **跨夹去重**：检测多余副本，可一键清理
- **分类 MD 导入 / 导出**：导出预览给外部 AI 对话整理，再回导执行（跨浏览器迁移）
- **规则行内编辑**：内置规则可现场修改，带安全校验

## 安装

1. 浏览器安装扩展：Tampermonkey 或 Violentmonkey
2. 从本项目 **Releases 页面** 下载最新 `bilibili-fav-organizer.<版本>.user.js`
3. 用扩展「安装新脚本」打开该文件，或直接拖入扩展面板

> 仓库不直接放构建产物（`dist/` 已 gitignore），发版时在 Releases 上传对应版本的 `.user.js`，保证下载到的永远是可用的完整单文件。

## 使用

1. 打开 B站「收藏夹」页面（`space.bilibili.com` 或任意 `bilibili.com` 页面）
2. 在「收藏夹总览」勾选要整理的收藏夹（可多选）
3. 选择「全量整理」或「增量分配」
4. （可选）填写整理要求，如「把 AI 相关的拆细一点；不要出现『其他』类」
5. 确认分类体系 → 编辑预览 → 点「确认并移动全部视频」，页面内实时显示移动进度

## 开发与构建

```bash
npm install
npm run dev      # 本地开发
npm run build    # tsc 类型检查 + vite 构建，产物输出到 dist/
```

版本号由 `vite.config.ts` 顶部 `VERSION` 常量单一来源驱动：改版本号 → 重新 build → 自动生成 `bilibili-fav-organizer.<版本>.user.js`，不会互相覆盖。

## 目录结构

```
src/
  main.ts             # 入口：初始化、挂载视图
  state.ts            # 全局状态 + localStorage 持久化
  types.ts            # 类型定义
  task.ts             # 任务编排：分类执行、移动(断点续跑)、去重
  service/
    bili.ts           # B站 API 封装：request 原语(节流/重试/风控)、移动、标签抓取
    classify.ts       # 两阶段分类编排（规则优先 → AI → 补未分类）
    ai.ts             # AI 调用：prompt 构建（全量/增量两套）、思维链
  views/
    organize.ts       # 智能整理视图（分类预览 / 编辑 / 移动进度）
    overview.ts       # 收藏夹总览
    settings.ts       # 设置（模型、密钥、规则等）
  utils/              # 图标、格式化、下载等
docs/                 # 方案与复盘文档
qa-tests/             # 质量测试
dist/                 # 构建产物（git 忽略，经 Releases 分发）
```

## 版本与发布流程

- 日常开发直接在 `master`（或 `main`）提交
- 每次发版：`vite.config.ts` 提升 `VERSION` → `npm run build` → 本地 git 提交并打 tag `vX.Y.Z`
- 在 GitHub Releases 创建同名 Release，上传 `dist/bilibili-fav-organizer.<版本>.user.js`

## License

MIT
