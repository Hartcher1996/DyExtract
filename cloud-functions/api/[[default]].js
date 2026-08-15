// cloud-functions/api/[[default]].js — EdgeOne Pages Cloud Functions 入口
//
// 545 错误修复记录：
//   根因：EdgeOne Node14/16 运行时无全局 fetch，lib/core.js 调用 fetch 抛出
//         ReferenceError，未被捕获 → 平台返回 545 Unknown Status。
//   修复：入口文件预加载 undici 注入全局 fetch，再 require server.js。
//
// 框架模式：export default app，不调用 app.listen()
// catch-all 路由：[[default]].js 匹配 /api/* 所有子路径
// ————————————————————————————————————————————————————————————————————

import { createRequire } from 'module';
const require = createRequire(import.meta.url);

// —— 1. 预加载 undici，在任何业务代码前注入全局 fetch ——————————————
//    EdgeOne Node14/16 无全局 fetch & AbortController，必须 polyfill
try {
    const undici = require('undici');
    if (undici && undici.fetch) {
        const g = globalThis || global;
        if (!g.fetch) g.fetch = undici.fetch;
        if (!g.Headers) g.Headers = undici.Headers;
        if (!g.Request) g.Request = undici.Request;
        if (!g.Response) g.Response = undici.Response;
        if (!g.AbortController) g.AbortController = undici.AbortController;
        console.log('[EdgeOne] undici fetch polyfill 注入成功');
    }
} catch (e) {
    console.warn('[EdgeOne] undici 加载失败（解析将不可用）:', e.message);
}

// —— 2. 加载 Express 实例（含 CORS / 路由 / 错误处理 / 404 兜底）————
let app, setKVStore;
try {
    const serverMod = require('../../server.js');
    app = serverMod.app;
    setKVStore = serverMod.setKVStore;
    if (!app || typeof app !== 'function') {
        throw new Error('server.js 未导出有效的 Express app');
    }
    console.log('[EdgeOne] Express app 加载成功');
} catch (e) {
    console.error('[EdgeOne] server.js 加载失败:', e.message, e.stack);
    // 兜底：最小 Express 实例，保证不 545
    const express = require('express');
    app = express();
    app.use(express.json());
    app.use((req, res) => res.status(500).json({ error: '服务初始化失败: ' + e.message }));
    setKVStore = null;
}

// —— 3. KV 绑定（可选，失败降级内存 Map）——————————————————————————
try {
    const mod = require('@edgeone/cloudfunctions-sdk');
    if (mod?.KVNamespace?.getBinding) {
        const ns = mod.KVNamespace.getBinding('VIDEO_CACHE');
        if (ns && typeof ns.put === 'function' && typeof ns.get === 'function') {
            if (setKVStore) setKVStore(ns);
            console.log('[EdgeOne] KV 绑定成功: VIDEO_CACHE');
        } else {
            console.log('[EdgeOne] VIDEO_CACHE 未绑定，使用内存缓存');
        }
    }
} catch (e) {
    console.log('[EdgeOne] KV SDK 不可用，跳过（使用内存缓存）');
}

// —— 4. 导出 Express 实例，EdgeOne 平台自动处理请求 ————————
export default app;
