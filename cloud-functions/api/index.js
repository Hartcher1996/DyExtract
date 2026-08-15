// cloud-functions/api/index.js — EdgeOne Cloud Functions 入口
// EdgeOne Cloud Functions 基于 Node.js v20 运行时，直接复用本地 Express app
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { app, setKVStore } = require('../../server.js');

// EdgeOne 通过 context 注入 env（包含 KV 绑定）
// EdgeOne Cloud Functions 入口约定：export default async function handler(context)
export default async function handler(context) {
    const { env = {}, request } = context || {};
    if (env && env.VIDEO_CACHE) setKVStore(env.VIDEO_CACHE);

    // EdgeOne 把请求对象转给 Express 处理
    // 注：EdgeOne Node.js 运行时支持直接返回 Express app
    return app(request, new Response());
}
