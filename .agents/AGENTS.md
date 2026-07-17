# AGENTS.md — hajicli 项目约束规则

> 本文件定义了 AI 模型在辅助开发 hajicli 时的**强制性行为约束**。
> 所有参与本项目代码编辑的 AI Agent 必须严格遵守以下规则，无例外。

---

## 1. Project Identity（项目身份）

- **项目名称**: hajicli
- **项目定位**: 一个轻量级终端内 AI 辅助编程 CLI 工具，类似 Aider / Claude Code
- **技术栈**: TypeScript + Node.js
- **项目结构**: 分包架构（monorepo 风格），核心模块分离
  ```
  packages/
    core/       # 核心逻辑：模型调用、上下文管理、diff 引擎等
    cli/        # CLI 入口：命令解析、终端 UI、用户交互
    plugins/    # 插件系统：可插拔的模型提供商、工具扩展
  ```
- **模型接入**: 可插拔多提供商架构（OpenAI / Anthropic / Google 等）

---

## 2. Absolute Red Lines（绝对红线 🚫）

以下行为**严格禁止**，违反任何一条即视为不合格输出：

### 2.1 文件操作红线
- **🚫 禁止删除**任何我未明确要求删除的文件
- **🚫 禁止创建**任何我未明确指示创建的新文件
- **🚫 禁止重构/重命名**我未提到的文件或目录
- **🚫 禁止移动**文件到不同的目录位置，除非我明确要求

### 2.2 代码修改红线
- **🚫 禁止删除或修改**任何现有注释（包括 `// TODO`、`// FIXME`、`// HACK`、`// NOTE` 等）
- **🚫 禁止引入新的依赖包**（npm package）而不先征得我的明确同意
- **🚫 禁止生成占位符代码**（如 `// TODO: implement this`、`throw new Error('Not implemented')` 等空实现），要写就写完整
- **🚫 禁止大范围重写**我没有要求修改的代码区域
- **🚫 禁止修改** `.env`、`.gitignore`、`tsconfig.json`、`package.json` 等配置文件，除非我明确要求

### 2.3 行为红线
- **🚫 禁止自主执行**任何 shell 命令（包括但不限于 `npm install`、`git commit`、`rm`、`mv`）
- **🚫 禁止假设**项目中不存在的文件内容——如果你不确定，先问我
- **🚫 禁止跳过错误处理**——所有新增代码必须包含适当的 error handling

---

## 3. Mandatory Workflow（强制工作流程）

所有代码修改任务**必须严格按以下流程执行**，不得跳步：

### Step 1: Understand（理解）
- 仔细阅读我的需求描述
- 如果有任何模糊之处，**必须先提问澄清**，不得自行揣测
- 列出你对需求的理解，等我确认

### Step 2: Analyze（分析）
- 阅读并理解所有相关的现有代码
- 明确指出你阅读了哪些文件
- 分析当前代码的 pattern（命名风格、错误处理方式、import 风格等）

### Step 3: Plan（计划）
- 在动手写代码之前，先给出**详细的修改计划**：
  - 要修改哪些文件
  - 每个文件具体改什么
  - 为什么这样改
  - 预计影响范围
- **等待我明确批准后**才能进入下一步

### Step 4: Execute（执行）
- 严格按照我批准的计划进行修改
- 每次修改必须是 **minimal change**（最小化变更）
- 不得在执行过程中偏离计划；如果发现需要额外修改，必须先暂停并向我说明

### Step 5: Review（回顾）
- 修改完成后，给出变更摘要
- 列出所有被修改的文件和修改点
- 说明如何验证修改是否正确

---

## 4. Code Style Constraints（代码风格约束）

### 4.1 通用规则
- **遵循项目已有的代码风格**——包括缩进、命名规范、import 组织方式
- 使用 **2 空格缩进**（TypeScript 标准）
- 使用 **单引号** 作为字符串引号（除非项目中已有不同惯例）
- 所有 public API 必须有 **JSDoc 注释**
- **所有代码注释必须使用中文**（Write code comments in Chinese）
- 文件命名使用 **kebab-case**（如 `model-provider.ts`）
- 类名使用 **PascalCase**，变量/函数使用 **camelCase**
- 常量使用 **UPPER_SNAKE_CASE**

### 4.2 TypeScript 特定规则
- **优先使用 `interface`** 而非 `type`（除非需要 union type 等 `interface` 无法表达的特性）
- **禁止使用 `any`**——使用 `unknown` 并做类型收窄
- 所有函数参数和返回值**必须有明确类型标注**
- 使用 **`async/await`** 而非裸 Promise chain
- Error handling 使用**自定义 Error 类**，不得直接 `throw new Error('...')`

### 4.3 Import 规则
- 使用 ESM（`import/export`），不使用 CommonJS（`require`）
- Import 顺序：
  1. Node.js 内置模块（`node:fs`, `node:path` 等，使用 `node:` prefix）
  2. 第三方依赖
  3. 项目内部模块（使用 package alias，如 `@hajicli/core`）
  4. 相对路径 import
- 各组之间用空行分隔

---

## 5. Architecture Principles（架构原则）

### 5.1 分包职责
| Package | 职责 | 不应包含 |
|---|---|---|
| `@hajicli/core` | 模型调用抽象、上下文管理、diff 计算、文件操作引擎 | CLI 相关逻辑、终端 UI 代码 |
| `@hajicli/cli` | 命令解析、终端 UI 渲染、用户输入处理、会话管理 | 直接的模型 API 调用 |
| `@hajicli/plugins` | 模型提供商实现（OpenAI/Claude/Gemini）、工具扩展 | CLI 相关逻辑 |

### 5.2 依赖方向
```
cli → core ← plugins
```
- `cli` 依赖 `core`
- `plugins` 依赖 `core`
- `core` **不依赖** `cli` 或 `plugins`
- `cli` 和 `plugins` 之间**不直接依赖**

### 5.3 设计模式
- 模型提供商使用 **Provider Pattern**（接口 + 多实现）
- 配置管理使用 **分层配置**（默认值 → 项目级 → 环境变量 → 命令行参数）
- 插件使用**注册机制**，core 暴露 registry，plugin 自行注册

---

## 6. Communication Rules（沟通规则）

### 6.1 回复格式
- 代码块必须标注语言（```typescript, ```bash 等）
- 修改现有代码时，**必须展示完整的 diff**（使用 ```diff 块）或注明具体行号
- 不要重复输出未修改的大段代码——只展示变更部分及必要上下文
- **所有方案设计与实现计划（如 implementation_plan.md）必须使用中文编写**（Write implementation plans in Chinese）

### 6.2 提问义务
当遇到以下情况时，**必须先向我提问**，而非自行做出选择：
- 需求存在多种合理的实现方式
- 需要在性能和可读性之间做取舍
- 不确定某个功能的具体行为
- 发现现有代码中可能存在的 bug
- 需要添加新的依赖

### 6.3 诚实义务
- 如果你不确定某件事，**明确说"我不确定"**，不得编造
- 如果你的方案有已知的局限性或 trade-off，**必须主动说明**
- 如果某个需求超出了你的能力范围，**直接告诉我**

---

## 7. Testing Rules（测试规则）

- 新增功能代码时，如果我要求写测试，使用 **Vitest** 作为测试框架
- 测试文件与源文件同目录，命名为 `*.test.ts`
- 每个测试用例必须有清晰的描述（`describe` + `it` 用中文或英文均可，但全项目保持一致）
- **不得在没有我要求的情况下自行添加测试文件**

---

## 8. Git Convention（Git 约定）

- Commit message 格式：`<type>(<scope>): <description>`
  - type: `feat` | `fix` | `refactor` | `docs` | `test` | `chore`
  - scope: `core` | `cli` | `plugins` | 省略
  - description: 用英文，简洁明了
- 示例：`feat(core): add provider registry for model plugins`
- **不得由 AI 自行执行 git 命令**——所有 git 操作由我手动执行

---

## Summary / 总结

**核心原则：最小化、可控、透明**

1. **最小化** — 只改你被要求改的东西
2. **可控** — 每一步都要经过我的确认
3. **透明** — 你做了什么、为什么做、影响是什么，全部说清楚

> ⚠️ 如果你对本文件中的任何规则有疑问或发现冲突，请先向我确认，不要自行解读。
