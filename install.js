#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const https = require('https');
const { execSync } = require('child_process');

const SKILL_NAME = 'harness';
const GITHUB_RAW_BASE = 'https://raw.githubusercontent.com/你的用户名/harness-skill/main';

// 检测 Claude Code skills 目录
function getSkillsDir() {
  const home = process.env.HOME || process.env.USERPROFILE;
  if (!home) {
    throw new Error('无法检测用户主目录 (HOME/USERPROFILE 未设置)');
  }

  const skillsDir = path.join(home, '.claude', 'skills', SKILL_NAME);
  return skillsDir;
}

// 下载文件
function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    console.log(`📥 下载: ${url}`);
    const file = fs.createWriteStream(dest);
    https.get(url, (response) => {
      if (response.statusCode === 302 || response.statusCode === 301) {
        // 处理重定向
        return downloadFile(response.headers.location, dest).then(resolve).catch(reject);
      }
      if (response.statusCode !== 200) {
        reject(new Error(`下载失败: HTTP ${response.statusCode}`));
        return;
      }
      response.pipe(file);
      file.on('finish', () => {
        file.close();
        resolve();
      });
    }).on('error', (err) => {
      fs.unlink(dest, () => {});
      reject(err);
    });
  });
}

async function install() {
  console.log('🚀 Harness Skill 安装器\n');

  try {
    const skillsDir = getSkillsDir();
    console.log(`📂 目标目录: ${skillsDir}`);

    // 检查是否已安装
    if (fs.existsSync(skillsDir)) {
      console.log('⚠️  检测到已安装的 harness skill');
      console.log('   如需重新安装，请先删除: rm -rf ' + skillsDir);
      process.exit(1);
    }

    // 创建目录
    fs.mkdirSync(skillsDir, { recursive: true });
    console.log('✅ 创建目录');

    // 下载 SKILL.md
    const skillMdPath = path.join(skillsDir, 'SKILL.md');
    await downloadFile(`${GITHUB_RAW_BASE}/SKILL.md`, skillMdPath);
    console.log('✅ 下载 SKILL.md');

    // 下载 prompts/ (如果有)
    const promptsDir = path.join(skillsDir, 'prompts');
    try {
      fs.mkdirSync(promptsDir, { recursive: true });
      // 这里列出你的 prompt 文件，例如：
      // await downloadFile(`${GITHUB_RAW_BASE}/prompts/planner.md`, path.join(promptsDir, 'planner.md'));
      // await downloadFile(`${GITHUB_RAW_BASE}/prompts/developer.md`, path.join(promptsDir, 'developer.md'));
      console.log('✅ 下载 prompts (如果有)');
    } catch (e) {
      console.log('ℹ️  未找到 prompts 目录，跳过');
    }

    console.log('\n🎉 安装完成！\n');
    console.log('使用方法:');
    console.log('  1. 在项目根目录创建 .swarm/config.yaml (参考 GitHub README)');
    console.log('  2. 在 Claude Code 中输入: /harness "你的需求描述"');
    console.log('\n文档: https://github.com/你的用户名/harness-skill\n');

  } catch (error) {
    console.error('❌ 安装失败:', error.message);
    process.exit(1);
  }
}

install();
