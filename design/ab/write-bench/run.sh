#!/usr/bin/env bash
# 写路径基准：在独立 git worktree 里跑固定的写任务，对照「编辑后验证」的两套探测结果。
#
# 用法（在仓库根目录）：
#   ROUNDS=2 TASKS="1 2 3" bash design/ab/write-bench/run.sh
#
# 每个 run：新建 detach worktree → 硬链接 node_modules → 先 pnpm run build 预热
# （让 tsc -b 走增量，贴近开发者本地状态）→ 跑 haji → 做正确性检查 → 拷出 trace → 删树。
set -u
REPO=${REPO:-$(git rev-parse --show-toplevel)}
WB=${WB:-/tmp/opencode/wb}
mkdir -p "$WB"
cd "$REPO" || exit 1

TASK_PROMPT_1='只改代码，不要问问题：在 packages/plugins/src/bounded-output.ts 新增导出函数 clampText(value: string, maxLength: number): string —— 超长时截断并追加「…」，返回长度不超过 maxLength；maxLength <= 1 时返回空串。再新建 packages/cli/test/bounded-output.test.mjs，用 node:test + node:assert/strict 覆盖三种情况：超长截断、长度刚好等于上限、maxLength=1。完成后运行 node --test packages/cli/test/bounded-output.test.mjs 确认通过。'
TASK_PROMPT_2='只改代码，不要问问题：把 packages/plugins/src/bounded-output.ts 导出的 truncateSingleLine 重命名为 truncateLine，并同步更新所有引用（packages/plugins/src 下的调用点与 packages/cli/test 下的测试）。不要改变任何行为。'
TASK_PROMPT_3='只改代码，不要问问题：packages/plugins/src/bounded-output.ts 的 truncateSingleLine 在 maxLength <= 1 时返回值长度会超过上限（maxLength=0 时仍返回「…」）。修掉这个边界问题，并在 packages/cli/test/bounded-output.test.mjs 补一条回归测试（文件不存在就新建）。完成后运行该测试文件确认通过。'

prompt_for() {
  case "$1" in
    1) echo "$TASK_PROMPT_1" ;;
    2) echo "$TASK_PROMPT_2" ;;
    3) echo "$TASK_PROMPT_3" ;;
  esac
}

run_one() {
  local task="$1" arm="$2" round="$3"
  local wt="$WB/w${task}-${arm}-r${round}"
  rm -rf "$wt"
  git worktree add --detach "$wt" HEAD >/dev/null 2>&1 || { echo "worktree-fail $task $arm"; return 1; }
  cp -al "$REPO/node_modules" "$wt/node_modules"
  for p in cli core plugins; do cp -a "$REPO/packages/$p/node_modules" "$wt/packages/$p/node_modules"; done
  ( cd "$wt" && pnpm run build >/dev/null 2>&1 )

  local verify_env
  case "$arm" in
    old) verify_env="npm run check --silent" ;;
    fixed) verify_env="" ;;
    off) verify_env="0" ;;
  esac

  local start end code
  start=$(date +%s)
  ( cd "$wt" && HAJI_POST_EDIT_VERIFY="$verify_env" timeout 420 haji -p "$(prompt_for "$task")" \
      --no-worktree --permission-mode bypass-permissions --output-format json \
      > "$WB/w${task}-${arm}-r${round}.json" 2> "$WB/w${task}-${arm}-r${round}.err" )
  code=$?
  end=$(date +%s)

  local tsc_ok=0 test_ok=-1 rename_ok=-1
  ( cd "$wt" && npx tsc -b >"$WB/check-tsc.log" 2>&1 ) && tsc_ok=1
  if [ "$task" = "2" ]; then
    if grep -rq "truncateSingleLine" "$wt/packages/plugins/src" "$wt/packages/cli/test" 2>/dev/null; then
      rename_ok=0
    else
      rename_ok=1
    fi
  fi
  if [ -f "$wt/packages/cli/test/bounded-output.test.mjs" ]; then
    if ( cd "$wt" && node --test packages/cli/test/bounded-output.test.mjs >"$WB/check-test.log" 2>&1 ); then
      test_ok=1
    else
      test_ok=0
    fi
  fi

  local changed
  changed=$(cd "$wt" && git status --porcelain | wc -l)
  echo "done w${task} ${arm} r${round} exit=${code} secs=$((end - start)) tsc=${tsc_ok} test=${test_ok} rename=${rename_ok} changed=${changed}"
  ( cd "$wt" && git status --porcelain > "$WB/w${task}-${arm}-r${round}.status" )
  # trace 落在工作树的 .haji/traces，删树前先拷出来，否则指标没法复核
  if [ -d "$wt/.haji/traces" ]; then
    cp -r "$wt/.haji/traces" "$WB/traces-w${task}-${arm}-r${round}" 2>/dev/null
  fi
  git worktree remove --force "$wt" >/dev/null 2>&1
}

for round in ${ROUNDS:-1}; do
  for task in ${TASKS:-1 2 3}; do
    run_one "$task" old "$round"
    run_one "$task" fixed "$round"
  done
done
