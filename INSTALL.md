# TikzJaxObsidian 安装指南

本文档对应当前仓库代码（`tikzjax-obsidian`），适用于 Obsidian 桌面版。

> 约定：Vault 里的插件目录名统一使用 **`TikzJaxObsidian`**（与 `manifest.json` 的 `id` 一致）。

## 1) 本地构建

```bash
cd /Users/apple/Develop/tikzjax-obsidian
npm install
npm run build
```

构建后可直接发布的产物位于：

- `release/TikzJaxObsidian/main.js`
- `release/TikzJaxObsidian/tex-worker.js`
- `release/TikzJaxObsidian/manifest.json`
- `release/TikzJaxObsidian/styles.css`
- `release/TikzJaxObsidian/resources/`（含 `tex.wasm.gz`、`core.dump.gz` 等）

> `dist/` 仍会生成，但你可以只关心 `release/TikzJaxObsidian/` 这个专用发布目录。

## 2) 安装到 Vault

假设 vault 路径为：`/Users/apple/Documents/books/read3`

```bash
mkdir -p "/Users/apple/Documents/books/read3/.obsidian/plugins"
rm -rf "/Users/apple/Documents/books/read3/.obsidian/plugins/TikzJaxObsidian"
cp -R "/Users/apple/Develop/tikzjax-obsidian/release/TikzJaxObsidian" "/Users/apple/Documents/books/read3/.obsidian/plugins/"
```

## 3) 在 Obsidian 启用插件

1. 打开 `设置 -> 社区插件`
2. 启用 `TikzJaxObsidian`

> 如果你同时安装了市场插件（如 `obsidian-tikzjax`），两者都会尝试注册 `tikz` 代码块。当前版本已做兼容：
>
> - 本插件**始终支持** `tikzjax` 代码块
> - `tikz` 代码块若被其他插件占用，本插件会降级并提示你使用 `tikzjax`

## 4) 最小可用示例

推荐先用这个最简例子验证：

```markdown
```tikzjax
%% packages: {"tikz":""}
\begin{tikzpicture}
\draw[thick,->] (0,0) -- (2,1);
\draw (0,0) circle (0.4);
\end{tikzpicture}
```
```

你也可以直接写“完整 LaTeX 包装”版本（当前已支持自动检测，不会重复注入）：

```markdown
```tikzjax
\usepackage{tikz}
\begin{document}
\begin{tikzpicture}
\draw[thick,->] (0,0) -- (2,1);
\draw (0,0) circle (0.4);
\end{tikzpicture}
\end{document}
```
```

## 5) 常见问题

- 报错 `Code block postprocessor for language tikz is already registered`
  - 原因：已有其它插件占用了 `tikz`
  - 处理：改用 `tikzjax` 代码块

- 看到 `Can be used only in preamble` / `Missing \begin{document}`
  - 旧版本原因：自动拼接与手写包装冲突
  - 当前版本处理：已增加自动检测；若仍遇到问题，优先检查是否存在拼写错误（如 `\begin{document}` 写成两次 `\begin`）