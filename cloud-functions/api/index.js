// cloud-functions/api/index.js — EdgeOne Pages Cloud Functions 入口
//
// 运行模式：EdgeOne Pages Cloud Functions (Node.js v20) = HTTP 模式
// 平台要求：启动一个 HTTP 服务，监听 0.0.0.0，端口取 process.env.PORT（默认 9000）
// 不需要 export default handler；由平台把 /api/* 的请求反向代理到本地端口
//
// 注意：此文件使用 CommonJS（require/module.exports），与 package.json 默认模式一致。
//       Cloudflare Pages 使用 functions/*.js（Workers ES Module），两边入口互相独立。

const { app, setKVStore } = require('../../server.js');

const PORT = parseInt(process.env.PORT || '9000', 10);
const HOST = '0.0.0.0';

// —— 可选：尝试绑定 EdgeOne KV ————————————————————————————————————————————
// 若控制台给函数绑定了 VIDEO_CACHE 命名空间：
//   1) 通过 @edgeone/cloudfunctions-sdk 拿 KV 句柄（需要 npm 装了依赖）
//   2) 兜底：没有 SDK / 未绑定时，跳过，解析服务照常工作（因为前端走 /api/video?url= 直传）
(async function initKV() {
    try {
        // EdgeOne 把 KV 绑定名放到 process.env 里（命名规则根据控制台）
        // 有的版本用 @edgeone/cloudfunctions-sdk 访问
        const sdk = requireOptional('@edgeone/cloudfunctions-sdk');
        if (sdk && sdk.KVNamespace) {
            const ns = sdk.KVNamespace.getBinding
                ? sdk.KVNamespace.getBinding('VIDEO_CACHE')
                : null;
            if (ns && typeof ns.put === 'function' && typeof ns.get === 'function') {
                setKVStore(ns);
                console.log('[EdgeOne] KV 绑定成功: VIDEO_CACHE');
                return;
            }
        }
    } catch (e) { /* 忽略 */ }
    console.log('[EdgeOne] 未检测到 KV 绑定，继续使用内存 Map（/api/video?url= 直传不依赖 KV）');
})();

function requireOptional(name) {
    try { return require(name); } catch (_) { return null; }
}

// —— 启动 HTTP 服务 ————————————————————————————————————————————————————————
app.listen(PORT, HOST, () => {
    console.log(`[EdgeOne] DyExtract API listening on http://${HOST}:${PORT}`);
});
