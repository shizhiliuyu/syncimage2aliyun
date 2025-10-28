FROM node:18-alpine AS builder

WORKDIR /app

# 配置国内 npm 镜像源（使用淘宝镜像）
RUN npm config set registry https://registry.npmmirror.com

# 复制依赖文件
COPY package*.json ./

# 安装依赖（包括devDependencies用于某些构建）
RUN npm install

# 复制源代码
COPY . .

# ============================================
# 生产阶段：最小化镜像
# ============================================
FROM node:18-alpine

# 设置工作目录
WORKDIR /app

# 从构建阶段复制依赖和代码
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package*.json ./
COPY --from=builder /app/server.js ./

# 复制启动脚本
COPY docker-entrypoint.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# 暴露端口
EXPOSE 3000

# 启动服务
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "server.js"]


