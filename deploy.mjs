import { copyFileSync, existsSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

// 定义基础路径
const BASE_PATH = join(
  homedir(),
  'Library/Mobile Documents/iCloud~md~obsidian/Documents/漂泊者及其影子'
);

const NOTE_DEMO_PATH = join(
  homedir(),
  'Library/Mobile Documents/iCloud~md~obsidian/Documents/note-demo'
);

// 定义所有 vault 的插件目录
const vaults = [
  {
    name: 'Mobile',
    path: join(BASE_PATH, '.obsidian-mobile/plugins/obsidian-accounting')
  },
  {
    name: 'Pro',
    path: join(BASE_PATH, '.obsidian-pro/plugins/obsidian-accounting')
  },
  {
    name: 'iPad',
    path: join(BASE_PATH, '.obsidian-ipad/plugins/obsidian-accounting')
  },
  {
    name: '2017',
    path: join(BASE_PATH, '.obsidian-2017/plugins/obsidian-accounting')
  },
  {
    name: 'Zhang',
    path: join(BASE_PATH, '.obsidian-zhang/plugins/obsidian-accounting')
  },
  {
    name: 'Note-Demo',
    path: join(NOTE_DEMO_PATH, '.obsidian/plugins/obsidian-accounting')
  }
];

// 需要复制的文件（都从 dist 目录）
const files = [
  { source: 'dist/main.js', target: 'main.js' },
  { source: 'dist/manifest.json', target: 'manifest.json' },
  { source: 'dist/styles.css', target: 'styles.css' },
  { source: 'dist/config.json', target: 'config.json' }
];

console.log('🚀 开始部署 Accounting 插件...\n');

let successCount = 0;
let failCount = 0;

vaults.forEach((vault) => {
  console.log(`📁 部署到 ${vault.name} vault...`);
  
  try {
    // 确保目标目录存在
    if (!existsSync(vault.path)) {
      mkdirSync(vault.path, { recursive: true });
      console.log(`  ✓ 创建目录: ${vault.path}`);
    }
    
    // 复制文件
    files.forEach((file) => {
      if (!existsSync(file.source)) {
        console.log(`  ⚠️  警告: ${file.source} 不存在`);
        return;
      }
      const targetPath = join(vault.path, file.target);
      // config.json 已存在时跳过（保留用户已配置的内容）
      if (file.target === 'config.json' && existsSync(targetPath)) {
        console.log(`  ⏭  跳过 ${file.target}（已存在，保留用户配置）`);
        return;
      }
      copyFileSync(file.source, targetPath);
      console.log(`  ✓ 已复制 ${file.source} → ${file.target}`);
    });
    
    console.log(`✅ ${vault.name} 部署成功\n`);
    successCount++;
  } catch (error) {
    console.error(`❌ ${vault.name} 部署失败`);
    console.error(`   错误: ${error.message}\n`);
    failCount++;
  }
});

console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('📊 部署总结');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log(`✅ 成功: ${successCount} 个 vault`);
console.log(`❌ 失败: ${failCount} 个 vault`);
console.log('\n💡 提示: 在 Obsidian 中重新加载插件以查看更改');
console.log('   - 打开命令面板 (Cmd/Ctrl + P)');
console.log('   - 搜索 "Reload app without saving"');
console.log('   - 或者禁用再启用插件\n');

// 清理 dist 文件夹
try {
  rmSync('dist', { recursive: true, force: true });
  console.log('🧹 已清理 dist 文件夹\n');
} catch (error) {
  console.log('⚠️  清理 dist 文件夹失败:', error.message, '\n');
}
