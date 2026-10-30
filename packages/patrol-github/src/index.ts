/**
 * GitHub 的 PR Patrol forge 适配器实现。
 *
 * 只依赖 `fetch` 与 `@hajicli/core` 的契约类型，不含 CLI / TUI 依赖，
 * 因此可以作为独立包替换或新增平台实现（GitLab / Gitea 等）。
 */
export * from "./github.js";
