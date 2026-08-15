// EdgeOne Pages Cloud Functions 入口 (ESM)
// server.js 使用 CommonJS，通过动态 import 桥接加载
// 文档: https://github.com/TencentEdgeOne/express-template

export default async function handler(req, context) {
    const mod = await import('../../server.js');
    const { app, setKVStore } = mod;

    // 注入 EdgeOne KV Storage（若存在绑定则使用，否则自动降级内存缓存）
    try {
        if (context && context.env) {
            const kv = context.env.VIDEO_CACHE || context.env.KV || null;
            if (kv && typeof kv.put === 'function') {
                setKVStore(kv);
            }
        }
    } catch(e) {}

    return app(req, context);
}
