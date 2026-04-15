# Attribution / 上游引用说明

本文档用于明确本仓库的上游基础与引用边界。

## 1) Base 项目

本项目的 TeX/TikZ 运行时能力基于以下 GitHub 项目：

- **drgrice1/tikzjax**  
  https://github.com/drgrice1/tikzjax

在本仓库中，以下文件体现了对上游实现的保留与适配：

- `src/core/upstream-library.js`
- `src/core/upstream-run-tex.js`

这些文件用于保留上游核心运行机制，并在本项目中作为对照/上游来源。

## 2) 关键依赖引用

- **@drgrice1/dvi2html**（上游仓库：`drgrice1/dvi2html`）  
  https://github.com/drgrice1/dvi2html

本项目通过 npm 依赖方式引用该库以完成 DVI -> SVG/HTML 转换能力。

## 3) 本项目新增与改造范围

相对上游，本仓库主要新增/改造内容包括：

- Obsidian 插件化封装（生命周期、设置页、渲染流程）。
- Worker 启动方式适配（Blob Worker，减少 `app://` 环境限制问题）。
- 本地资源与字体注入策略（兼容 Obsidian CSP 场景）。
- 缓存管理、状态标签、UI 工具栏与 Code 交互增强。
- 发布与部署流程（`release/TikzJaxObsidian/`）整理。

## 4) 说明

本项目保留并尊重上游项目与依赖项目的许可协议与署名要求。若后续分发/二次开发，请继续保留本文件与 README 中的上游引用信息。
