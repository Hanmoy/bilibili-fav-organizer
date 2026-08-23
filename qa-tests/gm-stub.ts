// GM API 桩（仅供 QA 实证测试在 Node 里 import 真实源码用）
// 通过 tsconfig paths 把 'vite-plugin-monkey/dist/client' 重定向到本文件
export const GM_getValue = (_k: string, d?: unknown) => d;
export const GM_setValue = () => undefined;
export const GM_deleteValue = () => undefined;
export const GM_xmlhttpRequest = () => undefined;
export const GM_addStyle = () => undefined;
export const GM_addElement = () => undefined;
export const GM_info: any = {};
export const GM: any = undefined;
export const unsafeWindow: any = {};
