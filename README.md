# 企业微信应用 - 镜像同步服务

通过企业微信应用接收消息，自动触发 GitHub Action 实现 Docker 镜像的拉取、标记和推送。

## 功能特性

- ✅ **简化输入** - 只需发送镜像名称，目标仓库自动配置
- ✅ 支持单个或多个镜像（逗号、空格、换行分隔）
- ✅ 支持指定平台架构（linux/amd64, linux/arm64）
- ✅ 自动 Git 提交和推送
- ✅ 触发 GitHub Action 执行同步
- ✅ 自动返回执行结果
- ✅ 简单内存缓存优化

## 工作流程

```
企业微信消息 
  ↓
解析命令并添加到 images.txt
  ↓
Git Push 到 GitHub 
  ↓
触发 GitHub Action（监听 images.txt 文件变更）
  ↓
GitHub Action 自动执行镜像 pull/tag/push 
  ↓
企业微信返回执行结果（成功/失败）
```

## 快速开始

### 1. 克隆项目

```bash
git clone <your-repo-url>
cd image-pull-push
```

### 2. 配置环境变量

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
GITHUB_REPO=owner/repo
GITHUB_EMAIL=bot@example.com
GITHUB_NAME=Image Sync Bot

# 阿里云仓库（自动映射）
ALIYUN_REGISTRY=registry.cn-hangzhou.aliyuncs.com
ALIYUN_NAMESPACE=my-namespace
```

### 3. 启动服务

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

### 4. 配置企业微信回调

在[企业微信管理后台](https://work.weixin.qq.com/)配置：
- **回调 URL**: `http://your-domain.com:port/wechat/callback`
- **Token**: 与 `.env` 中的 `WECHAT_TOKEN` 完全一致
- **接收消息模式**: 选择"明文模式"（不要选"安全模式"）
- **EncodingAESKey**: 留空即可（如果使用明文模式）

⚠️ **重要**：
1. Token 必须与 `.env` 中的 `WECHAT_TOKEN` 完全一致
2. 接收消息模式必须选择"明文模式"，否则验证会失败
3. 配置保存后会自动验证回调 URL

### 5. 使用

**单个镜像：**
```
nginx:latest
```

**多个镜像（逗号分隔）：**
```
nginx, redis, mysql
```

**多个镜像（空格分隔）：**
```
nginx redis mysql
```

**多个镜像（换行）：**
```
nginx:latest
redis:7.0
mysql:8.0
```

**指定平台：**
```
--platform=linux/amd64 nginx:latest
```

## 项目结构

```
.
├── .github/workflows/
│   └── docker-image-sync.yml    # GitHub Action 工作流
├── server.js                     # 核心服务
├── package.json                  # 项目配置
├── images.txt                    # 镜像同步列表
├── env.example                   # 环境变量示例
├── Dockerfile                    # Docker 配置
├── docker-compose.yml            # Compose 配置
└── README.md                     # 本文档
```

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
```bash
# 检查 Token 是否正确
curl http://localhost:3000/health

# 查看日志
docker-compose logs -f
```

### Git Push 失败
- 检查 GitHub Token 权限
- 确认仓库配置正确
- 查看服务日志

### 镜像同步失败
- 检查 Docker 凭据
- 查看 GitHub Actions 日志

## 相关链接

- [参考项目](https://github.com/tech-shrimp/docker_image_pusher) - docker_image_pusher

## 许可证

MIT

