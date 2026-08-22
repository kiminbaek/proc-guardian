// proc-guardian 应用归属解析（公共模块）v1.9.0
//
// v1.9.0 修 P1-8：
//   旧实现里「列表接口」和「kill 接口」用了两套不同的应用归属逻辑：
//     - routers/processes.js GET /  内部定义 appForAll()：向上回溯父进程补 app 归属
//     - routers/processes.js POST /kill 只调 appnames.getAppName(proc)：不回溯
//     - routers/apps.js 又有第三份 appFor() 拷贝
//   后果（实测 411 进程中 4 个判定分歧）：
//     列表判 fnos_app/warn/需短语 → kill 判 user/normal/不校验 → 保护被降级
//     反向场景则会 403 拒绝用户的合法操作。
//   本模块把父进程继承逻辑抽成唯一实现，三处路由共用。

const procMod = require('./process');
const appnames = require('./appnames');

// 运行时容器类应用：进程本身归属这些「运行库」时，真正的归属应看父进程
// （例：fnOS 应用用 nodejs_v22 跑自己的 server.js，getAppName 会先命中 nodejs_v22）
const RUNTIME_APP_IDS = new Set(['nodejs_v22', 'nodejs_v24', 'python312', 'bunjs', 'go-1.26', 'java-17-openjdk']);

/**
 * 建一个解析器（每次请求建一个，内部带 pid->app 缓存避免重复回溯）。
 * @param {Array} procs 进程全集；省略时自动取 getAllProcesses()
 */
function createResolver(procs) {
    const all = Array.isArray(procs) ? procs : procMod.getAllProcesses();
    const byPid = new Map(all.map(p => [p.pid, p]));
    const cache = new Map();

    function resolve(proc, depth = 0) {
        if (!proc) return null;
        if (cache.has(proc.pid)) return cache.get(proc.pid);
        // 先占位，防止 ppid 环形引用导致无限递归
        cache.set(proc.pid, null);

        let app = appnames.getAppName(proc);

        const needParent = !app || (app.app_id && RUNTIME_APP_IDS.has(app.app_id));
        if (needParent && depth < 32 && proc.ppid && proc.ppid !== proc.pid && byPid.has(proc.ppid)) {
            const parentApp = resolve(byPid.get(proc.ppid), depth + 1);
            if (parentApp && parentApp.app_id && parentApp.app_id !== 'system') app = parentApp;
        }

        cache.set(proc.pid, app);
        return app;
    }

    return { resolve, byPid, all };
}

/**
 * 单个进程的应用归属（kill 等单点操作用）。
 * 与列表接口走同一套逻辑，保证风险判定一致。
 */
function resolveOne(proc, procs) {
    if (!proc) return null;
    return createResolver(procs).resolve(proc);
}

module.exports = { createResolver, resolveOne, RUNTIME_APP_IDS };
