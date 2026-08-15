// cloud-functions/api/[[default]].js — EdgeOne Pages Cloud Functions 入口
//
// EdgeOne 文件系统路由规则：
//   cloud-functions/api/[[default]].js → 匹配 /api/* 所有子路径（catch-all）
//
// 框架模式（Express）正确写法：
//   1. 不需要 app.listen() — 平台自动托管
//   2. 必须 export default app — 平台调用 Express 实例处理请求
//   3. 必须用 ES Module（import/export）— 官方运行时要求
//
// server.js 是 CommonJS，通过 createRequire 桥接加载
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { app, setKVStore } = require('../../server.js');

// —— KV 绑定（可选）——————————————————————————————————————————
// 前端走 /api/video?url= 直传，不依赖 KV。
// 若控制台绑定了 VIDEO_CACHE 命名空间，这里尝试注入；失败也不影响解析。
try {
    const mod = await import('@edgeone/cloudfunctions-sdk').catch(() => null);
    if (mod?.default?.KVNamespace?.getBinding) {
        const ns = mod.default.KVNamespace.getBinding('VIDEO_CACHE');
        if (ns && typeof ns.put === 'function' && typeof ns.get === 'function') {
            setKVStore(ns);
            console.log('[EdgeOne] KV 绑定成功: VIDEO_CACHE');
        }
    }
} catch (_) { /* 忽略，使用内存 Map */ }

// 导出 Express 实例，EdgeOne 平台自动处理请求路由
export default app;
