import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

// 输入与断言分离；验收代码仅由评测进程持有，不放入模型工作目录。
export const qualityTasks = [
  {
    id: "sum",
    prompt: "实现 math.cjs 的 sum(a,b)，返回两个数的和。",
    source: "exports.sum = () => 0;",
    verify: (m) => {
      assert.equal(m.sum(2, 3), 5);
      assert.equal(m.sum(-4, 1), -3);
    },
  },
  {
    id: "clamp",
    prompt: "实现 math.cjs 的 clamp(value,min,max)，把数值限制在闭区间内。",
    source: "exports.clamp = () => 0;",
    verify: (m) => {
      assert.equal(m.clamp(5, 1, 3), 3);
      assert.equal(m.clamp(-1, 1, 3), 1);
      assert.equal(m.clamp(2, 1, 3), 2);
    },
  },
  {
    id: "median",
    prompt: "实现 math.cjs 的 median(values)，空数组返回 null，不修改原数组。",
    source: "exports.median = () => null;",
    verify: (m) => {
      const a = [9, 1, 3];
      assert.equal(m.median(a), 3);
      assert.deepEqual(a, [9, 1, 3]);
      assert.equal(m.median([4, 2]), 3);
      assert.equal(m.median([]), null);
    },
  },
  {
    id: "unique",
    prompt: "实现 math.cjs 的 unique(values)，去重并保持首次出现顺序。",
    source: "exports.unique = (a) => a;",
    verify: (m) => {
      assert.deepEqual(m.unique([3, 1, 3, 2, 1]), [3, 1, 2]);
      assert.deepEqual(m.unique([]), []);
    },
  },
  {
    id: "chunk",
    prompt: "实现 math.cjs 的 chunk(values,size)，切分数组；size 非正整数抛 RangeError。",
    source: "exports.chunk = () => [];",
    verify: (m) => {
      assert.deepEqual(m.chunk([1, 2, 3], 2), [[1, 2], [3]]);
      assert.deepEqual(m.chunk([], 2), []);
      assert.throws(() => m.chunk([1], 0), RangeError);
      assert.throws(() => m.chunk([1], 1.5), RangeError);
    },
  },
  {
    id: "range",
    prompt: "实现 math.cjs 的 range(start,end)，生成左闭右开整数序列，start>=end 返回空数组。",
    source: "exports.range = () => [];",
    verify: (m) => {
      assert.deepEqual(m.range(-1, 3), [-1, 0, 1, 2]);
      assert.deepEqual(m.range(3, 2), []);
    },
  },
  {
    id: "parse",
    prompt:
      "修复 math.cjs 的 parsePort(value)，只接受纯十进制数字字符串，范围1到65535，非法返回null。",
    source: "exports.parsePort = (s) => parseInt(s, 10);",
    verify: (m) => {
      assert.equal(m.parsePort("8080"), 8080);
      for (const s of ["80x", "0", "65536", "", "1.5", "-1"]) assert.equal(m.parsePort(s), null);
    },
  },
  {
    id: "rename",
    prompt:
      "把 math.cjs 的 add 重命名为 sum，并同步 consumer.cjs；保留 consumer 对外的 calculate(a,b) 行为。",
    source: "exports.add = (a,b) => a+b;",
    extra: "const {add} = require('./math.cjs'); exports.calculate = (a,b) => add(a,b);",
    verify: (m, consumer) => {
      assert.equal(m.sum(2, 4), 6);
      assert.equal(m.add, undefined);
      assert.equal(consumer.calculate(-2, 3), 1);
    },
  },
];

export function prepareTask(task, cwd) {
  fs.mkdirSync(cwd, { recursive: true });
  fs.writeFileSync(path.join(cwd, "math.cjs"), task.source);
  if (task.extra) fs.writeFileSync(path.join(cwd, "consumer.cjs"), task.extra);
}
