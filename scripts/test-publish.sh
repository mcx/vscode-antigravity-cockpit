#!/bin/bash
# 测试发布脚本 - 用于本地验证 VSIX 包

set -e

echo "🔍 检查 VSIX 包..."

# 获取版本号
VERSION=$(node -p "require('./package.json').version")
VSIX_FILE="antigravity-cockpit-${VERSION}.vsix"

if [ ! -f "$VSIX_FILE" ]; then
    echo "❌ 错误: 未找到 $VSIX_FILE"
    echo "💡 请先运行: npm run package"
    exit 1
fi

echo "✅ 找到 VSIX 包: $VSIX_FILE"
echo ""

# 显示包信息
echo "📦 包信息:"
ls -lh "$VSIX_FILE"
echo ""

# 验证包内容
echo "📋 包内容预览:"
unzip -l "$VSIX_FILE" | head -20
echo ""

# 检查是否已发布到 Open VSX
echo "🔍 检查 Open VSX 上的版本..."
OVSX_URL="https://open-vsx.org/api/jlcodes/antigravity-cockpit/${VERSION}"
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" "$OVSX_URL")

if [ "$HTTP_CODE" = "200" ]; then
    echo "⚠️  版本 ${VERSION} 已存在于 Open VSX Registry"
    echo "💡 Open VSX 不允许重复发布相同版本"
    echo "💡 建议: 更新版本号后再发布"
    echo ""
    echo "当前版本信息:"
    curl -s "$OVSX_URL" | python3 -m json.tool | head -30
else
    echo "✅ 版本 ${VERSION} 尚未发布到 Open VSX"
    echo "💡 可以继续发布"
fi

echo ""
echo "🔗 相关链接:"
echo "  - Open VSX 扩展页面: https://open-vsx.org/extension/jlcodes/antigravity-cockpit"
echo "  - API 端点: $OVSX_URL"
