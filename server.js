/**
 * 企业微信应用 - 镜像同步服务
 * 接收企业微信消息，更新 images.txt 并提交到 GitHub，触发 GitHub Action
 */

const express = require('express');
const crypto = require('crypto');
const axios = require('axios');
const fs = require('fs');
const { execSync } = require('child_process');
const path = require('path');
const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// 配置信息（从环境变量读取）
const CONFIG = {
  // 企业微信配置
  CORP_ID: process.env.WECHAT_CORP_ID,
  AGENT_ID: process.env.WECHAT_AGENT_ID,
  SECRET: process.env.WECHAT_SECRET,
  TOKEN: process.env.WECHAT_TOKEN || 'your-token',
  ENCODING_AES_KEY: process.env.WECHAT_ENCODING_AES_KEY,
  
  // GitHub 配置
  GITHUB_TOKEN: process.env.GITHUB_TOKEN,
  GITHUB_REPO: process.env.GITHUB_REPO, // 格式: owner/repo
  GITHUB_OWNER: process.env.GITHUB_OWNER,
  GITHUB_BRANCH: process.env.GITHUB_BRANCH || 'main',
  GITHUB_EMAIL: process.env.GITHUB_EMAIL || 'bot@example.com',
  GITHUB_NAME: process.env.GITHUB_NAME || 'Image Sync Bot',
  
  // 阿里云仓库配置
  ALIYUN_REGISTRY: process.env.ALIYUN_REGISTRY || 'registry.cn-hangzhou.aliyuncs.com',
  ALIYUN_NAMESPACE: process.env.ALIYUN_NAMESPACE || 'my-namespace',
};

// 验证企业微信回调签名
function verifySignature(msgSignature, timestamp, nonce, echoStr) {
  const token = CONFIG.TOKEN;
  const sortedArray = [token, timestamp, nonce].sort();
  const sortedStr = sortedArray.join('');
  const hash = crypto.createHash('sha1').update(sortedStr).digest('hex');
  return hash === msgSignature;
}

// 解析用户消息中的镜像信息
// 支持多个镜像，多种格式：
// 1. "nginx:latest"
// 2. "nginx"
// 3. "nginx, redis, mysql" - 逗号分隔
// 4. "nginx redis mysql" - 空格分隔
// 5. 多行格式:
//    nginx:latest
//    redis:latest
//    mysql:8.0
// 6. "--platform=linux/amd64 nginx:latest"
// 7. 保留原格式: "pull nginx:latest to registry.cn-hangzhou.aliyuncs.com/my-repo/nginx:latest"
function parseMessage(content) {
  let platform = '';
  
  // 提取 --platform 参数
  const platformMatch = content.match(/--platform=(\S+)/i);
  if (platformMatch) {
    platform = platformMatch[1];
    // 从 content 中移除 platform 参数
    content = content.replace(/--platform=\S+\s+/gi, '').trim();
  }
  
  // 格式 1: 完整格式 pull <源镜像> to <目标镜像>:<标签>
  const pullRegex = /pull\s+(\S+)\s+to\s+(\S+):(\S+)/i;
  const match = content.match(pullRegex);
  
  if (match) {
    return [{
      sourceImage: match[1],
      targetImage: match[2],
      tag: match[3],
      platform: platform,
    }];
  }
  
  // 格式 2: sync image <源镜像> to <目标镜像>:<标签>
  const syncRegex = /sync\s+image\s+(\S+)\s+to\s+(\S+):(\S+)/i;
  const match2 = content.match(syncRegex);
  
  if (match2) {
    return [{
      sourceImage: match2[1],
      targetImage: match2[2],
      tag: match2[3],
      platform: platform,
    }];
  }
  
  // 格式 3: 简化格式 - 支持多个镜像（简化输入）
  // 尝试按逗号、空格或换行分割
  let images = [];
  
  // 检查是否有逗号
  if (content.includes(',')) {
    images = content.split(',').map(img => img.trim()).filter(img => img.length > 0);
  }
  // 检查是否是换行分割（多行）
  else if (content.includes('\n')) {
    images = content.split('\n').map(img => img.trim()).filter(img => img.length > 0 && !img.startsWith('#'));
  }
  // 检查是否是空格分割
  else if (content.split(/\s+/).length > 1) {
    images = content.split(/\s+/).filter(img => img.length > 0);
  }
  // 单个镜像
  else {
    images = [content];
  }
  
  // 如果只有一个镜像且格式正确，返回单个对象（保持兼容性）
  if (images.length === 1 && images[0].match(/^\S+$/)) {
    let sourceImage = images[0];
    
    // 如果没有指定标签，默认添加 latest
    if (!sourceImage.includes(':')) {
      sourceImage += ':latest';
    }
    
    // 从源镜像提取镜像名（去除仓库前缀）
    let imageName = sourceImage.split('/').pop().split(':')[0];
    
    // 构建目标地址: registry/namespace/image:tag
    const targetImage = `${CONFIG.ALIYUN_REGISTRY}/${CONFIG.ALIYUN_NAMESPACE}/${imageName}`;
    const tag = sourceImage.split(':')[1] || 'latest';
    
    return [{
      sourceImage,
      targetImage,
      tag,
      platform,
    }];
  }
  
  // 处理多个镜像
  const results = [];
  for (const img of images) {
    if (!img || img.startsWith('#')) continue;
    
    let sourceImage = img.trim();
    
    // 如果没有指定标签，默认添加 latest
    if (!sourceImage.includes(':')) {
      sourceImage += ':latest';
    }
    
    // 从源镜像提取镜像名（去除仓库前缀）
    let imageName = sourceImage.split('/').pop().split(':')[0];
    
    // 构建目标地址: registry/namespace/image:tag
    const targetImage = `${CONFIG.ALIYUN_REGISTRY}/${CONFIG.ALIYUN_NAMESPACE}/${imageName}`;
    const tag = sourceImage.split(':')[1] || 'latest';
    
    results.push({
      sourceImage,
      targetImage,
      tag,
      platform,
    });
  }
  
  return results.length > 0 ? results : null;
}

// 添加镜像到 images.txt
function addImageToFile(imageInfo) {
  const imagesFilePath = path.join(__dirname, 'images.txt');
  let content = '';
  
  // 读取现有内容
  if (fs.existsSync(imagesFilePath)) {
    content = fs.readFileSync(imagesFilePath, 'utf8');
  }
  
  // 检查是否已存在
  const lineStart = imageInfo.platform 
    ? `--platform=${imageInfo.platform} ${imageInfo.sourceImage} to ${imageInfo.targetImage}:${imageInfo.tag}`
    : `${imageInfo.sourceImage} to ${imageInfo.targetImage}:${imageInfo.tag}`;
  
  if (content.includes(lineStart)) {
    return { added: false, message: '镜像已存在' };
  }
  
  // 添加新镜像
  const newLine = imageInfo.platform 
    ? `--platform=${imageInfo.platform} ${imageInfo.sourceImage} to ${imageInfo.targetImage}:${imageInfo.tag}\n`
    : `${imageInfo.sourceImage} to ${imageInfo.targetImage}:${imageInfo.tag}\n`;
  
  content += newLine;
  fs.writeFileSync(imagesFilePath, content, 'utf8');
  
  return { added: true, message: '镜像已添加到列表' };
}

// 提交到 GitHub 并推送
async function commitAndPushToGitHub(commitMessage) {
  try {
    console.log('开始提交到 GitHub...');
    
    // 配置 git 用户信息
    execSync(`git config user.email "${CONFIG.GITHUB_EMAIL}"`, { encoding: 'utf8' });
    execSync(`git config user.name "${CONFIG.GITHUB_NAME}"`, { encoding: 'utf8' });
    
    // 配置 GitHub token
    const token = CONFIG.GITHUB_TOKEN;
    if (!token) {
      throw new Error('GITHUB_TOKEN 未配置');
    }
    
    // 获取仓库 URL
    const repoUrl = `https://${token}@github.com/${CONFIG.GITHUB_REPO}.git`;
    
    // 添加文件
    execSync('git add images.txt', { encoding: 'utf8', stdio: 'inherit' });
    
    // 提交
    execSync(`git commit -m "${commitMessage}"`, { encoding: 'utf8', stdio: 'inherit' });
    
    // 推送
    execSync(`git push ${repoUrl} ${CONFIG.GITHUB_BRANCH}`, { encoding: 'utf8', stdio: 'inherit' });
    
    console.log('✅ 提交成功');
    return true;
  } catch (error) {
    console.error('❌ 提交失败:', error.message);
    throw error;
  }
}

// 获取 GitHub Actions 运行状态
async function getGitHubActionsStatus(runId) {
  try {
    const url = `https://api.github.com/repos/${CONFIG.GITHUB_REPO}/actions/runs/${runId}`;
    const response = await axios.get(url, {
      headers: {
        'Authorization': `Bearer ${CONFIG.GITHUB_TOKEN}`,
        'Accept': 'application/vnd.github.v3+json',
      }
    });
    
    return response.data;
  } catch (error) {
    console.error('获取 Actions 状态失败:', error.message);
    return null;
  }
}

// 等待 GitHub Actions 完成（最多等待5分钟）
async function waitForActionsComplete(timeout = 300000) {
  const startTime = Date.now();
  const checkInterval = 10000; // 每10秒检查一次
  
  while (Date.now() - startTime < timeout) {
    try {
      const url = `https://api.github.com/repos/${CONFIG.GITHUB_REPO}/actions/runs?per_page=1`;
      const response = await axios.get(url, {
        headers: {
          'Authorization': `Bearer ${CONFIG.GITHUB_TOKEN}`,
          'Accept': 'application/vnd.github.v3+json',
        }
      });
      
      const latestRun = response.data.workflow_runs[0];
      if (latestRun) {
        console.log(`工作流状态: ${latestRun.status} - ${latestRun.conclusion || 'running'}`);
        
        if (latestRun.status === 'completed') {
          return {
            status: latestRun.status,
            conclusion: latestRun.conclusion,
            html_url: latestRun.html_url,
            run_number: latestRun.run_number,
          };
        }
      }
    } catch (error) {
      console.error('检查 Actions 状态时出错:', error.message);
    }
    
    await new Promise(resolve => setTimeout(resolve, checkInterval));
  }
  
  return { status: 'timeout', message: '超时等待' };
}

// Token 缓存（简单内存缓存）
let cachedToken = null;
let tokenExpireTime = 0;

// 获取企业微信 access_token（带缓存）
async function getAccessToken() {
  const now = Date.now();
  
  // 缓存未过期，直接返回
  if (cachedToken && now < tokenExpireTime) {
    return cachedToken;
  }
  
  // 获取新 Token
  const url = `https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=${CONFIG.CORP_ID}&corpsecret=${CONFIG.SECRET}`;
  
  try {
    const response = await axios.get(url);
    if (response.data.errcode === 0) {
      cachedToken = response.data.access_token;
      // Token 有效期 7200 秒，提前 200 秒过期
      tokenExpireTime = now + 7000000;
      
      console.log('✅ 获取新的 Access Token，缓存 ' + Math.floor(7000000/1000) + ' 秒');
      
      return cachedToken;
    } else {
      console.error('获取 access_token 失败:', response.data.errmsg);
      return null;
    }
  } catch (error) {
    console.error('获取 access_token 异常:', error.message);
    return null;
  }
}

// 发送企业微信消息
async function sendWeChatMessage(userId, content) {
  const accessToken = await getAccessToken();
  if (!accessToken) {
    console.error('无法获取 access_token');
    return false;
  }
  
  const url = `https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token=${accessToken}`;
  
  const message = {
    touser: userId,
    msgtype: 'text',
    agentid: parseInt(CONFIG.AGENT_ID),
    text: {
      content: content
    }
  };
  
  try {
    const response = await axios.post(url, message);
    if (response.data.errcode === 0) {
      console.log('消息发送成功');
      return true;
    } else {
      console.error('发送消息失败:', response.data.errmsg);
      return false;
    }
  } catch (error) {
    console.error('发送消息异常:', error.message);
    return false;
  }
}

// 处理企业微信回调
app.get('/wechat/callback', (req, res) => {
  const { msg_signature, timestamp, nonce, echostr } = req.query;
  
  console.log('收到企业微信回调验证请求');
  console.log('参数:', { msg_signature, timestamp, nonce, echostr });
  
  // 这里应该解密 echostr，简化处理直接返回
  // 实际应用中需要实现完整的消息加解密
  res.send(echostr);
});

// 处理企业微信消息回调
app.post('/wechat/callback', async (req, res) => {
  const { msg_signature, timestamp, nonce } = req.query;
  
  console.log('收到企业微信消息');
  console.log('请求体:', JSON.stringify(req.body, null, 2));
  
  // 简化处理：这里假设企业微信使用 JSON 回调
  // 实际需要根据企业微信的回调格式调整
  const message = req.body;
  
  try {
    if (message.MsgType === 'text') {
      const content = message.Content;
      const fromUser = message.FromUserName;
      
      console.log(`收到来自 ${fromUser} 的消息: ${content}`);
      
      // 解析消息（现在返回数组）
      const imagesList = parseMessage(content);
      
      if (imagesList && imagesList.length > 0) {
        const totalImages = imagesList.length;
        const isMultiple = totalImages > 1;
        
        console.log(`解析到 ${totalImages} 个镜像信息:`, imagesList);
        
        // 构建确认消息
        let confirmMsg = `🔄 正在处理镜像同步请求...\n\n`;
        if (isMultiple) {
          confirmMsg += `共 ${totalImages} 个镜像：\n\n`;
          imagesList.forEach((img, index) => {
            confirmMsg += `${index + 1}. ${img.sourceImage} → ${img.targetImage}:${img.tag}\n`;
          });
        } else {
          const img = imagesList[0];
          confirmMsg += `📥 源镜像: ${img.sourceImage}\n`;
          confirmMsg += `📤 目标镜像: ${img.targetImage}:${img.tag}\n`;
          if (img.platform) {
            confirmMsg += `🏗️  平台: ${img.platform}\n`;
          }
        }
        
        await sendWeChatMessage(fromUser, confirmMsg);
        
        try {
          // 添加所有镜像到 images.txt
          const skipped = [];
          const added = [];
          
          for (const imageInfo of imagesList) {
            const addResult = addImageToFile(imageInfo);
            if (addResult.added) {
              added.push(imageInfo.sourceImage);
            } else {
              skipped.push(imageInfo.sourceImage);
            }
          }
          
          if (added.length === 0) {
            await sendWeChatMessage(fromUser, `⚠️ 所有镜像均已存在`);
            res.send('success');
            return;
          }
          
          // 构建提交信息
          const commitMessage = `feat: 添加 ${added.length} 个镜像同步${isMultiple ? '任务' : ''}\n\n${added.join('\n')}`;
          
          // 提交并推送到 GitHub
          await commitAndPushToGitHub(commitMessage);
          
          // 发送成功消息
          let successMsg = `✅ 已添加 ${added.length} 个镜像到同步队列\n\n`;
          if (skipped.length > 0) {
            successMsg += `⚠️ 跳过 ${skipped.length} 个已存在镜像\n\n`;
          }
          successMsg += `📝 提交信息: ${added.length} 个镜像\n\nGitHub Action 已自动触发，正在执行镜像拉取和推送操作...`;
          
          await sendWeChatMessage(fromUser, successMsg);
          
          // 等待 GitHub Actions 完成（异步，不阻塞响应）
          setTimeout(async () => {
            try {
              const result = await waitForActionsComplete(300000); // 最多等待5分钟
              
              let resultMsg = '';
              if (result.conclusion === 'success') {
                resultMsg = `✅ 镜像同步完成！\n\n📊 已同步: ${added.length} 个镜像\n📊 运行编号: #${result.run_number}\n🔗 查看详情: ${result.html_url}`;
              } else if (result.conclusion === 'failure') {
                resultMsg = `❌ 镜像同步失败！\n\n📊 运行编号: #${result.run_number}\n🔗 查看详情: ${result.html_url}\n\n请检查错误日志。`;
              } else {
                resultMsg = `⏳ 镜像同步超时（执行时间超过5分钟）\n\n🔗 查看详情: ${result.html_url}`;
              }
              
              await sendWeChatMessage(fromUser, resultMsg);
            } catch (error) {
              console.error('获取执行结果时出错:', error);
            }
          }, 5000); // 延迟5秒后开始检查
          
        } catch (error) {
          console.error('处理镜像同步时出错:', error);
          await sendWeChatMessage(fromUser, `❌ 处理镜像同步时出错:\n${error.message}\n\n请检查配置或稍后重试。`);
        }
      } else {
        // 返回使用说明
        await sendWeChatMessage(fromUser, `📖 使用说明\n\n支持以下命令格式：\n\n1️⃣ 单个镜像：\nnginx:latest\nnginx\nalpine:3.18\n\n2️⃣ 多个镜像（逗号分隔）：\nnginx, redis, mysql\nnginx:latest, redis:7.0\n\n3️⃣ 多个镜像（空格分隔）：\nnginx redis mysql\nnginx:latest redis:7.0 mysql:8.0\n\n4️⃣ 多个镜像（换行）：\nnginx:latest\nredis:latest\nmysql:8.0\n\n5️⃣ 指定平台：\n--platform=linux/amd64 nginx:latest\n\n目标仓库自动配置为：\n${CONFIG.ALIYUN_REGISTRY}/${CONFIG.ALIYUN_NAMESPACE}/镜像名`);
      }
    }
    
    res.send('success');
  } catch (error) {
    console.error('处理消息时出错:', error);
    res.send('success'); // 即使出错也返回 success，避免企业微信重复回调
  }
});

// 健康检查端点
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    config: {
      hasWechatConfig: !!(CONFIG.CORP_ID && CONFIG.SECRET),
      hasGitHubConfig: !!(CONFIG.GITHUB_TOKEN && CONFIG.GITHUB_REPO),
    }
  });
});

// 启动服务器
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 企业微信镜像同步服务启动成功`);
  console.log(`📡 监听端口: ${PORT}`);
  console.log(`🔗 回调地址: http://your-domain.com/wechat/callback`);
  console.log(`\n📝 配置检查:`);
  console.log(`   企业微信配置: ${CONFIG.CORP_ID && CONFIG.SECRET ? '✅' : '❌'}`);
  console.log(`   GitHub 配置: ${CONFIG.GITHUB_TOKEN && CONFIG.GITHUB_REPO ? '✅' : '❌'}`);
  console.log(`   目标仓库: ${CONFIG.ALIYUN_REGISTRY}/${CONFIG.ALIYUN_NAMESPACE}/镜像名`);
});
