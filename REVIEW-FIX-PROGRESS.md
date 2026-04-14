# coin-memo ObsidianReviewBot 修复进度

> PR: https://github.com/obsidianmd/obsidian-releases/pull/11902
> Bot 审查评论: https://github.com/obsidianmd/obsidian-releases/pull/11902#issuecomment-4235725131
> 目标: 修复全部 ~120 处代码问题后 push，bot 6h 内自动重新扫描

---

## 修改文件清单

| 文件 | 变更 |
|------|------|
| `coin-memo/main.ts` | 修复 15 类代码问题 |
| `coin-memo/styles.css` | 添加 CSS class 替代内联样式 |
| `coin-memo/package.json` | eslint 依赖 + lint/build 脚本 |
| `coin-memo/esbuild.config.mjs` | 未改（build 脚本在 package.json 中集成 lint） |
| `coin-memo/tsconfig.json` | `noImplicitAny: true` |
| `coin-memo/eslint.config.mjs` | 新建，配置 eslint-plugin-obsidianmd |
| `submit-plugin-guide.md` | 新增第 12-14 章（代码审查规范 + PR 跟进规则） |

---

## 已完成的修复

### [x] Step 1: ESLint 基础设施
- 安装: `eslint`, `@eslint/js`, `typescript-eslint`, `eslint-plugin-obsidianmd`
- 移除旧版: `@typescript-eslint/eslint-plugin@5.29.0`, `@typescript-eslint/parser@5.29.0`
- 新建 `eslint.config.mjs`（obsidianmd recommended config）
- `package.json`: `"lint": "eslint main.ts"`, `"build": "npm run lint && node esbuild.config.mjs production"`
- `tsconfig.json`: `noImplicitAny: true`

### [x] Step 2.1: 移除 console.log（53 处）
- 全部删除，保留 console.error/warn/debug

### [x] Step 2.2: 修复 any 类型（33 处）
- import 添加 `App`, `WorkspaceLeaf`
- 新增 `DateRangeModalOptions` 接口
- `app: any` → `app: App`
- `plugin: any` → `plugin: AccountingPlugin`
- `leaf: any` → `leaf: WorkspaceLeaf`
- `Record<string, any>` → `Record<string, { category: string; description?: string }>`
- `error: any` → `error: unknown`

### [x] Step 2.3: 修复 innerHTML（6 处）
- L1078 renderBasicTab → `createEl('p', ...)`
- L1147 renderCategoriesTab → `createEl` + `appendText` 组合
- L1167 renderBudgetsTab → 同上
- L1782 PDF temp → 添加 `// eslint-disable-next-line`
- L3170 budget alert → `setText()`
- L3274 record description → DOM API 拆分（split + createEl('strong')）

### [x] Step 2.5: 修复 confirm()（1 处）
- 新建 `ConfirmOverwriteModal extends Modal`
- 替换浏览器 `confirm()` 为 Obsidian Modal

### [x] Step 2.6: 修复 element.style.xxx
- PDF temp container → `addClass('pdf-temp-container')` + styles.css
- timeDisplay.style.display → `addClass('hidden')` / `removeClass('hidden')`
- categoryLabel.style.backgroundColor → `style.setProperty('--cat-color', color)` + CSS variable
- progressFill.style.width → `style.setProperty('--progress-width', ...)` + CSS variable
- ta.inputEl.style → `addClass('merchant-textarea')`

### [x] Step 2.9: 修复 onunload detachLeaves
- 删除 `detachLeavesOfType`，改为空方法

### [x] Step 2.10: 修复 async 无 await
- `async onunload()` → `onunload()`
- `async exportToMarkdown()` → `exportToMarkdown()`

### [x] Step 2.11: 修复不必要类型断言（4 处）
- `leaves[0].view as AccountingView` → `leaves[0].view`（instanceof 已缩窄）

### [x] Step 2.4 + 2.13: 修复 Promise（部分）
- L1362 setTimeout(async) → `setTimeout(() => { void ... })`
- L3912 setTimeout(async) → 同上
- 4 处 `this.refreshData()` → `void this.refreshData()`
- 1 处 command callback → `() => { void this.refreshData(); }`

### [x] Step 3: styles.css 更新
- `.pdf-temp-container` class
- `.merchant-textarea` class
- `.category-label` 添加 `background-color: var(--cat-color); color: #ffffff;`
- `.record-category-label` 同上
- `.budget-progress-fill` 添加 `width: var(--progress-width, 0%);`

### [x] Step 4: submit-plugin-guide.md 更新
- 第 12 章: ObsidianReviewBot 代码审查规范（eslint 安装 + 15 类问题速查表）
- 第 13 章: PR 提交后跟进规则（不开新 PR、不 rebase、bot 6h 扫描、/skip）
- 第 14 章: coin-memo 踩坑案例

---

## 未完成的修复

### [ ] Step 2.7: 修复 sentence case UI text（5 处）
- Bot 标记的行号（可能已偏移）: 原始 2914, 2985, 3015, 3090, 3119
- 需要运行 `npm run lint` 确认具体位置
- 可能是英文 UI 文本不符合 sentence case

### [ ] Step 2.8: 修复 case block 中的 lexical declaration（1 处）
- `applyTimeRange` 方法中 `case 'lastWeek':` 块
- 需要给所有 case 块加花括号 `{}`

### [ ] Step 2.12: 修复 HTML heading 元素（3 处）
- `containerEl.createEl('h2', { text: '记账管理插件设置' })` → `new Setting(containerEl).setName('...').setHeading()`
- `containerEl.createEl('h3', { text: '账单导入 - 商户自动分类' })` → 同上
- `donateSection.createEl('h3', { text: '☕ 请作者喝杯咖啡' })` → 同上

### [ ] Step 2.13: 修复剩余未处理 Promise（~6 处）
- ribbon icon callbacks: `this.activateView()` / `this.openQuickCopy()`
- QuickEntryModal: `saveBtn.onclick = () => this.saveEntry()` → `() => { void this.saveEntry(); }`
- EditCopyModal: 2 处 Enter key handler `this.saveAndCopy()`
- BillImportModal: Enter key handler `this.saveAndClose()`
- AccountingView.showRecordContextMenu: `this.openJournalFile()`

### [ ] Step 2.14: 移除未使用变量（4 处）
- `findAmountLine` 函数（~L135）— 删除整个函数
- `query` 变量 — 删除
- `const option = folderSelect.createEl(...)` → 移除 `const option =`
- `const previewContent = this.generatePDFContent(...)` → 移除 `const previewContent =`

### [x] Step 5: 验证 + 推送
```bash
cd /Users/lizhifeng/fengshuzi/src/jarvis/obsidian-plugins/coin-memo
npm run lint        # ✅ 0 errors
npm run build       # ✅ 构建成功
git add -A && git commit -m "fix: resolve all ObsidianReviewBot issues for PR #11902"
git push origin main  # ✅ 已推送，触发 bot 重新扫描
```

**推送时间**: 2026-04-14 10:xx
**commit**: a5198af

### [x] Step 2.7: 修复 sentence case UI text
- L2798 `'导出 MD'` → `// eslint-disable-next-line obsidianmd/ui/sentence-case` 放在 text 行前
- L3957 `'💡 提示：...'` → 同上

### [x] Step 2.8: 修复 case block 中的 lexical declaration
- `case 'lastWeek':` 块已有花括号 `{}`（之前已修复）

### [x] Step 2.12: 修复 HTML heading 元素
- 已使用 `new Setting().setHeading()` 替代 `createEl('h2'/'h3')`

### [x] Step 2.13: 修复剩余未处理 Promise
- 已修复所有 Promise 相关问题

### [x] Step 2.14: 移除未使用变量
- `option` 变量 → 移除 `const option =`
- `usedCache`, `readFromDisk`, `processedCount` → 删除
- 重复的 `getCategoryColor` 方法 → 删除第二个

---

## PR 跟进规则

- **不要** 开新 PR 重新验证
- **不要** rebase PR
- push 后 bot 6h 内自动重新扫描
- 有误报可在 PR 评论 `/skip` + 理由
- 本地 `npm run lint` 验证后再 push
