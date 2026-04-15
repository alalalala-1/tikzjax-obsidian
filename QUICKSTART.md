# Quick Start

## 30-second check

1. Build plugin:

```bash
cd /Users/apple/Develop/tikzjax-obsidian
npm run build
```

2. Ensure files are deployed to:

`/Users/apple/Documents/books/read3/.obsidian/plugins/TikzJaxObsidian/`

and include:

- `main.js`
- `tex-worker.js`
- `manifest.json`
- `styles.css`
- `resources/`

> 推荐直接复制 `release/TikzJaxObsidian/` 整个目录到 `.obsidian/plugins/`，避免漏文件。

3. In Obsidian, enable **TikzJaxObsidian**.

4. Create/open a note and paste:

````markdown
```tikzjax
%% packages: {"tikz":""}
\begin{tikzpicture}
\draw[thick,->] (0,0) -- (2,1);
\draw (0,0) circle (0.4);
\end{tikzpicture}
```
````

If this renders, plugin is working.

You can also use a full LaTeX wrapper block (now supported):

````markdown
```tikzjax
\usepackage{tikz}
\begin{document}
\begin{tikzpicture}
\draw[thick,->] (0,0) -- (2,1);
\draw (0,0) circle (0.4);
\end{tikzpicture}
\end{document}
```
````

---

## Important

- If another plugin already handles `tikz`, this plugin still works with `tikzjax` language.
- `\begin{document}` / `\end{document}` inside code blocks is now supported, but keep syntax correct.