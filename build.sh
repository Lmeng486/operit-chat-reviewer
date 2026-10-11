#!/usr/bin/env bash
# 打包 chat_reviewer 为 Operit ToolPkg
# 用法：bash build.sh [输出文件名]
set -u

SRC_DIR="$(cd "$(dirname "$0")" && pwd)"
OUT_NAME="${1:-chat_reviewer.toolpkg}"
OUT_PATH="$SRC_DIR/$OUT_NAME"

cd "$SRC_DIR" || exit 1

# 语法自检（有 node 才跑）
if command -v node >/dev/null 2>&1; then
  for f in core.js main.js packages/chat_reviewer_tools.js ui/chat_reviewer_panel/index.ui.js; do
    node --check "$f" || { echo "[FAIL] 语法错误: $f"; exit 1; }
  done
  echo "[OK] 语法自检通过"
fi

rm -f "$OUT_PATH"

# 只收清单 + 代码，排除运行时数据与打包产物
zip -q -r "$OUT_PATH" \
  manifest.json main.js core.js \
  packages ui resources \
  -x "*.toolpkg" -x "config.json" -x "history.json" -x "debug.log" -x "*.DS_Store"

echo "[OK] 已生成: $OUT_PATH"
unzip -l "$OUT_PATH"
