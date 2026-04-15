#!/bin/bash

# 下载 TikZJax 官方资源文件
# 这些文件来自 @drgrice1/tikzjax 的发布版本

echo "📦 Downloading TikZJax resources from CDN..."

# 创建资源目录
mkdir -p resources/tex_files
mkdir -p resources/fonts

CDN_BASE="https://cdn.jsdelivr.net/npm/@drgrice1/tikzjax@1.0.0-beta24/dist"

# 下载核心 WASM 文件
echo "⬇️  Downloading tex.wasm.gz..."
curl -L "${CDN_BASE}/tex.wasm.gz" -o resources/tex.wasm.gz

echo "⬇️  Downloading core.dump.gz..."
curl -L "${CDN_BASE}/core.dump.gz" -o resources/core.dump.gz

echo "⬇️  Downloading fonts.css..."
curl -L "${CDN_BASE}/fonts.css" -o resources/fonts.css

# 下载 fonts.css 中声明的全部字体文件
echo "⬇️  Downloading all fonts referenced by fonts.css..."
FONTS_LIST=$(grep -oE "fonts/[^')\"]+" resources/fonts.css | sed 's#^fonts/##' | sort -u)
FONT_COUNT=0

while IFS= read -r font; do
    [ -z "$font" ] && continue
    echo "  - $font"
    curl -L "${CDN_BASE}/fonts/$font" -o "resources/fonts/$font" 2>/dev/null || echo "    (skipped)"
    FONT_COUNT=$((FONT_COUNT + 1))
done <<EOF_FONTS
${FONTS_LIST}
EOF_FONTS

echo "✅ Downloaded ${FONT_COUNT} font files"

# 下载 tex_files（示例几个主要文件）
echo "⬇️  Downloading TeX files..."
TEX_FILES=(
    "tikz.sty.gz"
    "pgf.sty.gz"
    "pgffor.sty.gz"
    "pgfcore.code.tex.gz"
    "tikzlibrarytopaths.code.tex.gz"
)

for file in "${TEX_FILES[@]}"; do
    echo "  - $file"
    curl -L "${CDN_BASE}/tex_files/$file" -o "resources/tex_files/$file" 2>/dev/null || echo "    (skipped)"
done

echo "✅ Resource download complete!"
echo ""
echo "Downloaded files:"
ls -lh resources/

echo ""
echo "📝 Note: Worker 会自动从 CDN 加载缺失的 tex_files，因此 tex_files 可按需下载"
echo "主要的 tex.wasm.gz 和 core.dump.gz 已下载"
