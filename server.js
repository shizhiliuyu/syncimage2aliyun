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
const xml2js = require('xml2js');
const app = express();

// 中间件：解析 XML 请求
app.use('/wechat/callback', express.text({ type: ['text/xml', 'application/xml'] }));
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
// 官方签名算法：https://developer.work.weixin.qq.com/document/path/91116
// SHA1(排序[token, timestamp, nonce, echostr])
function verifySignature(msgSignature, timestamp, nonce, echoStr) {
  const token = CONFIG.TOKEN;
  
  // 排序并拼接
  const arr = [token, timestamp, nonce, echoStr || ''].sort();
  const sortedStr = arr.join('');
  
  // SHA1 加密
  const hash = crypto.createHash('sha1').update(sortedStr).digest('hex');
  
  // 调试信息
  console.log('签名验证详情:');
  console.log('  - Token:', token ? `${token.substring(0, 10)}...` : '未配置');
  console.log('  - Timestamp:', timestamp);
  console.log('  - Nonce:', nonce);
  console.log('  - EchoStr:', echoStr ? `${echoStr.substring(0, 20)}...` : '无');
  console.log('  - 排序后的字符串:', sortedStr.substring(0, 50) + '...');
  console.log('  - 期望签名:', hash);
  console.log('  - 收到签名:', msgSignature);
  console.log('  - 验证结果:', hash === msgSignature ? '✅ 通过' : '❌ 失败');
  
  if (hash !== msgSignature) {
    console.log('');
    console.log('  ⚠️  签名验证失败！请检查：');
    console.log('     1. WECHAT_TOKEN 是否与企业管理后台完全一致');
    console.log('     2. 企业管理后台配置路径：应用 -> 接收消息 -> Token');
    console.log('     3. 确保 .env 文件中的 WECHAT_TOKEN 完全匹配');
    console.log('     4. 重启服务后重试');
    console.log('');
    console.log('  📝 提示：');
    console.log('     - Token 必须是字母、数字组合，长度3-32字符');
    console.log('     - 在企业管理后台修改 Token 后，需要同步修改 .env 文件');
    console.log('     - 修改 .env 后必须重启服务');
  }
  
  return hash === msgSignature;
}

// 解密企业微信 echostr（根据官方文档实现）
// 文档：https://developer.work.weixin.qq.com/document/path/91116
function decryptEchostr(echostr) {
  // 明文模式：直接返回 echostr
  if (!CONFIG.ENCODING_AES_KEY || CONFIG.ENCODING_AES_KEY.trim() === '') {
    console.log('📝 明文模式');
    return echostr;
  }
  
  // 安全模式：解密 echostr
  try {
    // 1. Base64 解码得到对称密钥
    const aesKey = Buffer.from(CONFIG.ENCODING_AES_KEY + '=', 'base64');
    
    // 2. Base64 解码 echostr
    const encrypted = Buffer.from(echostr, 'base64');
    
    // 3. AES-256-CBC 解密
    // iv 是 key 的前 16 字节
    const iv = aesKey.slice(0, 16);
    
    const decipher = crypto.createDecipheriv('aes-256-cbc', aesKey, iv);
    decipher.setAutoPadding(false);
    
    let decrypted = decipher.update(encrypted);
    decrypted = Buffer.concat([decrypted, decipher.final()]);
    
    // 4. 去除补位
    const pad = decrypted[decrypted.length - 1];
    decrypted = decrypted.slice(0, decrypted.length - pad);
    
    // 5. 提取明文（前16字节是随机数，接着4字节是长度）
    const content = decrypted.slice(16);
    const length = content.slice(0, 4).readUInt32BE(0);
    const result = content.slice(4, 4 + length).toString('utf8');
    
    console.log('✅ 解密成功（安全模式）');
    return result;
  } catch (error) {
    console.error('❌ 解密失败:', error.message);
    console.log('💡 请改为明文模式或检查 EncodingAESKey');
    return echostr;
  }
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

// 添加镜像到 images.txt（直接追加，允许重复）
function addImageToFile(imageInfo) {
  const imagesFilePath = path.join(__dirname, 'images.txt');
  
  // 构建完整行（确保格式正确）
  const fullLine = imageInfo.platform 
    ? `--platform=${imageInfo.platform} ${imageInfo.sourceImage} to ${imageInfo.targetImage}:${imageInfo.tag}`
    : `${imageInfo.sourceImage} to ${imageInfo.targetImage}:${imageInfo.tag}`;
  
  // 直接追加到文件末尾（使用 \n 换行，确保格式正确）
  fs.appendFileSync(imagesFilePath, fullLine, 'utf8');
  fs.appendFileSync(imagesFilePath, '\n', 'utf8');
  
  console.log(`✅ 添加镜像行: "${fullLine}"`);
  console.log(`   源镜像: ${imageInfo.sourceImage}`);
  console.log(`   目标镜像: ${imageInfo.targetImage}:${imageInfo.tag}`);
  
  return { added: true, message: '镜像已添加到列表' };
}

// 使用 GitHub API 更新文件
async function updateGitHubFile(commitMessage) {
  try {
    console.log('📤 使用 GitHub API 更新文件...');
    
    const token = CONFIG.GITHUB_TOKEN;
    if (!token) {
      throw new Error('GITHUB_TOKEN 未配置');
    }
    
    const [owner, repo] = CONFIG.GITHUB_REPO.split('/');
    const path = 'images.txt';
    const branch = CONFIG.GITHUB_BRANCH;
    
    // 读取 images.txt 内容
    const content = fs.readFileSync('images.txt', 'utf8');
    const encodedContent = Buffer.from(content).toString('base64');
    
    // 先获取文件 SHA（如果文件已存在）
    let sha = null;
    try {
      const getFileUrl = `https://api.github.com/repos/${owner}/${repo}/contents/${path}?ref=${branch}`;
      const fileResponse = await axios.get(getFileUrl, {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Accept': 'application/vnd.github.v3+json',
        }
      });
      sha = fileResponse.data.sha;
      console.log('📝 文件已存在，将更新 SHA:', sha);
    } catch (error) {
      console.log('📝 文件不存在或无法获取，将创建新文件');
    }
    
    // 更新文件
    const updateUrl = `https://api.github.com/repos/${owner}/${repo}/contents/${path}`;
    const payload = {
      message: commitMessage,
      content: encodedContent,
      branch: branch,
    };
    
    if (sha) {
      payload.sha = sha; // 更新现有文件需要 SHA
    }
    
    const response = await axios.put(updateUrl, payload, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/vnd.github.v3+json',
        'Content-Type': 'application/json',
      }
    });
    
    console.log('✅ 文件更新成功');
    console.log('📊 Commit SHA:', response.data.commit.sha);
    return true;
  } catch (error) {
    console.error('❌ 更新文件失败:', error.response?.data || error.message);
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

// 处理企业微信回调验证
app.get('/wechat/callback', (req, res) => {
  const { msg_signature, timestamp, nonce, echostr } = req.query;
  
  console.log('收到企业微信回调验证请求');
  console.log('参数:', { msg_signature, timestamp, nonce });
  
  try {
    // 验证签名
    if (!verifySignature(msg_signature, timestamp, nonce, echostr)) {
      console.error('❌ 签名验证失败');
      console.error('💡 请检查 WECHAT_TOKEN 是否与企业管理后台配置一致');
      console.error('💡 配置路径：企业微信管理后台 -> 应用 -> 接收消息 -> Token');
      res.status(403).send('Signature verification failed');
      return;
    }
    
    console.log('✅ 签名验证通过');
    
    // 返回解密后的 echostr
    if (echostr) {
      const decryptedEchostr = decryptEchostr(echostr);
      console.log(`返回 echostr，长度: ${decryptedEchostr.length}`);
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.send(decryptedEchostr);
    } else {
      res.send('success');
    }
  } catch (error) {
    console.error('处理回调验证时出错:', error);
    res.status(500).send('Internal error');
  }
});

// 解密企业微信消息
function decryptMessage(encryptMsg) {
  if (!CONFIG.ENCODING_AES_KEY || CONFIG.ENCODING_AES_KEY.trim() === '') {
    console.log('📝 明文模式，无需解密');
    return encryptMsg;
  }
  
  try {
    const aesKey = Buffer.from(CONFIG.ENCODING_AES_KEY + '=', 'base64');
    const encrypted = Buffer.from(encryptMsg, 'base64');
    const iv = aesKey.slice(0, 16);
    
    const decipher = crypto.createDecipheriv('aes-256-cbc', aesKey, iv);
    decipher.setAutoPadding(false);
    
    let decrypted = decipher.update(encrypted);
    decrypted = Buffer.concat([decrypted, decipher.final()]);
    
    const pad = decrypted[decrypted.length - 1];
    decrypted = decrypted.slice(0, decrypted.length - pad);
    
    const content = decrypted.slice(16);
    const length = content.slice(0, 4).readUInt32BE(0);
    const contentData = content.slice(4, 4 + length);
    const corpid = content.slice(4 + length).toString('utf8');
    
    console.log('✅ 解密成功，CorpID:', corpid.substring(0, 20));
    return contentData.toString('utf8');
  } catch (error) {
    console.error('❌ 解密失败:', error.message);
    return null;
  }
}

// 处理企业微信消息回调
app.post('/wechat/callback', async (req, res) => {
  const { msg_signature, timestamp, nonce } = req.query;
  
  console.log('\n=== 收到企业微信回调 ===');
  console.log('查询参数:', { msg_signature, timestamp, nonce });
  
  try {
    // 解析 XML
    const xmlBody = req.body;
    console.log('原始 XML 长度:', xmlBody.length);
    
    const parser = new xml2js.Parser({ explicitArray: false, ignoreAttrs: true });
    const result = await parser.parseStringPromise(xmlBody);
    
    console.log('解析后的 XML:', JSON.stringify(result, null, 2));
    
    // 提取加密消息
    const encryptedData = result.xml.Encrypt;
    console.log('加密数据长度:', encryptedData.length);
    
    // 解密消息
    const decryptedXml = decryptMessage(encryptedData);
    if (!decryptedXml) {
      res.send('success');
      return;
    }
    
    console.log('解密后的消息:', decryptedXml);
    
    // 再次解析解密后的 XML
    const messageResult = await parser.parseStringPromise(decryptedXml);
    const message = messageResult.xml;
    
    console.log('最终消息对象:', JSON.stringify(message, null, 2));
    
    // 处理文本消息
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
          // 使用文件锁机制处理并发
          const lockFile = path.join(__dirname, 'images.txt.lock');
          const maxRetries = 10;
          let retries = 0;
          
          // 获取锁
          while (fs.existsSync(lockFile) && retries < maxRetries) {
            console.log(`⏳ 等待文件锁释放... (重试 ${retries}/${maxRetries})`);
            await new Promise(resolve => setTimeout(resolve, 500));
            retries++;
          }
          
          if (retries >= maxRetries) {
            await sendWeChatMessage(fromUser, `⚠️ 系统繁忙，请稍后重试`);
            res.send('success');
            return;
          }
          
          // 创建锁文件
          fs.writeFileSync(lockFile, process.pid.toString());
          console.log('🔒 获取文件锁成功');
          
          try {
            // 添加所有镜像到 images.txt
            const skipped = [];
            const added = [];
            
            for (const imageInfo of imagesList) {
              console.log('处理镜像:', JSON.stringify(imageInfo, null, 2));
              const addResult = addImageToFile(imageInfo);
              if (addResult.added) {
                added.push(imageInfo.sourceImage);
              } else {
                skipped.push(imageInfo.sourceImage);
              }
            }
            
            // 打印最终写入的内容
            const finalContent = fs.readFileSync('images.txt', 'utf8');
            console.log('📄 images.txt 最终内容:');
            console.log(finalContent);
            console.log('📄 文件行数:', finalContent.split('\n').length);
            
            if (added.length === 0) {
              await sendWeChatMessage(fromUser, `⚠️ 所有镜像均已存在`);
              res.send('success');
              return;
            }
            
            // 构建提交信息
            const commitMessage = `feat: 添加 ${added.length} 个镜像同步${isMultiple ? '任务' : ''}\n\n${added.join('\n')}`;
            
            // 读取当前 images.txt 内容
            const currentContent = fs.readFileSync('images.txt', 'utf8');
            
            // 使用 GitHub API 更新文件
            await updateGitHubFile(commitMessage);
            
            // 上传成功后立即清空 images.txt（避免重复拉取）
            fs.writeFileSync('images.txt', '', 'utf8');
            console.log('🗑️  已清空 images.txt，避免重复拉取');
          } finally {
            // 释放锁
            if (fs.existsSync(lockFile)) {
              fs.unlinkSync(lockFile);
              console.log('🔓 释放文件锁');
            }
          }
          
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

// 定时同步 images.txt 到 GitHub
function startSyncFileScheduler() {
  console.log('⏰ 启动定时同步任务（每天 00:00:00）');
  
  let isProcessing = false;
  
  async function checkAndSync() {
    const now = new Date();
    const hours = now.getHours();
    const minutes = now.getMinutes();
    const seconds = now.getSeconds();
    
    // 每天凌晨 0 点同步文件
    if (hours === 0 && minutes === 0 && seconds === 0) {
      if (isProcessing) {
        console.log('⏳ 定时同步任务正在执行中，跳过本次...');
        return;
      }
      
      isProcessing = true;
      console.log('🔄 开始定时同步 images.txt 到 GitHub...');
      
      try {
        const imagesFilePath = path.join(__dirname, 'images.txt');
        const backupFilePath = path.join(__dirname, 'images.txt.bak');
        
        // 读取当前文件内容
        const content = fs.readFileSync(imagesFilePath, 'utf8');
        
        if (!content.trim()) {
          console.log('📝 文件为空，无需同步');
          isProcessing = false;
          return;
        }
        
        // 使用 GitHub API 上传当前内容
        const token = CONFIG.GITHUB_TOKEN;
        const [owner, repo] = CONFIG.GITHUB_REPO.split('/');
        const branch = CONFIG.GITHUB_BRANCH;
        const encodedContent = Buffer.from(content).toString('base64');
        
        // 先获取文件 SHA
        let sha = null;
        try {
          const getFileUrl = `https://api.github.com/repos/${owner}/${repo}/contents/images.txt?ref=${branch}`;
          const fileResponse = await axios.get(getFileUrl, {
            headers: {
              'Authorization': `Bearer ${token}`,
              'Accept': 'application/vnd.github.v3+json',
            }
          });
          sha = fileResponse.data.sha;
        } catch (error) {
          console.log('📝 文件不存在于 GitHub，将创建新文件');
        }
        
        // 上传文件
        const updateUrl = `https://api.github.com/repos/${owner}/${repo}/contents/images.txt`;
        const payload = {
          message: 'chore: 定时上传镜像列表（每天 00:00）',
          content: encodedContent,
          branch: branch,
        };
        
        if (sha) {
          payload.sha = sha;
        }
        
        const response = await axios.put(updateUrl, payload, {
          headers: {
            'Authorization': `Bearer ${token}`,
            'Accept': 'application/vnd.github.v3+json',
            'Content-Type': 'application/json',
          }
        });
        
        console.log('✅ 定时同步成功，Commit SHA:', response.data.commit.sha);
        
        // 重置为原始模板内容
        try {
          if (fs.existsSync(backupFilePath)) {
            const backupContent = fs.readFileSync(backupFilePath, 'utf8');
            fs.writeFileSync(imagesFilePath, backupContent, 'utf8');
            console.log('🔄 本地 images.txt 已重置为模板内容');
          } else {
            fs.writeFileSync(imagesFilePath, '', 'utf8');
            console.log('🗑️  本地 images.txt 已清空');
          }
        } catch (error) {
          console.error('⚠️  重置文件失败:', error.message);
        }
        
      } catch (error) {
        console.error('❌ 定时同步失败:', error.message);
      } finally {
        isProcessing = false;
      }
    }
  }
  
  // 每秒检查一次
  setInterval(checkAndSync, 1000);
  
  console.log('✅ 定时同步任务已启动');
}

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
  
  // 启动定时同步任务
  startSyncFileScheduler();
});

