# 🚀 Build & Install (Current Workflow)

本文件是 `INSTALL.md` 的精简版本，保留最常用步骤。

## 1. Build

```bash
cd /Users/apple/Develop/tikzjax-obsidian
npm install
npm run build
```

构建后可直接部署的文件会集中在：

- `release/TikzJaxObsidian/`

## 2. Copy to your vault

以 `read3` 为例：

```bash
mkdir -p "/Users/apple/Documents/books/read3/.obsidian/plugins"
rm -rf "/Users/apple/Documents/books/read3/.obsidian/plugins/TikzJaxObsidian"
cp -R release/TikzJaxObsidian "/Users/apple/Documents/books/read3/.obsidian/plugins/"
```

## 3. Enable plugin in Obsidian

- Settings → Community plugins → enable **TikzJaxObsidian**

> 插件目录名固定为 `TikzJaxObsidian`（与 manifest id 一致）。

## 4. Test with `tikzjax` language

如果你已经安装了其它 TikZ 插件（可能占用 `tikz` 代码块），请先使用：

````markdown
```tikzjax
%% packages: {"tikz":""}
\begin{tikzpicture}
\draw (0,0) -- (2,1);
\end{tikzpicture}
```
````

> 注意：不要在代码块里再写 `\begin{document}` / `\end{document}`。