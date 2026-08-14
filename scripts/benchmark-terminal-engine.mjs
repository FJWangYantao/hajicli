import { performance } from 'node:perf_hooks';
import {
  getNativeTerminalEngineStatus,
  tryNativeLayoutAnsiDocument,
  tryNativeWrapAnsi
} from '../packages/cli/dist/native-terminal-engine.js';
import {
  layoutAnsiDocumentFallback,
  wrapAnsiWithStateFallback
} from '../packages/cli/dist/terminal-input.js';

const status = getNativeTerminalEngineStatus();
if (!status.available) {
  throw new Error(`Native terminal engine unavailable: ${status.error || status.mode}`);
}

function measure(operation, iterations = 20) {
  operation();
  const samples = [];
  for (let index = 0; index < iterations; index += 1) {
    const startedAt = performance.now();
    operation();
    samples.push(performance.now() - startedAt);
  }
  samples.sort((left, right) => left - right);
  return {
    median: samples[Math.floor(samples.length / 2)],
    p95: samples[Math.ceil(samples.length * 0.95) - 1]
  };
}

for (const size of [64_000, 160_000]) {
  const value = ('中文 ANSI 文本和 emoji 🙂 abcdefghijklmnopqrstuvwxyz\n')
    .repeat(Math.ceil(size / 45))
    .slice(0, size);
  const rows = [
    ['wrap/typescript', measure(() => wrapAnsiWithStateFallback(value, 119))],
    ['wrap/rust', measure(() => tryNativeWrapAnsi(value, 119))],
    ['layout/typescript', measure(() => layoutAnsiDocumentFallback(value, 119))],
    ['layout/rust', measure(() => tryNativeLayoutAnsiDocument(value, 119))]
  ];
  console.log(`\n${size.toLocaleString()} characters`);
  for (const [name, result] of rows) {
    console.log(
      `${name.padEnd(20)} median ${result.median.toFixed(2).padStart(8)}ms`
      + `  p95 ${result.p95.toFixed(2).padStart(8)}ms`
    );
  }
}
