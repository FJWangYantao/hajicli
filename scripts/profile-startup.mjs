// 启动耗时测量脚本（临时诊断工具）：
//   node scripts/profile-startup.mjs [轮数]
// 通过 --import preload + dist/index.js 内置埋点（HAJI_STARTUP_PROFILE=1）
// 采集启动各阶段耗时，并记录 spawn→exit 总耗时。
import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, '..');
const cliEntry = path.join(repoRoot, 'packages', 'cli', 'dist', 'index.js');
const preload = pathToFileURL(path.join(__dirname, 'startup-preload.mjs')).href;

const rounds = parseInt(process.argv[2] || '5', 10);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const STAGE_ORDER = [
  'node_boot',
  'preference',
  'perf_monitor',
  'skill_scan',
  'trace_server',
  'tools',
  'system_prompt',
  'session_saved',
  'ui_ctor',
  'ui_started',
  'agent_manager',
  'tool_executor',
  'subagent_runner',
  'ready'
];

const results = [];
for (let i = 0; i < rounds; i++) {
  if (i > 0) await sleep(2000); // 轮间间隔，避免热缓存叠加

  const startedAt = performance.now();
  const child = spawn(process.execPath, ['--import', preload, cliEntry], {
    cwd: repoRoot,
    env: {
      ...process.env,
      HAJI_STARTUP_PROFILE: '1',
      DEEPSEEK_API_KEY: 'sk-profile-test' // 假 key：仅用于通过启动校验，不发起网络请求
    },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true
  });

  let stderr = '';
  let readyAt = null;
  child.stderr.on('data', d => {
    stderr += d;
    if (readyAt === null && stderr.includes('[startup] ready')) {
      readyAt = performance.now();
      // 就绪后立即发送 /exit，避免等待时间污染总耗时
      child.stdin.write('/exit\n');
      child.stdin.end();
    }
  });
  child.stdout.on('data', () => { /* 丢弃 UI 输出 */ });

  // 兜底：若 5s 内未就绪，强制发送 /exit
  const bailTimer = setTimeout(() => {
    if (readyAt === null) {
      child.stdin.write('/exit\n');
      child.stdin.end();
    }
  }, 5000);

  const exitCode = await new Promise(resolve => {
    const timer = setTimeout(() => {
      console.error(`round ${i + 1}: 子进程超时（15s），强制终止。stderr 前 2000 字符:\n${stderr.slice(0, 2000)}`);
      child.kill();
    }, 15000);
    child.on('exit', code => {
      clearTimeout(timer);
      clearTimeout(bailTimer);
      resolve(code);
    });
  });
  const totalMs = Math.round(performance.now() - startedAt);
  const spawnToReady = readyAt !== null ? Math.round(readyAt - startedAt) : null;

  const marks = {};
  for (const line of stderr.split('\n')) {
    const m = line.match(/\[startup\] (\S+) ([\d.]+)ms/);
    if (m) marks[m[1]] = parseFloat(m[2]);
  }

  const record = { round: i + 1, totalMs, spawnToReady, exitCode, marks };
  results.push(record);
  console.log(`round ${record.round}: total=${record.totalMs}ms spawn→ready=${record.spawnToReady ?? 'N/A'}ms exit=${record.exitCode} ready=${record.marks.ready ?? 'N/A'}ms`);
}

// 汇总表
console.log('\n=== 阶段耗时汇总（相对上一阶段的增量毫秒）===');
console.log('阶段'.padEnd(16), [...Array(rounds)].map((_, i) => `R${i + 1}`.padStart(10)).join(''), '中位数'.padStart(10));
for (const stage of STAGE_ORDER) {
  const increments = results.map(r => {
    const idx = STAGE_ORDER.indexOf(stage);
    const cur = r.marks[stage];
    if (cur === undefined) return undefined;
    if (idx === 0) return cur; // node_boot 为 preload→main 耗时
    const prev = r.marks[STAGE_ORDER[idx - 1]];
    return prev === undefined ? undefined : Math.max(0, cur - prev);
  }).filter(v => v !== undefined);
  if (increments.length === 0) continue;
  const sorted = [...increments].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  console.log(
    stage.padEnd(16),
    increments.map(v => v.toFixed(1).padStart(10)).join(''),
    median.toFixed(1).padStart(10)
  );
}

// 总耗时（进程内）与外部总耗时
console.log('\n=== 总耗时 ===');
for (const r of results) {
  const ready = r.marks.ready;
  console.log(
    `round ${r.round}: spawn→ready=${r.spawnToReady ?? 'N/A'}ms, 外部总耗时=${r.totalMs}ms, 进程内就绪=${ready !== undefined ? ready.toFixed(1) : 'N/A'}ms, 退出码=${r.exitCode}`
  );
}
