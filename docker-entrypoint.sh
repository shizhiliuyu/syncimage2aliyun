#!/bin/sh
set -e

echo "🚀 容器启动中..."

# 创建必要的目录
echo "📁 创建目录和文件..."
mkdir -p /app/logs

# 创建 images.txt（如果不存在）
if [ ! -f /app/images.txt ]; then
  touch /app/images.txt
fi

# 创建备份文件（如果不存在）
if [ ! -f /app/images.txt.bak ]; then
  cp /app/images.txt /app/images.txt.bak 2>/dev/null || touch /app/images.txt.bak
  echo "✅ 已创建备份文件"
fi

echo "📁 /app 目录内容:"
ls -la /app/

echo "🚀 启动 Node.js 服务..."

# 执行传入的命令
exec "$@"

