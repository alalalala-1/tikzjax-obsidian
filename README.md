# TikzJaxObsidian

在 Obsidian 中渲染 TikZ 图形的社区插件工程（TypeScript + Web Worker）。

## 项目定位

- 在 Obsidian 中直接渲染 `tikzjax` / `tikz` 代码块。
- 支持本地缓存、懒加载、重渲染、缩放。
- 适配 Obsidian 桌面环境（CSP、Worker、资源路径等）。

## Base / 上游来源说明（重要）

本项目 **base（核心 TeX 运行时来源）** 来自 GitHub 上游项目：

- **TikZJax**: https://github.com/drgrice1/tikzjax

本仓库中以下文件是基于上游逻辑保留/改造的运行时核心：

- `src/core/upstream-library.js`
- `src/core/upstream-run-tex.js`

同时依赖并引用：

- **dvi2html**: https://github.com/drgrice1/dvi2html（npm 包 `@drgrice1/dvi2html`）

> 详细引用与改造边界见 `ATTRIBUTION.md`。

## 当前工程的主要改造点

- 面向 Obsidian 插件生命周期进行封装（`src/main.ts`）。
- Worker 在 Obsidian 环境下改为 Blob 方式创建，降低 `app://` 下安全限制问题。
- 字体加载改为本地 CSS 注入，兼容 CSP。
- 增强 Code 按钮行为：优先定位源码块；失败时弹出源码窗口并自动全选。
- 增强 UI（状态标签、时间标签、工具栏显隐、容器间距）。

## 构建与发布

```bash
cd /Users/apple/Develop/tikzjax-obsidian
npm install
npm run build
```

发布目录：

- `release/TikzJaxObsidian/`

安装方法见：

- `INSTALL.md`
- `BUILD_AND_INSTALL.md`
- `QUICKSTART.md`
