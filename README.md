# 企业微信应用 - 镜像同步服务

通过企业微信应用接收消息，自动触发 GitHub Action 实现 Docker 镜像的拉取、标记和推送。

## 功能特性

- ✅ **简化输入** - 只需发送镜像名称，目标仓库自动配置
- ✅ **多镜像支持** - 支持单个或多个镜像（逗号、空格、换行分隔）
- ✅ **平台架构** - 支持指定平台架构（linux/amd64, linux/arm64）
- ✅ **自动提交** - 自动使用 GitHub API 更新镜像列表
- ✅ **并发处理** - 后台并发处理多个镜像同步任务
- ✅ **实时反馈** - 自动返回执行结果（成功/失败/超时）
- ✅ **任务队列** - 防止并发冲突，同一时间只处理一个任务
- ✅ **文件缓存** - Token 缓存优化，减少 API 调用
- ✅ **定时清理** - 每天凌晨自动重置镜像列表

## 工作流程

```
企业微信消息 
  ↓
解析命令并更新 images.txt（通过 GitHub API）
  ↓
触发 GitHub Action（监听 images.txt 文件变更）
  ↓
GitHub Action 并发执行镜像 pull/tag/push 
  ↓
企业微信返回执行结果
  ├─ ✅ 成功：显示同步成功的镜像列表
  ├─ ❌ 失败：显示失败的镜像和错误原因
  └─ ⏳ 超时：提示查看详情链接
```

## 快速开始

### 1. Fork 项目到自己的 GitHub

1. 访问本项目仓库
2. 点击右上角的 **Fork** 按钮
3. 选择要 Fork 到的账号
4. 等待 Fork 完成

### 2. 配置 GitHub Secrets（必须先配置）

在你的 Fork 仓库中配置 GitHub Secrets：

1. 进入你的 GitHub 仓库
2. 点击 **Settings** → **Secrets and variables** → **Actions**
3. 点击 **"New repository secret"**

**添加以下 3 个 Secrets：**

| Secret 名称 | 说明 | 获取方式 |
|------------|------|--------|
| `DOCKER_USERNAME` | 阿里云容器镜像服务的用户名 | 登录 [阿里云容器镜像服务](https://cr.console.aliyun.com/) → 访问凭证 → 设置固定密码 |
| `DOCKER_PASSWORD` | 阿里云密码或访问令牌 | 同上 |
| `DOCKER_REGISTRY` | 阿里云仓库地址 | `registry.cn-hangzhou.aliyuncs.com` |

### 3. Clone 项目到本地

```bash
git clone https://github.com/your-username/image-pull-push.git
cd image-pull-push
```

### 4. 配置环境变量

```bash
cp env.example .env
vi .env
```

必需配置：

```env
# 企业微信
WECHAT_CORP_ID=企业ID
WECHAT_AGENT_ID=应用ID
WECHAT_SECRET=应用密钥
WECHAT_TOKEN=回调Token
WECHAT_ENCODING_AES_KEY=加解密密钥

# GitHub
GITHUB_TOKEN=个人访问令牌（需要 repo 和 workflow 权限）
GITHUB_REPO=your-username/image-pull-push       # 你 Fork 后的仓库地址
GITHUB_EMAIL=bot@example.com
GITHUB_NAME=Image Sync Bot

# 阿里云仓库（自动映射）
ALIYUN_REGISTRY=registry.cn-hangzhou.aliyuncs.com
ALIYUN_NAMESPACE=my-namespace
```

### 5. 启动服务

**Docker Compose 部署：**
```bash
docker-compose up -d
docker-compose logs -f
```

**原生部署：**
```bash
npm install
npm start
```

### 6. 配置企业微信回调

在[企业微信管理后台](https://work.weixin.qq.com/)配置：
- **回调 URL**: `http://your-domain.com:port/wechat/callback`
- **Token**: 与 `.env` 中的 `WECHAT_TOKEN` 完全一致

⚠️ **重要**：
1. Token 必须与 `.env` 中的 `WECHAT_TOKEN` 完全一致
2. **必须选择"明文模式"**，否则验证会失败
3. 配置保存后会自动验证回调 URL
4. 验证成功后，配置将自动保存

### 5. 使用方式

#### 支持的输入格式

**单个镜像：**
```
nginx:latest
nginx              # 自动添加 :latest
```

**多个镜像（逗号分隔）：**
```
nginx, redis, mysql
nginx:latest, redis:7.0, mysql:8.0
```

**多个镜像（空格分隔）：**
```
nginx redis mysql
nginx:latest redis:7.0 mysql:8.0
```

**多个镜像（换行）：**
```
nginx:latest
redis:7.0
mysql:8.0
```

**指定平台架构：**
```
--platform=linux/amd64 nginx:latest
--platform=linux/arm64 redis:7.0
```

**组合使用：**
```
--platform=linux/amd64 nginx redis mysql
```

#### 消息反馈

系统会自动发送 2 条消息：

1. **收到请求时**：确认镜像列表
   ```
   🔄 正在处理镜像同步请求...
   共 3 个镜像：
   1. nginx:latest → registry.cn-hangzhou.aliyuncs.com/namespace/nginx:latest
   2. redis:7.0 → registry.cn-hangzhou.aliyuncs.com/namespace/redis:7.0
   3. mysql:8.0 → registry.cn-hangzhou.aliyuncs.com/namespace/mysql:8.0
   ```

2. **完成后**：返回执行结果
   - ✅ 成功：显示同步成功的镜像数量
   - ❌ 失败：显示失败的镜像列表和错误原因
   - ⏳ 超时：提示查看详情

## 项目结构

```
.
├── .github/workflows/
│   └── docker-image-sync.yml     # GitHub Action 工作流
├── server.js                     # 核心服务（处理企业微信回调）
├── package.json                  # Node.js 依赖
├── images.txt                    # 镜像同步列表
├── env.example                   # 环境变量模板
├── Dockerfile                    # Docker 镜像配置
├── docker-compose.yml            # Docker Compose 配置
├── docker-entrypoint.sh          # 容器启动脚本
└── README.md                     # 本文档
```

## 技术架构

- **服务端**: Node.js + Express.js
- **消息处理**: 企业微信回调 + AES 解密
- **镜像同步**: GitHub Actions + Docker
- **存储**: GitHub API（直接更新文件）
- **并发控制**: 文件锁 + 任务状态管理

## 配置说明

### 企业微信配置

1. 登录[企业微信管理后台](https://work.weixin.qq.com/)
2. 创建应用获取：
   - CORP_ID：企业 ID
   - AGENT_ID：应用 ID
   - SECRET：应用密钥
   - TOKEN：回调 Token
   - ENCODING_AES_KEY：加解密密钥

### GitHub 配置

#### 1. 获取 GitHub Token

详细步骤：

1. 访问 [GitHub Settings > Tokens](https://github.com/settings/tokens)
2. 点击 **"Generate new token"** → **"Generate new token (classic)"**
3. 填写 Token 名称（如：image-sync-token）
4. 设置过期时间（建议：90 days 或 No expiration）
5. 勾选以下权限：
   - ✅ **repo** - 完整仓库权限（包括 push）
   - ✅ **workflow** - 工作流权限
6. 点击 **"Generate token"**
7. **立即复制 Token**（只会显示一次）
   - 格式：`ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx`

将 Token 填写到 `.env` 文件中：
```env
GITHUB_TOKEN=ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

#### 2. 配置 GitHub Secrets（阿里云登录信息）

GitHub Action 需要使用阿里云登录信息来推送镜像，需要在 GitHub Secrets 中配置：

**步骤：**

1. 进入你的 GitHub 仓库
2. 点击 **Settings** → **Secrets and variables** → **Actions**
3. 点击 **"New repository secret"**

**添加以下 3 个 Secrets：**

| Secret 名称 | 说明 | 示例值 |
|------------|------|--------|
| `DOCKER_USERNAME` | 阿里云容器镜像服务的用户名 | `your-username` |
| `DOCKER_PASSWORD` | 阿里云密码或访问令牌 | `your-password` |
| `DOCKER_REGISTRY` | 阿里云仓库地址 | `registry.cn-hangzhou.aliyuncs.com` |

**获取阿里云凭据：**

1. 登录 [阿里云容器镜像服务](https://cr.console.aliyun.com/)
2. 点击 **访问凭证** → **设置固定密码**（或使用访问令牌）
3. 复制**用户名**和**密码**
4. 分别填入 GitHub Secrets

**如何验证配置：**

在 GitHub Actions 日志中查看是否成功登录：
```
正在登录到 Docker 仓库...
Login Succeeded
```

### FRP 内网穿透配置（可选）

适用于内网服务器场景：

1. **FRP 服务端（公网服务器）配置**
   - 安装 FRP Server
   - 配置 `frps.ini`
   - 启动服务

2. **FRP 客户端（内网服务器）配置**
   - 安装 FRP Client
   - 配置 `frpc.ini`
   - 启动服务

3. **企业微信回调配置**
   - 使用 FRP 映射的域名/端口配置回调 URL

## 使用示例

### 单个镜像
```
nginx:latest
```
自动映射到：`registry.cn-hangzhou.aliyuncs.com/my-namespace/nginx:latest`

### 多个镜像
```
nginx, redis, mysql
alpine:3.18 ubuntu:22.04
```

### 支持的镜像源
- Docker Hub: `nginx:latest`
- GCR: `gcr.io/google-containers/busybox:1.2`
- K8s: `k8s.gcr.io/pause:3.9`

## API 调用限制

企业微信 API 调用限制：
- 消息发送：每分钟最多 600 次
- Token 有效期：7200 秒（2小时）
- 本项目会自动缓存 Token，减少 API 调用

## 故障排查

### 回调验证失败

**症状**：企业微信后台提示"回调验证失败"

**解决方案**：
1. 检查 `.env` 中的 `WECHAT_TOKEN` 是否与企业微信后台配置一致
2. 确保选择了"明文模式"（不是"安全模式"）
3. 查看服务器日志：
   ```bash
   docker-compose logs -f
   ```
4. 验证回调 URL 是否可访问

### 镜像同步失败

**症状**：GitHub Actions 执行失败

**检查项**：
1. GitHub Secrets 配置是否正确
   - `DOCKER_USERNAME`
   - `DOCKER_PASSWORD`
   - `DOCKER_REGISTRY`
2. 镜像名称是否正确（不存在或网络问题）
3. 查看 GitHub Actions 日志：
   ```
   https://github.com/owner/repo/actions
   ```

### 任务冲突

**症状**：提示"已有任务正在处理中"

**说明**：系统同一时间只处理一个任务，请等待当前任务完成后再试

**解决**：
- 等待 5-10 分钟后再发送新请求
- 查看当前任务的 GitHub Actions 运行状态

### 服务健康检查

```bash
# 检查服务状态
curl http://localhost:3000/health

# 查看日志
docker-compose logs -f image-sync

# 查看容器状态
docker-compose ps
```

## 高级配置

### 内网穿透（FRP）

如果服务器在内网，需要使用 FRP 进行内网穿透：

1. **FRP 服务端（公网服务器）配置**：
   ```ini
   [common]
   bind_port = 7000
   ```

2. **FRP 客户端（内网服务器）配置**：
   ```ini
   [common]
   server_addr = your-frps-ip
   server_port = 7000
   
   [web]
   type = tcp
   local_ip = 127.0.0.1
   local_port = 3000
   remote_port = 30000
   ```

3. **企业微信回调配置**：
   - 回调 URL: `http://your-frps-ip:30000/wechat/callback`

### 定时任务

系统会在每天凌晨 00:00:00 自动：
1. 将当前的 `images.txt` 内容上传到 GitHub
2. 重置本地的 `images.txt` 为空

这确保每天有一个干净的同步列表。

## 性能优化

- **Token 缓存**：企业微信 access_token 缓存 7000 秒
- **任务队列**：单任务处理，防止并发冲突
- **并发同步**：GitHub Action 使用后台并发处理镜像
- **文件锁**：防止多请求同时修改 `images.txt`

## 限制说明

- **API 调用频率**：
  - 企业微信：每分钟最多 600 次
  - GitHub：根据账号级别有不同限制
- **任务处理**：同一时间只处理一个同步任务
- **超时时间**：GitHub Actions 最多等待 5 分钟

## 常见问题

**Q: 支持哪些镜像源？**
A: 支持所有公共 Docker 仓库（Docker Hub、GCR、K8s 等）

**Q: 如何查看同步历史？**
A: 查看 GitHub Actions 运行历史或仓库的 `images.txt` 提交记录

**Q: 失败会重试吗？**
A: 不会自动重试，需要手动重新发送镜像名称

**Q: 可以同步私有仓库镜像吗？**
A: 需要配置相应的认证信息

## 相关链接

- [参考项目](https://github.com/tech-shrimp/docker_image_pusher) - docker_image_pusher
- [企业微信 API 文档](https://developer.work.weixin.qq.com/document)
- [GitHub Actions 文档](https://docs.github.com/actions)

## 许可证

MIT

