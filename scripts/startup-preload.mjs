// 启动计时 preload：在业务模块加载前记录进程最早时间戳。
// 用法：node --import ./scripts/startup-preload.mjs packages/cli/dist/index.js
globalThis.__hajiPreloadT0 = performance.now();
