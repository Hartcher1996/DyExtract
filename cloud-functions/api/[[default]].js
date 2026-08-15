// cloud-functions/api/[[default]].js — EdgeOne Pages Cloud Functions 入口
//
// 545/504 错误修复记录：
//   v1: 545 = Node14 无全局 fetch → 加 undici polyfill
//   v2: 504 = undici 太重，冷启动超时 → 移除 undici，lib/core.js 自动降级到 Node http/https
//   最终方案：零第三方依赖，nativeRequest 运行时检测 fetch 可用性
//
// 框架模式：export default app，不调用 app.listen()
// catch-all 路由：[[default]].js 匹配 /api/* 所有子路径
// ————————————————————————————————————————————————————————————————————

import { createRequire } from 'module';
const require = createRequire(import.meta.url);

// —— 1. 加载 Express 实例（含 CORS / 路由 / 错误处理 / 404 兜底）————
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
    const express = require('express');
    app = express();
    app.use(express.json());
    app.use((req, res) => res.status(500).json({ error: '服务初始化失败: ' + e.message }));
    setKVStore = null;
}

// —— 2. KV 绑定（可选，失败降级内存 Map）——————————————————————————
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

// —— 3. 导出 Express 实例，EdgeOne 平台自动处理请求 ————————
export default app;
