import { defineConfig } from 'vite';
import monkey from 'vite-plugin-monkey';

// 单一版本来源：升级时只改这一处，userscript.version 与产物文件名均引用它
const VERSION = '0.11.4';

// 本工作台通过 WorkBuddy 资料库能力（library skill）协作开发
// 构建产出单文件油猴脚本（.user.js），Tampermonkey / Violentmonkey 运行
export default defineConfig({
  build: {
    // 避免沙箱删除保护在 emptyDir 时超时；同名输出文件直接覆盖
    emptyOutDir: false,
  },
  plugins: [
    monkey({
      entry: 'src/main.ts',
      userscript: {
        name: 'B站收藏整理台',
        namespace: 'https://workbuddy.cn/bilibili-fav-organizer',
        version: VERSION,
        description: 'B站收藏夹自动分类 + AI 辅助整理的工作台插件：两阶段分类（分类定义+system角色）、AI 思维链实时日志、移动进度条、分类 MD 导入导出（跨浏览器/AI 对话整理）、任务持久化断点续跑、真增量、跨夹去重、规则行内编辑与安全校验、源夹分布与未分类补类。v0.11.4 增量模式弱模型（混元3）优化：专用长 prompt（逐步推理+每条附 reason+背景知识注入最高优先级），简介截断 30→120 字（弱模型仅凭短简介易误判如"零元购→远程控制主机"），配合候选池排除源夹与多轮补未分类，针对性改善弱模型语义理解。',
        author: 'B站收藏整理台',
        match: ['https://space.bilibili.com/*', 'https://www.bilibili.com/*'],
        'run-at': 'document-end',
        connect: ['api.bilibili.com', '*'],
        grant: ['GM_setValue', 'GM_getValue', 'GM_deleteValue', 'GM_xmlhttpRequest'],
      },
      build: {
        // 产物名自动带版本号：每次构建生成 bilibili-fav-organizer.<版本>.user.js，永不互相覆盖
        fileName: `bilibili-fav-organizer.${VERSION}.user.js`,
        metaFileName: true,
      },
    }),
  ],
});
