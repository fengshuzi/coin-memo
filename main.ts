import { Plugin, ItemView, Modal, Notice, Menu, TFile, PluginSettingTab, Setting } from 'obsidian';
import { jsPDF } from 'jspdf';
import html2canvas from 'html2canvas';

// 类型定义
interface AccountingConfig {
    appName: string;
    categories: Record<string, string>;
    expenseEmoji: string;
    journalsPath: string;
    defaultCategory?: string; // 默认分类关键词
    enableQuickCopy?: boolean; // 启用快速记账功能
    quickCopyDays?: number; // 快速记账显示最近N天的记录
    budgets?: {
        monthly: {
            total: number;
            categories: Record<string, number>;
        };
        enableAlerts: boolean;
        alertThreshold: number;
    };
}

interface AccountingRecord {
    date: string;
    fileDate: string;
    keyword: string;
    category: string;
    amount: number;
    isIncome: boolean;
    description: string;
    rawLine: string;
    isBackfill: boolean;
}

interface AccountingStats {
    totalIncome: number;
    totalExpense: number;
    categoryStats: Record<string, {
        total: number;
        count: number;
        records: AccountingRecord[];
    }>;
    dailyStats: Record<string, {
        income: number;
        expense: number;
        records: AccountingRecord[];
    }>;
    budgetStatus: BudgetStatus | null;
}

interface BudgetStatus {
    totalBudget: number;
    totalSpent: number;
    totalRemaining: number;
    totalProgress: number;
    categories: Record<string, {
        budget: number;
        spent: number;
        remaining: number;
        progress: number;
        keyword: string;
    }>;
    alerts: Array<{
        type: 'warning' | 'exceeded';
        category: string;
        message: string;
    }>;
}

// 辅助函数：格式化本地日期为 YYYY-MM-DD（避免 UTC 时区问题）
function formatLocalDate(date: Date): string {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

// 记账记录解析器
class AccountingParser {
    config: AccountingConfig;
    
    constructor(config: AccountingConfig) {
        this.config = config;
    }

    // 解析单行记账记录
    parseRecord(line: string, fileDate: string): AccountingRecord | null {
        const { categories, expenseEmoji } = this.config;
        
        // 检查是否包含记账表情符号
        if (!line.includes(expenseEmoji)) {
            return null;
        }

        // 创建关键词列表，按长度排序（避免短关键词匹配长关键词的一部分）
        const keywords = Object.keys(categories).sort((a, b) => b.length - a.length);
        const keywordPattern = keywords.join('|');
        
        // 第一步：匹配 #关键词 后面的所有内容（支持无空格格式）
        const keywordRegex = new RegExp(`${expenseEmoji}\\s*(${keywordPattern})\\s*(.+)`, 'i');
        const keywordMatch = keywordRegex.exec(line);
        
        if (!keywordMatch) return null;

        const keyword = keywordMatch[1];
        const restContent = keywordMatch[2]; // #cy 后面的所有内容
        
        // 第二步：从剩余内容中提取第一个出现的数字作为金额
        const amountRegex = /[\d.]+/;
        const amountMatch = restContent.match(amountRegex);
        
        if (!amountMatch) return null;
        
        const amount = parseFloat(amountMatch[0]);
        if (isNaN(amount) || amount <= 0) return null;
        
        const category = categories[keyword] || '未分类';
        const isIncome = keyword === 'sr';
        
        // 第三步：提取描述（移除金额和紧跟的货币单位）
        // 匹配金额后面可能跟着的货币单位：块钱、元、块（按长度排序）
        const amountWithUnit = new RegExp(amountMatch[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(块钱|元|块)?');
        const description = restContent.replace(amountWithUnit, '').trim();
        
        // 检查描述中是否包含日期（支持账单补录）
        let recordDate = fileDate;
        const dateRegex = /(\d{4}-\d{2}-\d{2})/;
        const dateMatch = description.match(dateRegex);
        
        if (dateMatch) {
            // 验证日期格式是否有效
            const parsedDate = new Date(dateMatch[1]);
            if (!isNaN(parsedDate.getTime())) {
                recordDate = dateMatch[1];
                console.log(`检测到补录日期: ${recordDate} (原文件日期: ${fileDate})`);
            }
        }
        
        return {
            date: recordDate,
            fileDate: fileDate, // 保留原文件日期用于追溯
            keyword,
            category,
            amount: parseFloat(amount),
            isIncome,
            description: description.trim(),
            rawLine: line.trim(),
            isBackfill: recordDate !== fileDate // 标记是否为补录
        };
    }

    // 解析文件内容
    parseFileContent(content: string, filePath: string): AccountingRecord[] {
        const lines = content.split('\n');
        const records: AccountingRecord[] = [];
        
        // 从文件路径提取日期
        const dateMatch = filePath.match(/(\d{4}-\d{2}-\d{2})/);
        const fileDate = dateMatch ? dateMatch[1] : formatLocalDate(new Date());

        lines.forEach(line => {
            const record = this.parseRecord(line, fileDate);
            if (record) {
                records.push(record);
            }
        });

        return records;
    }
}

// 记账数据管理器
class AccountingStorage {
    app: any;
    config: AccountingConfig;
    parser: AccountingParser;
    cache: {
        records: AccountingRecord[] | null;
        lastUpdate: number | null;
    };
    cacheTimeout: number;
    
    constructor(app: any, config: AccountingConfig) {
        this.app = app;
        this.config = config;
        this.parser = new AccountingParser(config);
        
        // 添加缓存机制
        this.cache = {
            records: null,
            lastUpdate: null
        };
        
        // 缓存有效期（30秒）
        this.cacheTimeout = 30 * 1000;
    }
    
    // 检查缓存是否有效
    isCacheValid() {
        if (!this.cache.records || !this.cache.lastUpdate) {
            return false;
        }
        
        const now = Date.now();
        if ((now - this.cache.lastUpdate) > this.cacheTimeout) {
            console.log('缓存已过期');
            return false;
        }
        
        return true;
    }

    // 获取所有记账记录 - 智能缓存版本（已禁用，改为实时加载）
    async getAllRecordsWithCache(forceRefresh = false) {
        // 如果强制刷新，清除缓存
        if (forceRefresh) {
            this.clearCache();
        }
        
        // 如果缓存有效，直接返回
        if (this.isCacheValid()) {
            console.log('使用缓存的记账记录');
            return this.cache.records;
        }
        
        console.log('重新加载记账记录...');
        
        let records = [];
        
        try {
            // 优先使用搜索方式，更高效
            records = await this.getAllRecordsBySearch();
            
            // 更新缓存
            this.cache.records = records;
            this.cache.lastUpdate = Date.now();
            
            return records;
            
        } catch (error) {
            console.error('获取记账记录失败:', error);
            new Notice('获取记账记录失败，请检查日记文件夹');
            
            // 如果有缓存，返回缓存数据
            if (this.cache.records) {
                new Notice('使用缓存数据');
                return this.cache.records;
            }
            
            return [];
        }
    }
    
    // 清除缓存
    clearCache() {
        this.cache.records = null;
        this.cache.lastUpdate = null;
    }

    /**
     * 日记文件变化时调用（vault / metadataCache 事件），清除缓存
     * @returns 是否为日记文件且已清除缓存（用于决定是否刷新视图）
     */
    onFileChange(file: TFile): boolean {
        if (file.path.startsWith(this.config.journalsPath + '/') && file.extension === 'md') {
            this.clearCache();
            return true;
        }
        return false;
    }

    // 获取所有记账记录 - 每次都实时加载
    async getAllRecords(forceRefresh = false): Promise<AccountingRecord[]> {
        console.log('🔄 开始加载记账记录...');
        console.log(`📁 日记文件夹路径: ${this.config.journalsPath}`);
        console.log(`🔍 搜索关键词: ${Object.keys(this.config.categories).map(k => this.config.expenseEmoji + k).join(', ')}`);
        
        let records = [];
        
        try {
            // 优先使用搜索方式，更高效
            records = await this.getAllRecordsBySearch();
            
            console.log(`✅ 成功加载 ${records.length} 条记账记录`);
            
            // 打印日期分布统计
            if (records.length > 0) {
                const dateStats = {};
                records.forEach(r => {
                    dateStats[r.date] = (dateStats[r.date] || 0) + 1;
                });
                const sortedDates = Object.keys(dateStats).sort();
                console.log(`📅 日期范围: ${sortedDates[0]} 至 ${sortedDates[sortedDates.length - 1]}`);
                console.log(`📊 最近5天的记录数:`, Object.fromEntries(
                    sortedDates.slice(-5).map(d => [d, dateStats[d]])
                ));
            }
            
            return records;
            
        } catch (error) {
            console.error('❌ 获取记账记录失败:', error);
            new Notice('获取记账记录失败，请检查日记文件夹');
            return [];
        }
    }
    
    // 使用搜索 API 的方式 - 基于配置的关键词搜索
    async getAllRecordsBySearch(): Promise<AccountingRecord[]> {
        const records: AccountingRecord[] = [];
        const { expenseEmoji, categories } = this.config;
        
        try {
            // 获取所有配置的关键词
            const keywords = Object.keys(categories);
            console.log(`🔍 开始基于关键词搜索: ${keywords.map(k => expenseEmoji + k).join(', ')}`);
            
            // 先检查 journals 文件夹中有哪些文件
            const allJournalFiles = this.app.vault.getMarkdownFiles().filter(file => 
                file.path.startsWith(this.config.journalsPath)
            );
            console.log(`📁 journals 文件夹中共有 ${allJournalFiles.length} 个 markdown 文件`);
            
            // 打印最近10个文件
            const recentFiles = allJournalFiles
                .filter(f => /\d{4}-\d{2}-\d{2}\.md$/.test(f.name))
                .sort((a, b) => b.name.localeCompare(a.name))
                .slice(0, 10);
            console.log(`📄 最近的日期文件:`, recentFiles.map(f => f.name).join(', '));
            
            // 检查今天和最近几天的文件是否存在
            const today = new Date();
            const checkDates = [];
            for (let i = 0; i < 5; i++) {
                const date = new Date(today);
                date.setDate(date.getDate() - i);
                const dateStr = formatLocalDate(date);
                const fileName = `${dateStr}.md`;
                const filePath = `${this.config.journalsPath}/${fileName}`;
                const file = this.app.vault.getAbstractFileByPath(filePath);
                checkDates.push({
                    date: dateStr,
                    exists: file !== null,
                    path: filePath
                });
            }
            console.log(`🔍 检查最近5天的文件:`, checkDates);
            
            // 使用关键词搜索文件
            const searchResults = await this.searchFilesWithKeywords(keywords, expenseEmoji);
            
            console.log(`✅ 通过关键词搜索找到 ${searchResults.length} 个包含记账记录的文件`);
            console.log(`📄 搜索到的文件:`, searchResults.map(f => f.name).join(', '));
            
            // 只处理搜索到的文件
            for (const file of searchResults) {
                try {
                    const content = await this.app.vault.read(file);
                    const fileRecords = this.parser.parseFileContent(content, file.path);
                    if (fileRecords.length > 0) {
                        console.log(`  ✓ ${file.path}: ${fileRecords.length} 条记录`);
                        records.push(...fileRecords);
                    }
                } catch (error) {
                    console.error(`  ✗ 读取文件 ${file.path} 失败:`, error);
                }
            }
            
            console.log(`✅ 总共找到 ${records.length} 条记账记录`);
            return records.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
            
        } catch (error) {
            console.error('❌ 关键词搜索功能失败:', error);
            // 如果搜索失败，回退到优化的遍历方式
            console.log('🔄 回退到传统扫描方式...');
            return await this.getAllRecordsByOptimizedTraversal();
        }
    }
    
    // 搜索包含指定关键词的文件 - 使用 Obsidian 搜索引擎
    async searchFilesWithKeywords(keywords, expenseEmoji) {
        console.log('尝试使用 Obsidian 搜索引擎...');
        
        try {
            // 尝试使用 Obsidian 的搜索引擎
            const searchResults = await this.useObsidianSearchEngine(keywords, expenseEmoji);
            if (searchResults.length > 0) {
                console.log(`Obsidian 搜索引擎找到 ${searchResults.length} 个文件`);
                return searchResults;
            }
        } catch (error) {
            console.log('Obsidian 搜索引擎不可用:', error);
        }
        
        // 回退到自定义关键词搜索
        console.log('使用自定义关键词搜索...');
        return await this.useCustomKeywordSearch(keywords, expenseEmoji);
    }
    
    // 使用 Obsidian 搜索引擎
    async useObsidianSearchEngine(keywords, expenseEmoji) {
        const matchingFiles = new Set();
        
        // 尝试使用搜索引擎
        try {
            // 检查是否有搜索插件
            const searchPlugin = this.app.internalPlugins?.plugins?.['global-search'];
            if (searchPlugin && searchPlugin.enabled && searchPlugin.instance) {
                const searchInstance = searchPlugin.instance;
                
                // 为每个关键词执行搜索
                for (const keyword of keywords) {
                    const searchTerm = `${expenseEmoji}${keyword}`;
                    console.log(`搜索关键词: ${searchTerm}`);
                    
                    try {
                        // 执行搜索
                        const query = `path:${this.config.journalsPath} "${searchTerm}"`;
                        
                        // 尝试不同的搜索方法
                        let results = null;
                        
                        // 方法1: 使用搜索引擎的 searchText 方法
                        if (searchInstance.searchEngine && searchInstance.searchEngine.searchText) {
                            results = await searchInstance.searchEngine.searchText(searchTerm, {
                                path: this.config.journalsPath
                            });
                        }
                        
                        // 方法2: 使用搜索引擎的 search 方法
                        if (!results && searchInstance.searchEngine && searchInstance.searchEngine.search) {
                            results = await searchInstance.searchEngine.search(searchTerm);
                        }
                        
                        // 处理搜索结果
                        if (results && results.length > 0) {
                            results.forEach(result => {
                                if (result.file && result.file.path.startsWith(this.config.journalsPath)) {
                                    matchingFiles.add(result.file);
                                } else if (result.path && result.path.startsWith(this.config.journalsPath)) {
                                    const file = this.app.vault.getAbstractFileByPath(result.path);
                                    if (file) {
                                        matchingFiles.add(file);
                                    }
                                }
                            });
                            console.log(`关键词 ${searchTerm} 找到 ${results.length} 个结果`);
                        }
                        
                    } catch (error) {
                        console.log(`搜索关键词 ${searchTerm} 失败:`, error);
                    }
                }
                
                if (matchingFiles.size > 0) {
                    console.log(`搜索引擎总共找到 ${matchingFiles.size} 个文件`);
                    return Array.from(matchingFiles);
                }
            }
        } catch (error) {
            console.log('搜索引擎访问失败:', error);
        }
        
        // 搜索引擎未找到结果，返回空数组而不是抛出错误
        console.log('搜索引擎未找到结果，将使用自定义搜索');
        return [];
    }
    
    // 自定义关键词搜索实现 - 只扫描日期格式的文件
    async useCustomKeywordSearch(keywords, expenseEmoji) {
        const { vault, metadataCache } = this.app;
        const matchingFiles = new Set();
        
        // 获取所有 journals 文件夹下的 markdown 文件
        const allFiles = vault.getMarkdownFiles().filter(file => 
            file.path.startsWith(this.config.journalsPath)
        );
        
        // 只保留符合日期格式 yyyy-mm-dd.md 的文件
        const datePattern = /\d{4}-\d{2}-\d{2}\.md$/;
        const dateFiles = allFiles.filter(file => datePattern.test(file.name));
        
        console.log(`⚠️ 警告: Obsidian 搜索引擎不可用，回退到文件扫描模式`);
        console.log(`📁 总文件数: ${allFiles.length}，日期格式文件: ${dateFiles.length}`);
        console.log(`🔍 搜索关键词: ${keywords.map(k => expenseEmoji + k).join(', ')}`);
        
        // 打印最近10个日期文件
        const recentDateFiles = dateFiles
            .sort((a, b) => b.name.localeCompare(a.name))
            .slice(0, 10);
        console.log(`📄 最近10个日期文件:`, recentDateFiles.map(f => f.name).join(', '));
        
        // 构建正则表达式 - 匹配 #关键词 后面跟数字（可能有空格，也可能没有）
        const keywordPattern = keywords.join('|');
        // 注意：不使用 g 标志，避免 lastIndex 状态问题
        const searchPattern = `${expenseEmoji}\\s*(${keywordPattern})\\s*.*?[\\d.]+`;
        
        // 使用并行搜索，但分批处理以避免性能问题
        const batchSize = 50;
        let processedCount = 0;
        let usedCache = 0;
        let readFromDisk = 0;
        
        for (let i = 0; i < dateFiles.length; i += batchSize) {
            const batch = dateFiles.slice(i, i + batchSize);
            
            const batchPromises = batch.map(async (file) => {
                try {
                    let content = null;
                    
                    // 尝试从缓存获取内容
                    const cachedMetadata = metadataCache.getFileCache(file);
                    if (cachedMetadata && cachedMetadata.sections) {
                        content = await vault.cachedRead(file);
                        usedCache++;
                    } else {
                        content = await vault.read(file);
                        readFromDisk++;
                    }
                    
                    // 使用正则表达式检查是否包含有效的记账记录
                    // 每次都创建新的正则对象，避免 g 标志的状态问题
                    const regex = new RegExp(searchPattern);
                    if (regex.test(content)) {
                        console.log(`  ✓ 找到匹配文件: ${file.name}`);
                        return file;
                    }
                    return null;
                } catch (error) {
                    console.error(`  ✗ 检查文件 ${file.path} 失败:`, error);
                    return null;
                }
            });
            
            const batchResults = await Promise.all(batchPromises);
            const validFiles = batchResults.filter(file => file !== null);
            validFiles.forEach(file => matchingFiles.add(file));
            
            processedCount += batch.length;
            
            // 每50个文件显示一次进度
            if (processedCount % 50 === 0 || processedCount === dateFiles.length) {
                console.log(`📊 已扫描 ${processedCount}/${dateFiles.length} 个日期文件，找到 ${matchingFiles.size} 个包含记账记录的文件`);
            }
        }
        
        console.log(`✅ 扫描完成: 共找到 ${matchingFiles.size} 个包含有效记账记录的文件`);
        console.log(`📊 性能统计: 缓存读取 ${usedCache} 个，磁盘读取 ${readFromDisk} 个`);
        console.log(`🚀 优化效果: 跳过了 ${allFiles.length - dateFiles.length} 个非日期格式文件`);
        return Array.from(matchingFiles);
    }
    
    // 优化的遍历方式：预筛选 + 并行处理
    async getAllRecordsByOptimizedTraversal() {
        const { vault } = this.app;
        const { expenseEmoji } = this.config;
        
        // 检查文件夹是否存在
        const journalsFolder = vault.getAbstractFileByPath(this.config.journalsPath);
        if (!journalsFolder) {
            new Notice(`未找到 ${this.config.journalsPath} 文件夹`);
            return [];
        }

        // 获取所有 journals 文件夹下的 markdown 文件
        const allFiles = vault.getMarkdownFiles().filter(file => 
            file.path.startsWith(this.config.journalsPath)
        );
        
        console.log(`开始扫描 ${allFiles.length} 个日记文件...`);
        
        // 分批处理文件，避免一次性读取太多文件
        const batchSize = 10;
        const records = [];
        
        for (let i = 0; i < allFiles.length; i += batchSize) {
            const batch = allFiles.slice(i, i + batchSize);
            
            const batchPromises = batch.map(async (file) => {
                try {
                    // 先读取文件的前几行来快速检查是否包含记账标识符
                    const content = await vault.read(file);
                    
                    // 快速检查：如果文件不包含记账标识符，跳过
                    if (!content.includes(expenseEmoji)) {
                        return [];
                    }
                    
                    // 解析记账记录
                    const fileRecords = this.parser.parseFileContent(content, file.path);
                    if (fileRecords.length > 0) {
                        console.log(`在 ${file.path} 中找到 ${fileRecords.length} 条记账记录`);
                    }
                    
                    return fileRecords;
                } catch (error) {
                    console.error(`读取文件 ${file.path} 失败:`, error);
                    return [];
                }
            });
            
            const batchResults = await Promise.all(batchPromises);
            batchResults.forEach(fileRecords => {
                records.push(...fileRecords);
            });
        }
        
        console.log(`总共找到 ${records.length} 条记账记录`);
        return records.sort((a, b) => new Date(b.date) - new Date(a.date));
    }

    // 按日期范围筛选记录
    filterRecordsByDateRange(records: AccountingRecord[], startDate: string, endDate: string): AccountingRecord[] {
        return records.filter(record => {
            const recordDate = new Date(record.date);
            return recordDate >= new Date(startDate) && recordDate <= new Date(endDate);
        });
    }

    // 统计数据
    calculateStatistics(records: AccountingRecord[]): AccountingStats {
        const stats: AccountingStats = {
            totalIncome: 0,
            totalExpense: 0,
            categoryStats: {},
            dailyStats: {},
            budgetStatus: null // 新增预算状态
        };

        records.forEach(record => {
            if (record.isIncome) {
                stats.totalIncome += record.amount;
            } else {
                stats.totalExpense += record.amount;
            }

            // 分类统计
            if (!stats.categoryStats[record.category]) {
                stats.categoryStats[record.category] = {
                    total: 0,
                    count: 0,
                    records: []
                };
            }
            stats.categoryStats[record.category].total += record.amount;
            stats.categoryStats[record.category].count += 1;
            stats.categoryStats[record.category].records.push(record);

            // 日期统计
            if (!stats.dailyStats[record.date]) {
                stats.dailyStats[record.date] = {
                    income: 0,
                    expense: 0,
                    records: []
                };
            }
            if (record.isIncome) {
                stats.dailyStats[record.date].income += record.amount;
            } else {
                stats.dailyStats[record.date].expense += record.amount;
            }
            stats.dailyStats[record.date].records.push(record);
        });

        // 计算预算状态
        stats.budgetStatus = this.calculateBudgetStatus(stats);

        return stats;
    }
    
    // 计算预算状态
    calculateBudgetStatus(stats: AccountingStats): BudgetStatus | null {
        const budgets = this.config.budgets;
        if (!budgets || !budgets.enableAlerts) {
            return null;
        }
        
        const budgetStatus = {
            totalBudget: budgets.monthly.total,
            totalSpent: stats.totalExpense,
            totalRemaining: budgets.monthly.total - stats.totalExpense,
            totalProgress: budgets.monthly.total > 0 ? stats.totalExpense / budgets.monthly.total : 0,
            categories: {},
            alerts: []
        };
        
        // 检查总预算
        if (budgetStatus.totalProgress >= budgets.alertThreshold) {
            const alertType = budgetStatus.totalProgress >= 1 ? 'exceeded' : 'warning';
            budgetStatus.alerts.push({
                type: alertType,
                category: '总预算',
                message: alertType === 'exceeded' 
                    ? `总支出已超出预算 ¥${(stats.totalExpense - budgets.monthly.total).toFixed(2)}`
                    : `总支出已达预算的 ${(budgetStatus.totalProgress * 100).toFixed(0)}%`
            });
        }
        
        // 检查分类预算
        Object.entries(budgets.monthly.categories).forEach(([keyword, budget]) => {
            const categoryName = this.config.categories[keyword];
            if (!categoryName || budget <= 0) return;
            
            const spent = stats.categoryStats[categoryName]?.total || 0;
            const progress = spent / budget;
            const remaining = budget - spent;
            
            budgetStatus.categories[categoryName] = {
                budget,
                spent,
                remaining,
                progress,
                keyword
            };
            
            // 检查是否需要告警
            if (progress >= budgets.alertThreshold) {
                const alertType = progress >= 1 ? 'exceeded' : 'warning';
                budgetStatus.alerts.push({
                    type: alertType,
                    category: categoryName,
                    message: alertType === 'exceeded'
                        ? `${categoryName}支出已超出预算 ¥${(spent - budget).toFixed(2)}`
                        : `${categoryName}支出已达预算的 ${(progress * 100).toFixed(0)}%`
                });
            }
        });
        
        return budgetStatus;
    }
}

// 分类配置模态框
class CategoryConfigModal extends Modal {
    plugin: any;
    appName: string;
    categories: Record<string, string>;
    budgets: AccountingConfig['budgets'];
    currentTab: string;
    contentArea: HTMLElement;
    categoryList: HTMLElement;
    budgetList: HTMLElement;
    
    constructor(app: any, plugin: any) {
        super(app);
        this.plugin = plugin;
        this.appName = plugin.config.appName || '记账软件'; // 应用名称
        this.categories = { ...plugin.config.categories }; // 复制当前配置
        this.budgets = plugin.config.budgets ? { ...plugin.config.budgets } : {
            monthly: { total: 0, categories: {} },
            enableAlerts: true,
            alertThreshold: 0.8
        };
        this.currentTab = 'basic'; // 当前标签页，默认基础设置
    }

    onOpen() {
        // 使用自定义的应用名称作为标题
        const appName = this.plugin.config.appName || '每日记账';
        this.titleEl.setText(`${appName}配置`);
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass('category-config-modal');

        // 标签页导航
        this.renderTabs(contentEl);
        
        // 内容区域
        this.contentArea = contentEl.createDiv('config-content');
        this.renderCurrentTab();

        // 按钮组
        const buttons = contentEl.createDiv('config-buttons');
        
        const cancelBtn = buttons.createEl('button', {
            text: '取消',
            cls: 'config-btn config-btn-cancel'
        });
        cancelBtn.onclick = () => this.close();

        const saveBtn = buttons.createEl('button', {
            text: '保存',
            cls: 'config-btn config-btn-save'
        });
        saveBtn.onclick = () => this.saveConfig();
    }

    renderTabs(container) {
        const tabsContainer = container.createDiv('config-tabs');
        
        const tabs = [
            { key: 'basic', label: '基础设置' },
            { key: 'categories', label: '分类管理' },
            { key: 'budgets', label: '预算设置' }
        ];
        
        tabs.forEach(tab => {
            const tabBtn = tabsContainer.createEl('button', {
                text: tab.label,
                cls: `config-tab ${this.currentTab === tab.key ? 'active' : ''}`
            });
            tabBtn.onclick = () => this.switchTab(tab.key);
        });
    }

    switchTab(tabKey) {
        this.currentTab = tabKey;
        
        // 更新标签按钮状态
        document.querySelectorAll('.config-tab').forEach(btn => {
            btn.classList.remove('active');
        });
        const tabIndex = tabKey === 'basic' ? 1 : (tabKey === 'categories' ? 2 : 3);
        document.querySelector(`.config-tab:nth-child(${tabIndex})`).classList.add('active');
        
        this.renderCurrentTab();
    }

    renderCurrentTab() {
        this.contentArea.empty();
        
        if (this.currentTab === 'basic') {
            this.renderBasicTab();
        } else if (this.currentTab === 'categories') {
            this.renderCategoriesTab();
        } else {
            this.renderBudgetsTab();
        }
    }

    renderBasicTab() {
        // 说明文字
        const description = this.contentArea.createDiv('config-description');
        description.innerHTML = `
            <p>自定义应用名称和默认分类，让记账软件更具个性化</p>
        `;

        // 应用名称设置
        const nameSection = this.contentArea.createDiv('config-section');
        nameSection.createEl('h3', { text: '应用名称' });
        
        const nameGroup = nameSection.createDiv('config-input-group');
        nameGroup.createEl('label', { text: '显示名称：' });
        const nameInput = nameGroup.createEl('input', {
            type: 'text',
            cls: 'config-text-input',
            value: this.appName,
            attr: { placeholder: '记账软件', maxlength: '20' }
        });
        nameInput.oninput = () => {
            this.appName = nameInput.value.trim() || '每日记账';
        };

        // 默认分类设置
        const defaultCategorySection = this.contentArea.createDiv('config-section');
        defaultCategorySection.createEl('h3', { text: '默认分类' });
        
        const defaultCategoryGroup = defaultCategorySection.createDiv('config-input-group');
        defaultCategoryGroup.createEl('label', { text: '快速记账默认分类：' });
        
        const defaultCategorySelect = defaultCategoryGroup.createEl('select', {
            cls: 'config-select-input'
        });
        
        // 添加分类选项
        Object.entries(this.categories).forEach(([keyword, categoryName]) => {
            const option = defaultCategorySelect.createEl('option', {
                value: keyword,
                text: `${categoryName} (${keyword})`
            });
            
            // 设置当前选中的默认分类
            const currentDefault = this.plugin.config.defaultCategory || 'cy';
            if (keyword === currentDefault) {
                option.selected = true;
            }
        });


        // 预览效果
        const previewSection = this.contentArea.createDiv('config-section');
        previewSection.createEl('h3', { text: '预览效果' });
        
        const previewBox = previewSection.createDiv('config-preview-box');
        const previewTitle = previewBox.createEl('div', { 
            cls: 'preview-title'
        });
        
        const updatePreview = () => {
            previewTitle.textContent = `💰 ${this.appName}`;
        };
        
        updatePreview();
        nameInput.oninput = () => {
            this.appName = nameInput.value.trim() || '记账软件';
            updatePreview();
        };
    }

    renderCategoriesTab() {
        // 说明文字
        const description = this.contentArea.createDiv('config-description');
        description.innerHTML = `
            <p>配置记账关键词和对应的分类名称</p>
            <p><strong>注意：</strong> <code>sr</code> 关键词表示收入，其他为支出</p>
        `;

        // 分类列表
        this.categoryList = this.contentArea.createDiv('category-list');
        this.renderCategoryList();

        // 添加新分类按钮
        const addButton = this.contentArea.createEl('button', {
            text: '+ 添加新分类',
            cls: 'add-category-btn'
        });
        addButton.onclick = () => this.addNewCategory();
    }

    renderBudgetsTab() {
        // 说明文字
        const description = this.contentArea.createDiv('config-description');
        description.innerHTML = `
            <p>设置月度预算限额，系统会在接近或超出预算时提醒</p>
            <p><strong>提示：</strong> 设置为 0 表示不限制该分类预算</p>
        `;

        // 预算开关
        const alertSection = this.contentArea.createDiv('budget-section');
        alertSection.createEl('h3', { text: '预算提醒设置' });
        
        const alertToggle = alertSection.createDiv('budget-toggle');
        const enableCheckbox = alertToggle.createEl('input', { type: 'checkbox' });
        enableCheckbox.checked = this.budgets.enableAlerts;
        enableCheckbox.onchange = () => {
            this.budgets.enableAlerts = enableCheckbox.checked;
        };
        alertToggle.createSpan({ text: '启用预算告警' });

        // 告警阈值
        const thresholdSection = alertSection.createDiv('threshold-section');
        thresholdSection.createEl('label', { text: '告警阈值 (%)：' });
        const thresholdInput = thresholdSection.createEl('input', {
            type: 'number',
            value: (this.budgets.alertThreshold * 100).toString(),
            attr: { min: '50', max: '100', step: '5' }
        });
        thresholdInput.onchange = () => {
            this.budgets.alertThreshold = parseInt(thresholdInput.value) / 100;
        };

        // 总预算
        const totalSection = this.contentArea.createDiv('budget-section');
        totalSection.createEl('h3', { text: '月度总预算' });
        const totalInput = totalSection.createEl('input', {
            type: 'number',
            cls: 'budget-input total-budget',
            value: this.budgets.monthly.total.toString(),
            attr: { placeholder: '月度总预算', min: '0', step: '100' }
        });
        totalInput.onchange = () => {
            this.budgets.monthly.total = parseFloat(totalInput.value) || 0;
        };

        // 分类预算
        const categorySection = this.contentArea.createDiv('budget-section');
        categorySection.createEl('h3', { text: '分类预算' });
        
        this.budgetList = categorySection.createDiv('budget-list');
        this.renderBudgetList();
    }

    renderBudgetList() {
        this.budgetList.empty();

        Object.entries(this.categories).forEach(([keyword, categoryName]) => {
            if (keyword === 'sr') return; // 跳过收入分类
            
            const item = this.budgetList.createDiv('budget-item');
            
            const label = item.createDiv('budget-label');
            label.textContent = `${categoryName} (${keyword})`;
            
            const input = item.createEl('input', {
                type: 'number',
                cls: 'budget-input',
                value: (this.budgets.monthly.categories[keyword] || 0).toString(),
                attr: { placeholder: '预算金额', min: '0', step: '50' }
            });
            
            input.onchange = () => {
                const value = parseFloat(input.value) || 0;
                if (value > 0) {
                    this.budgets.monthly.categories[keyword] = value;
                } else {
                    delete this.budgets.monthly.categories[keyword];
                }
            };
        });
    }

    renderCategoryList() {
        this.categoryList.empty();

        Object.entries(this.categories).forEach(([keyword, category]) => {
            const item = this.categoryList.createDiv('category-item');
            
            const keywordInput = item.createEl('input', {
                type: 'text',
                cls: 'category-keyword',
                value: keyword,
                placeholder: '关键词'
            });
            keywordInput.maxLength = 10;

            const categoryInput = item.createEl('input', {
                type: 'text',
                cls: 'category-name',
                value: category,
                placeholder: '分类名称'
            });
            categoryInput.maxLength = 20;

            const deleteBtn = item.createEl('button', {
                text: '删除',
                cls: 'delete-category-btn'
            });
            deleteBtn.onclick = () => this.deleteCategory(keyword);

            // 监听输入变化
            keywordInput.oninput = () => this.updateCategory(keyword, keywordInput.value, categoryInput.value);
            categoryInput.oninput = () => this.updateCategory(keyword, keywordInput.value, categoryInput.value);
        });
    }

    addNewCategory() {
        const newKeyword = `new${Date.now()}`;
        this.categories[newKeyword] = '新分类';
        this.renderCategoryList();
    }

    deleteCategory(keyword) {
        delete this.categories[keyword];
        // 同时删除对应的预算设置
        delete this.budgets.monthly.categories[keyword];
        this.renderCategoryList();
        if (this.currentTab === 'budgets') {
            this.renderBudgetList();
        }
    }

    updateCategory(oldKeyword, newKeyword, categoryName) {
        if (oldKeyword !== newKeyword) {
            delete this.categories[oldKeyword];
            // 更新预算设置中的关键词
            if (this.budgets.monthly.categories[oldKeyword]) {
                this.budgets.monthly.categories[newKeyword] = this.budgets.monthly.categories[oldKeyword];
                delete this.budgets.monthly.categories[oldKeyword];
            }
        }
        this.categories[newKeyword] = categoryName;
    }

    async saveConfig() {
        try {
            // 验证应用名称
            const cleanAppName = this.appName.trim();
            if (!cleanAppName) {
                new Notice('应用名称不能为空');
                return;
            }

            // 验证分类配置
            const cleanCategories = {};
            for (const [keyword, category] of Object.entries(this.categories)) {
                const cleanKeyword = keyword.trim();
                const cleanCategory = category.trim();
                
                if (cleanKeyword && cleanCategory) {
                    cleanCategories[cleanKeyword] = cleanCategory;
                }
            }

            if (Object.keys(cleanCategories).length === 0) {
                new Notice('至少需要一个分类');
                return;
            }

            // 获取默认分类选择
            const defaultCategorySelect = document.querySelector('.config-select-input') as HTMLSelectElement;
            const defaultCategory = defaultCategorySelect ? defaultCategorySelect.value : 'cy';

            // 更新配置
            this.plugin.config.appName = cleanAppName;
            this.plugin.config.categories = cleanCategories;
            this.plugin.config.defaultCategory = defaultCategory;
            this.plugin.config.budgets = this.budgets;
            
            // 保存到文件
            const configPath = `${this.plugin.manifest.dir}/config.json`;
            const adapter = this.app.vault.adapter;
            const configContent = JSON.stringify(this.plugin.config, null, 4);
            await adapter.write(configPath, configContent);

            // 清除缓存，重新加载数据
            this.plugin.storage.clearCache();
            
            this.close();
            
            // 关闭并重新打开视图以刷新标题
            const leaves = this.app.workspace.getLeavesOfType(ACCOUNTING_VIEW);
            for (const leaf of leaves) {
                // 先分离视图
                await leaf.setViewState({ type: 'empty' });
            }
            
            // 等待一小段时间后重新打开
            setTimeout(async () => {
                await this.plugin.activateView();
            }, 100);
        } catch (error) {
            console.error('保存配置失败:', error);
            new Notice('保存配置失败');
        }
    }
}
class DateRangeModal extends Modal {
    options: any;
    startInput: HTMLInputElement;
    endInput: HTMLInputElement;
    
    constructor(app: any, options: any) {
        super(app);
        this.options = options;
    }

    onOpen() {
        this.titleEl.setText('选择查询时间范围');
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass('date-range-modal');

        // 开始日期
        const startGroup = contentEl.createDiv('date-group');
        startGroup.createEl('label', { text: '开始日期:' });
        this.startInput = startGroup.createEl('input', {
            type: 'date',
            cls: 'date-input'
        });
        
        // 结束日期
        const endGroup = contentEl.createDiv('date-group');
        endGroup.createEl('label', { text: '结束日期:' });
        this.endInput = endGroup.createEl('input', {
            type: 'date',
            cls: 'date-input'
        });

        // 设置默认值：本月1号到今天
        const today = new Date();
        const firstDayOfMonth = new Date(today.getFullYear(), today.getMonth(), 1);
        
        // 使用本地日期格式，避免时区问题
        this.startInput.value = formatLocalDate(firstDayOfMonth);
        this.endInput.value = formatLocalDate(today);

        // 按钮
        const buttons = contentEl.createDiv('date-buttons');
        
        const cancelBtn = buttons.createEl('button', {
            text: '取消',
            cls: 'date-btn date-btn-cancel'
        });
        cancelBtn.onclick = () => this.close();

        const confirmBtn = buttons.createEl('button', {
            text: '确定',
            cls: 'date-btn date-btn-confirm'
        });
        confirmBtn.onclick = () => {
            const startDate = this.startInput.value;
            const endDate = this.endInput.value;
            
            if (startDate && endDate) {
                this.options.onSelect(startDate, endDate);
                this.close();
            } else {
                new Notice('请选择完整的日期范围');
            }
        };
    }

    formatDate(date: Date): string {
        // 使用本地时区格式化日期，避免 UTC 时区问题
        return formatLocalDate(date);
    }
}

// Markdown 导出模态框
class MarkdownExportModal extends Modal {
    markdown: string;
    fileName: string;
    folders: string[];
    selectedFolder: string;
    fileNameInput: HTMLInputElement;
    
    constructor(app: any, markdown: string, fileName: string) {
        super(app);
        this.markdown = markdown;
        this.fileName = fileName;
        this.folders = this.getAllFolders();
        this.selectedFolder = this.folders[0] || '/';
    }

    getAllFolders(): string[] {
        const folders: string[] = ['/'];  // 根目录
        const allFiles = this.app.vault.getAllLoadedFiles();
        
        allFiles.forEach((file: any) => {
            if (file.children !== undefined) {  // 是文件夹
                folders.push(file.path);
            }
        });
        
        return folders.sort();
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass('markdown-export-modal');

        this.titleEl.setText('导出 Markdown');

        // 保存设置区域
        const saveSection = contentEl.createDiv('export-save-section');
        
        // 文件夹选择
        const folderGroup = saveSection.createDiv('export-input-group');
        folderGroup.createEl('label', { text: '保存位置：', cls: 'export-label' });
        
        const folderSelect = folderGroup.createEl('select', {
            cls: 'export-folder-select'
        });
        
        this.folders.forEach(folder => {
            const option = folderSelect.createEl('option', {
                value: folder,
                text: folder === '/' ? '/ (根目录)' : folder
            });
        });
        
        folderSelect.onchange = () => {
            this.selectedFolder = folderSelect.value;
        };

        // 文件名输入
        const fileNameGroup = saveSection.createDiv('export-input-group');
        fileNameGroup.createEl('label', { text: '文件名：', cls: 'export-label' });
        
        const fileNameWrapper = fileNameGroup.createDiv('export-filename-wrapper');
        this.fileNameInput = fileNameWrapper.createEl('input', {
            type: 'text',
            cls: 'export-filename-input',
            value: this.fileName,
            attr: { placeholder: '输入文件名' }
        });
        fileNameWrapper.createSpan({ text: '.md', cls: 'export-filename-ext' });

        // 预览区域
        const previewSection = contentEl.createDiv('markdown-preview-section');
        previewSection.createEl('label', { text: '预览：', cls: 'export-label' });
        
        const previewContainer = previewSection.createEl('textarea', {
            cls: 'markdown-preview-textarea',
            attr: { readonly: 'true', rows: '15' }
        });
        previewContainer.value = this.markdown;

        // 按钮组
        const buttons = contentEl.createDiv('export-buttons');
        
        const copyBtn = buttons.createEl('button', {
            text: '复制到剪贴板',
            cls: 'export-btn export-btn-cancel'
        });
        copyBtn.onclick = async () => {
            await navigator.clipboard.writeText(this.markdown);
            new Notice('已复制到剪贴板');
        };

        const saveBtn = buttons.createEl('button', {
            text: '保存文件',
            cls: 'export-btn export-btn-export'
        });
        saveBtn.onclick = () => this.saveFile();
    }

    async saveFile() {
        try {
            const fileName = this.fileNameInput.value.trim();
            if (!fileName) {
                new Notice('请输入文件名');
                return;
            }

            // 构建完整路径
            let filePath: string;
            if (this.selectedFolder === '/') {
                filePath = `${fileName}.md`;
            } else {
                filePath = `${this.selectedFolder}/${fileName}.md`;
            }

            // 检查文件是否存在
            const existingFile = this.app.vault.getAbstractFileByPath(filePath);
            
            if (existingFile instanceof TFile) {
                // 文件存在，询问是否覆盖
                const confirmed = confirm(`文件 "${filePath}" 已存在，是否覆盖？`);
                if (!confirmed) {
                    return;
                }
                await this.app.vault.modify(existingFile, this.markdown);
            } else {
                // 创建新文件
                await this.app.vault.create(filePath, this.markdown);
            }

            new Notice(`已保存到: ${filePath}`);
            this.close();
            
            // 打开保存的文件
            const file = this.app.vault.getAbstractFileByPath(filePath);
            if (file instanceof TFile) {
                const leaf = this.app.workspace.getLeaf();
                await leaf.openFile(file);
            }
        } catch (error) {
            console.error('保存文件失败:', error);
            new Notice('保存失败，请检查文件名是否有效');
        }
    }
}

// PDF 导出模态框
class ExportPDFModal extends Modal {
    plugin: any;
    records: AccountingRecord[];
    stats: AccountingStats;
    dateRange: { start: string; end: string; label: string };
    
    constructor(app: any, plugin: any, records: AccountingRecord[], stats: AccountingStats, dateRange: { start: string; end: string; label: string }) {
        super(app);
        this.plugin = plugin;
        this.records = records;
        this.stats = stats;
        this.dateRange = dateRange;
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass('export-pdf-modal');

        this.titleEl.setText('导出账单 PDF');

        // 预览区域
        const previewSection = contentEl.createDiv('export-preview-section');
        previewSection.createEl('label', { text: '预览', cls: 'export-label' });
        
        const previewContainer = previewSection.createDiv('export-preview-container');
        const previewContent = this.generatePDFContent(previewContainer);
        
        // 按钮组
        const buttons = contentEl.createDiv('export-buttons');
        
        const cancelBtn = buttons.createEl('button', {
            text: '取消',
            cls: 'export-btn export-btn-cancel'
        });
        cancelBtn.onclick = () => this.close();
        
        const exportBtn = buttons.createEl('button', {
            text: '导出 PDF',
            cls: 'export-btn export-btn-export'
        });
        exportBtn.onclick = () => this.exportToPDF();
    }

    generatePDFContent(container: HTMLElement): HTMLElement {
        const content = container.createDiv('pdf-content');
        
        // 标题
        const appName = this.plugin.config.appName || '每日记账';
        content.createEl('h1', { 
            text: `${appName} - 账单报告`, 
            cls: 'pdf-title' 
        });
        
        // 时间范围
        content.createEl('p', { 
            text: `时间范围: ${this.dateRange.label} (${this.dateRange.start} 至 ${this.dateRange.end})`,
            cls: 'pdf-date-range'
        });
        
        content.createEl('p', {
            text: `导出时间: ${formatLocalDate(new Date())} ${new Date().toLocaleTimeString('zh-CN')}`,
            cls: 'pdf-export-time'
        });

        // 统计概览
        const statsSection = content.createDiv('pdf-stats-section');
        statsSection.createEl('h2', { text: '统计概览' });
        
        const statsGrid = statsSection.createDiv('pdf-stats-grid');
        
        const { totalIncome, totalExpense } = this.stats;
        const balance = totalIncome - totalExpense;
        
        // 收入
        const incomeCard = statsGrid.createDiv('pdf-stat-card income');
        incomeCard.createDiv({ text: '总收入', cls: 'pdf-stat-label' });
        incomeCard.createDiv({ text: `¥${totalIncome.toFixed(2)}`, cls: 'pdf-stat-value' });
        
        // 支出
        const expenseCard = statsGrid.createDiv('pdf-stat-card expense');
        expenseCard.createDiv({ text: '总支出', cls: 'pdf-stat-label' });
        expenseCard.createDiv({ text: `¥${totalExpense.toFixed(2)}`, cls: 'pdf-stat-value' });
        
        // 结余
        const balanceCard = statsGrid.createDiv(`pdf-stat-card ${balance >= 0 ? 'positive' : 'negative'}`);
        balanceCard.createDiv({ text: '结余', cls: 'pdf-stat-label' });
        balanceCard.createDiv({ text: `¥${balance.toFixed(2)}`, cls: 'pdf-stat-value' });

        // 分类统计
        if (Object.keys(this.stats.categoryStats).length > 0) {
            const categorySection = content.createDiv('pdf-category-section');
            categorySection.createEl('h2', { text: '分类统计' });
            
            const categoryTable = categorySection.createEl('table', { cls: 'pdf-table' });
            const thead = categoryTable.createEl('thead');
            const headerRow = thead.createEl('tr');
            headerRow.createEl('th', { text: '分类' });
            headerRow.createEl('th', { text: '金额' });
            headerRow.createEl('th', { text: '笔数' });
            headerRow.createEl('th', { text: '占比' });
            
            const tbody = categoryTable.createEl('tbody');
            
            // 计算总支出用于占比
            const totalForPercentage = totalExpense > 0 ? totalExpense : 1;
            
            Object.entries(this.stats.categoryStats)
                .sort(([,a], [,b]) => b.total - a.total)
                .forEach(([category, data]) => {
                    const row = tbody.createEl('tr');
                    row.createEl('td', { text: category });
                    row.createEl('td', { text: `¥${data.total.toFixed(2)}` });
                    row.createEl('td', { text: `${data.count} 笔` });
                    
                    // 收入类别不计算占比
                    const isIncome = data.records.some(r => r.isIncome);
                    const percentage = isIncome ? '-' : `${((data.total / totalForPercentage) * 100).toFixed(1)}%`;
                    row.createEl('td', { text: percentage });
                });
        }

        // 详细记录
        const recordsSection = content.createDiv('pdf-records-section');
        recordsSection.createEl('h2', { text: `详细记录 (共 ${this.records.length} 笔)` });
        
        // 按日期分组
        const groupedRecords = this.groupRecordsByDate(this.records);
        
        Object.entries(groupedRecords)
            .sort(([a], [b]) => new Date(b).getTime() - new Date(a).getTime())
            .forEach(([date, dayRecords]) => {
                const dayGroup = recordsSection.createDiv('pdf-day-group');
                
                // 日期头部
                const dayHeader = dayGroup.createDiv('pdf-day-header');
                const dayTotal = dayRecords.reduce((sum, r) => sum + (r.isIncome ? r.amount : -r.amount), 0);
                dayHeader.createSpan({ text: date, cls: 'pdf-day-date' });
                dayHeader.createSpan({ 
                    text: `¥${dayTotal.toFixed(2)}`, 
                    cls: `pdf-day-total ${dayTotal >= 0 ? 'positive' : 'negative'}`
                });
                
                // 日期下的记录表格
                const dayTable = dayGroup.createEl('table', { cls: 'pdf-table pdf-day-table' });
                const dayTbody = dayTable.createEl('tbody');
                
                dayRecords.forEach(record => {
                    const row = dayTbody.createEl('tr');
                    row.createEl('td', { text: record.category, cls: 'pdf-record-category' });
                    row.createEl('td', { text: record.description || '-', cls: 'pdf-record-desc' });
                    
                    const amountCell = row.createEl('td', { cls: 'pdf-record-amount' });
                    amountCell.textContent = record.isIncome ? `+¥${record.amount}` : `-¥${record.amount}`;
                    amountCell.classList.add(record.isIncome ? 'income' : 'expense');
                });
            });

        return content;
    }

    groupRecordsByDate(records: AccountingRecord[]): Record<string, AccountingRecord[]> {
        const grouped: Record<string, AccountingRecord[]> = {};
        records.forEach(record => {
            if (!grouped[record.date]) {
                grouped[record.date] = [];
            }
            grouped[record.date].push(record);
        });
        return grouped;
    }

    async exportToPDF() {
        try {
            new Notice('正在生成 PDF...');
            
            // 获取预览容器
            const previewContainer = this.contentEl.querySelector('.export-preview-container') as HTMLElement;
            if (!previewContainer) {
                throw new Error('找不到预览内容');
            }

            // 创建一个临时容器用于渲染 PDF 内容
            const tempContainer = document.createElement('div');
            tempContainer.style.position = 'absolute';
            tempContainer.style.left = '-9999px';
            tempContainer.style.top = '0';
            tempContainer.style.width = '800px';
            tempContainer.style.padding = '20px';
            tempContainer.style.background = '#ffffff';
            tempContainer.style.fontFamily = '-apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif';
            tempContainer.innerHTML = this.generatePDFHTML();
            document.body.appendChild(tempContainer);

            // 等待渲染完成
            await new Promise(resolve => setTimeout(resolve, 100));

            // 使用 html2canvas 将 HTML 转换为 canvas
            const canvas = await html2canvas(tempContainer, {
                scale: 2, // 提高清晰度
                useCORS: true,
                logging: false,
                backgroundColor: '#ffffff'
            });

            // 清理临时容器
            document.body.removeChild(tempContainer);

            // 创建 PDF
            const imgWidth = 210; // A4 宽度 (mm)
            const pageHeight = 297; // A4 高度 (mm)
            const imgHeight = (canvas.height * imgWidth) / canvas.width;
            
            const pdf = new jsPDF('p', 'mm', 'a4');
            
            // 如果内容超过一页，需要分页
            let heightLeft = imgHeight;
            let position = 0;
            const imgData = canvas.toDataURL('image/png');

            // 添加第一页
            pdf.addImage(imgData, 'PNG', 0, position, imgWidth, imgHeight);
            heightLeft -= pageHeight;

            // 添加后续页面
            while (heightLeft > 0) {
                position = heightLeft - imgHeight;
                pdf.addPage();
                pdf.addImage(imgData, 'PNG', 0, position, imgWidth, imgHeight);
                heightLeft -= pageHeight;
            }

            // 生成文件名
            const appName = this.plugin.config.appName || '每日记账';
            const fileName = `${appName}_${this.dateRange.start}_${this.dateRange.end}.pdf`;

            // 保存 PDF
            pdf.save(fileName);

            new Notice(`PDF 已保存: ${fileName}`);
            this.close();
        } catch (error) {
            console.error('导出 PDF 失败:', error);
            new Notice('导出 PDF 失败，请重试');
        }
    }

    // 生成用于 PDF 渲染的 HTML
    generatePDFHTML(): string {
        const appName = this.plugin.config.appName || '每日记账';
        const { totalIncome, totalExpense } = this.stats;
        const balance = totalIncome - totalExpense;
        
        // 按日期分组
        const groupedRecords = this.groupRecordsByDate(this.records);
        const sortedDates = Object.keys(groupedRecords).sort((a, b) => new Date(b).getTime() - new Date(a).getTime());
        
        // 生成分类统计 HTML
        let categoryStatsHTML = '';
        if (Object.keys(this.stats.categoryStats).length > 0) {
            const totalForPercentage = totalExpense > 0 ? totalExpense : 1;
            const categoryRows = Object.entries(this.stats.categoryStats)
                .sort(([,a], [,b]) => b.total - a.total)
                .map(([category, data]) => {
                    const isIncome = data.records.some(r => r.isIncome);
                    const percentage = isIncome ? '-' : `${((data.total / totalForPercentage) * 100).toFixed(1)}%`;
                    return `
                        <tr>
                            <td style="padding: 8px 12px; border-bottom: 1px solid #e5e7eb;">${category}</td>
                            <td style="padding: 8px 12px; border-bottom: 1px solid #e5e7eb;">¥${data.total.toFixed(2)}</td>
                            <td style="padding: 8px 12px; border-bottom: 1px solid #e5e7eb;">${data.count} 笔</td>
                            <td style="padding: 8px 12px; border-bottom: 1px solid #e5e7eb;">${percentage}</td>
                        </tr>
                    `;
                })
                .join('');
            
            categoryStatsHTML = `
                <div style="margin: 20px 0;">
                    <h2 style="font-size: 16px; font-weight: 600; margin-bottom: 12px; color: #374151;">分类统计</h2>
                    <table style="width: 100%; border-collapse: collapse; font-size: 13px; border: 1px solid #e5e7eb;">
                        <thead>
                            <tr style="background: #f9fafb;">
                                <th style="padding: 8px 12px; text-align: left; font-weight: 600;">分类</th>
                                <th style="padding: 8px 12px; text-align: left; font-weight: 600;">金额</th>
                                <th style="padding: 8px 12px; text-align: left; font-weight: 600;">笔数</th>
                                <th style="padding: 8px 12px; text-align: left; font-weight: 600;">占比</th>
                            </tr>
                        </thead>
                        <tbody>
                            ${categoryRows}
                        </tbody>
                    </table>
                </div>
            `;
        }
        
        // 生成详细记录 HTML
        const recordsHTML = sortedDates.map(date => {
            const dayRecords = groupedRecords[date];
            const dayTotal = dayRecords.reduce((sum, r) => sum + (r.isIncome ? r.amount : -r.amount), 0);
            
            const recordRows = dayRecords.map(record => `
                <tr>
                    <td style="padding: 6px 12px; border-bottom: 1px solid #f3f4f6; font-weight: 500; width: 80px;">${record.category}</td>
                    <td style="padding: 6px 12px; border-bottom: 1px solid #f3f4f6; color: #6b7280;">${record.description || '-'}</td>
                    <td style="padding: 6px 12px; border-bottom: 1px solid #f3f4f6; text-align: right; font-weight: 600; width: 100px; color: ${record.isIncome ? '#059669' : '#dc2626'};">
                        ${record.isIncome ? '+' : '-'}¥${record.amount.toFixed(2)}
                    </td>
                </tr>
            `).join('');
            
            return `
                <div style="margin: 12px 0; border: 1px solid #e5e7eb; border-radius: 6px; overflow: hidden;">
                    <div style="display: flex; justify-content: space-between; align-items: center; padding: 10px 14px; background: #f9fafb; border-bottom: 1px solid #e5e7eb;">
                        <span style="font-weight: 600; color: #1a1a1a;">${date}</span>
                        <span style="font-weight: 700; color: ${dayTotal >= 0 ? '#059669' : '#dc2626'};">¥${dayTotal.toFixed(2)}</span>
                    </div>
                    <table style="width: 100%; border-collapse: collapse; font-size: 13px;">
                        <tbody>
                            ${recordRows}
                        </tbody>
                    </table>
                </div>
            `;
        }).join('');

        return `
            <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif; color: #1a1a1a; line-height: 1.6;">
                <h1 style="font-size: 22px; font-weight: 700; margin-bottom: 8px; color: #1a1a1a; border-bottom: 2px solid #3b82f6; padding-bottom: 10px;">${appName} - 账单报告</h1>
                <p style="color: #6b7280; font-size: 13px; margin-bottom: 4px;">时间范围: ${this.dateRange.label} (${this.dateRange.start} 至 ${this.dateRange.end})</p>
                <p style="color: #6b7280; font-size: 13px; margin-bottom: 16px;">导出时间: ${formatLocalDate(new Date())} ${new Date().toLocaleTimeString('zh-CN')}</p>
                
                <div style="display: flex; gap: 12px; margin: 16px 0;">
                    <div style="flex: 1; padding: 14px; border-radius: 6px; text-align: center; background: #f0fdf4; border: 1px solid #bbf7d0;">
                        <div style="font-size: 11px; color: #6b7280; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 4px;">总收入</div>
                        <div style="font-size: 18px; font-weight: 700; color: #059669;">¥${totalIncome.toFixed(2)}</div>
                    </div>
                    <div style="flex: 1; padding: 14px; border-radius: 6px; text-align: center; background: #fef3c7; border: 1px solid #fcd34d;">
                        <div style="font-size: 11px; color: #6b7280; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 4px;">总支出</div>
                        <div style="font-size: 18px; font-weight: 700; color: #dc2626;">¥${totalExpense.toFixed(2)}</div>
                    </div>
                    <div style="flex: 1; padding: 14px; border-radius: 6px; text-align: center; background: ${balance >= 0 ? '#ecfdf5' : '#fef2f2'}; border: 1px solid ${balance >= 0 ? '#86efac' : '#fca5a5'};">
                        <div style="font-size: 11px; color: #6b7280; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 4px;">结余</div>
                        <div style="font-size: 18px; font-weight: 700; color: ${balance >= 0 ? '#059669' : '#dc2626'};">¥${balance.toFixed(2)}</div>
                    </div>
                </div>
                
                ${categoryStatsHTML}
                
                <div style="margin: 20px 0;">
                    <h2 style="font-size: 16px; font-weight: 600; margin-bottom: 12px; color: #374151;">详细记录 (共 ${this.records.length} 笔)</h2>
                    ${recordsHTML}
                </div>
            </div>
        `;
    }

}

// 快速记账模态框
class QuickEntryModal extends Modal {
    plugin: any;
    onSave: () => Promise<void>;
    selectedCategory: string | null;
    amount: string;
    description: string;
    amountInput: HTMLInputElement;
    
    constructor(app: any, plugin: any, onSave: () => Promise<void>) {
        super(app);
        this.plugin = plugin;
        this.onSave = onSave;
        this.selectedCategory = null;
        this.amount = '';
        this.description = '';
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass('quick-entry-modal');

        this.titleEl.setText('快速记账');

        // 分类选择
        const categorySection = contentEl.createDiv('entry-section');
        categorySection.createEl('label', { text: '选择分类', cls: 'entry-label' });
        
        const categoryGrid = categorySection.createDiv('category-grid');
        
        // 获取默认分类
        const defaultCategory = this.plugin.config.defaultCategory || 'cy';
        
        // 创建分类按钮
        Object.entries(this.plugin.config.categories).forEach(([keyword, categoryName]) => {
            const isIncome = keyword === 'sr';
            const btn = categoryGrid.createEl('button', {
                text: categoryName,
                cls: `category-btn ${isIncome ? 'income-btn' : 'expense-btn'}`
            });
            btn.setAttribute('data-keyword', keyword);
            btn.onclick = () => this.selectCategory(keyword, btn);
            
            // 自动选中默认分类
            if (keyword === defaultCategory) {
                btn.classList.add('selected');
                this.selectedCategory = keyword;
            }
        });

        // 金额和备注输入（合并为一个输入框）
        const amountSection = contentEl.createDiv('entry-section');
        const label = amountSection.createEl('label', { text: '金额和备注', cls: 'entry-label' });
        
        // 根据设备类型显示不同提示
        const isMobile = window.innerWidth <= 600;
        const hintText = isMobile 
            ? '（格式：50 午餐，回车保存）'
            : '（格式：金额 备注，如：50 午餐）';
        
        label.createEl('span', { 
            text: hintText,
            cls: 'entry-hint'
        });
        
        this.amountInput = amountSection.createEl('input', {
            type: 'text',
            cls: 'entry-input entry-input-combined',
            attr: { 
                placeholder: '例如：50 午餐 或 50',
                maxlength: '100',
                inputmode: 'text' // 优化移动端输入法
            }
        });

        // 按钮组（放在输入框后面，但在移动端会通过CSS调整顺序）
        const buttons = contentEl.createDiv('entry-buttons');
        
        const saveBtn = buttons.createEl('button', {
            text: '保存',
            cls: 'entry-btn entry-btn-save'
        });
        saveBtn.onclick = () => this.saveEntry();
        
        const cancelBtn = buttons.createEl('button', {
            text: '取消',
            cls: 'entry-btn entry-btn-cancel'
        });
        cancelBtn.onclick = () => this.close();

        // 回车保存
        this.amountInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                this.saveEntry();
            }
        });
        
        // 延迟聚焦，避免立即弹出输入法
        setTimeout(() => {
            this.amountInput.focus();
        }, 100);
    }

    selectCategory(keyword: string, buttonEl: HTMLElement) {
        // 清除其他按钮的选中状态
        document.querySelectorAll('.category-btn').forEach(btn => {
            btn.classList.remove('selected');
        });
        
        // 选中当前按钮
        buttonEl.classList.add('selected');
        this.selectedCategory = keyword;
    }

    async saveEntry() {
        // 验证输入
        if (!this.selectedCategory) {
            new Notice('请选择分类');
            return;
        }

        // 解析输入：支持 "金额 备注" 或 "金额" 格式
        const input = this.amountInput.value.trim();
        if (!input) {
            new Notice('请输入金额');
            return;
        }

        // 使用正则表达式解析：数字（可能带小数点）+ 可选的空格和备注
        const match = input.match(/^([\d.]+)\s*(.*)$/);
        if (!match) {
            new Notice('请输入有效的金额格式，例如：50 午餐');
            return;
        }

        const amount = parseFloat(match[1]);
        const description = match[2].trim();

        if (!amount || amount <= 0) {
            new Notice('请输入有效金额');
            return;
        }

        try {
            // 获取今天的日记文件路径
            const today = new Date();
            const dateStr = formatLocalDate(today);
            const journalPath = `${this.plugin.config.journalsPath}/${dateStr}.md`;
            
            // 构建记账记录（不带换行符，添加列表符号）
            const emoji = this.plugin.config.expenseEmoji;
            const record = `- ${emoji}${this.selectedCategory} ${amount}${description ? ' ' + description : ''}`;
            
            // 检查文件是否存在
            const file = this.app.vault.getAbstractFileByPath(journalPath);
            
            if (file instanceof TFile) {
                // 文件存在，智能追加内容
                let content = await this.app.vault.read(file);
                
                // 移除末尾的空行或仅含 "-" 的占位行
                const lines = content.split('\n');
                while (lines.length > 0 && (lines[lines.length - 1].trim() === '' || lines[lines.length - 1].trim() === '-')) {
                    lines.pop();
                }
                
                // 重新组合内容
                let newContent = lines.join('\n');
                
                // 如果文件非空，添加一个换行符再追加新记录
                if (newContent.length > 0) {
                    newContent += '\n' + record;
                } else {
                    // 文件为空，直接写入记录
                    newContent = record;
                }
                
                await this.app.vault.modify(file, newContent);
            } else {
                // 文件不存在，创建新文件（不带末尾换行）
                await this.app.vault.create(journalPath, record);
            }

            new Notice('记账成功');
            this.close();
            
            // 调用保存后的回调
            if (this.onSave) {
                await this.onSave();
            }
        } catch (error) {
            console.error('保存记账记录失败:', error);
            new Notice('保存失败，请检查日记文件夹');
        }
    }
}

// 快速记账模态框（复制历史记录）
class QuickCopyModal extends Modal {
    plugin: any;
    records: AccountingRecord[];
    filteredRecords: AccountingRecord[];
    searchInput: HTMLInputElement;
    recordsContainer: HTMLElement;
    selectedCategory: string;
    onSave: () => Promise<void>;

    constructor(app: any, plugin: any, records: AccountingRecord[], onSave: () => Promise<void>) {
        super(app);
        this.plugin = plugin;
        this.records = records;
        this.filteredRecords = records;
        this.selectedCategory = '';
        this.onSave = onSave;
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass('quick-copy-modal');

        this.titleEl.setText('📋 快速记账');

        // 搜索和筛选区域
        const filterSection = contentEl.createDiv('quick-copy-filter');

        // 搜索框
        this.searchInput = filterSection.createEl('input', {
            type: 'text',
            cls: 'quick-copy-search',
            attr: { placeholder: '搜索记录...' }
        });
        this.searchInput.addEventListener('input', () => this.filterRecords());

        // 分类筛选
        const categorySelect = filterSection.createEl('select', { cls: 'quick-copy-category-select' });
        categorySelect.createEl('option', { text: '全部分类', value: '' });
        Object.entries(this.plugin.config.categories).forEach(([keyword, categoryName]) => {
            categorySelect.createEl('option', { text: categoryName, value: keyword });
        });
        categorySelect.addEventListener('change', () => {
            this.selectedCategory = categorySelect.value;
            this.filterRecords();
        });

        // 记录列表容器
        this.recordsContainer = contentEl.createDiv('quick-copy-records');
        this.renderRecords();

        // 底部提示
        const footer = contentEl.createDiv('quick-copy-footer');
        footer.createEl('span', { text: `共 ${this.records.length} 条记录`, cls: 'quick-copy-count' });
    }

    filterRecords() {
        const searchText = this.searchInput.value.toLowerCase().trim();

        this.filteredRecords = this.records.filter(record => {
            const matchSearch = !searchText ||
                record.description.toLowerCase().includes(searchText) ||
                record.category.toLowerCase().includes(searchText) ||
                record.keyword.toLowerCase().includes(searchText);

            const matchCategory = !this.selectedCategory ||
                record.keyword === this.selectedCategory;

            return matchSearch && matchCategory;
        });

        this.renderRecords();
    }

    renderRecords() {
        this.recordsContainer.empty();

        if (this.filteredRecords.length === 0) {
            this.recordsContainer.createDiv({ text: '暂无匹配记录', cls: 'quick-copy-empty' });
            return;
        }

        this.filteredRecords.forEach(record => {
            const recordItem = this.recordsContainer.createDiv('quick-copy-item');

            // 记录信息
            const recordInfo = recordItem.createDiv('quick-copy-info');
            const categoryColor = this.getCategoryColor(record.category);
            recordInfo.createEl('span', {
                text: record.category,
                cls: 'quick-copy-category',
                attr: { style: `background-color: ${categoryColor}20; color: ${categoryColor}` }
            });
            recordInfo.createEl('span', {
                text: `¥${record.amount}`,
                cls: 'quick-copy-amount'
            });
            recordInfo.createEl('span', {
                text: record.description || '-',
                cls: 'quick-copy-desc'
            });

            // 操作按钮
            const actions = recordItem.createDiv('quick-copy-actions');

            const copyBtn = actions.createEl('button', {
                text: '复制',
                cls: 'quick-copy-btn'
            });
            copyBtn.onclick = () => this.copyRecord(record);

            const editBtn = actions.createEl('button', {
                text: '编辑',
                cls: 'quick-copy-btn quick-copy-btn-edit'
            });
            editBtn.onclick = () => this.editAndCopyRecord(record);
        });
    }

    getCategoryColor(category: string): string {
        const colors: Record<string, string> = {
            '餐饮': '#dc3545',
            '交通': '#007bff',
            '娱乐': '#6f42c1',
            '购物': '#fd7e14',
            '医疗': '#20c997',
            '教育': '#198754',
            '房租': '#6c757d',
            '其他': '#495057',
            '收入': '#28a745',
            '投资': '#17a2b8',
            '礼物': '#e83e8c',
            '旅游': '#ffc107',
            '运动': '#fd7e14',
            '贷款': '#6c757d',
            '生活缴费': '#17a2b8'
        };
        return colors[category] || '#6c757d';
    }

    async copyRecord(record: AccountingRecord) {
        const emoji = this.plugin.config.expenseEmoji;
        const recordLine = `- ${emoji}${record.keyword} ${record.amount}${record.description ? ' ' + record.description : ''}`;

        try {
            await this.appendRecordToJournal(recordLine);
            new Notice('复制成功');
            this.close();

            // 跳转到今天的日记
            await this.openJournalFileIfNotOpen(formatLocalDate(new Date()));

            if (this.onSave) {
                await this.onSave();
            }
        } catch (error) {
            console.error('复制记录失败:', error);
            new Notice('复制失败');
        }
    }

    editAndCopyRecord(record: AccountingRecord) {
        new EditCopyModal(this.app, this.plugin, record, async () => {
            this.close();
            await this.openJournalFileIfNotOpen(formatLocalDate(new Date()));
            if (this.onSave) {
                await this.onSave();
            }
        }).open();
    }

    async appendRecordToJournal(recordLine: string) {
        const today = formatLocalDate(new Date());
        const journalPath = `${this.plugin.config.journalsPath}/${today}.md`;
        const file = this.app.vault.getAbstractFileByPath(journalPath);

        if (file instanceof TFile) {
            let content = await this.app.vault.read(file);
            const lines = content.split('\n');

            // 移除末尾的空行或仅含 "-" 的占位行
            while (lines.length > 0 && (lines[lines.length - 1].trim() === '' || lines[lines.length - 1].trim() === '-')) {
                lines.pop();
            }

            let newContent = lines.join('\n');
            if (newContent.length > 0) {
                newContent += '\n' + recordLine;
            } else {
                newContent = recordLine;
            }

            await this.app.vault.modify(file, newContent);
        } else {
            await this.app.vault.create(journalPath, recordLine);
        }
    }

    async openJournalFileIfNotOpen(date: string) {
        const filePath = `${this.plugin.config.journalsPath}/${date}.md`;
        const file = this.app.vault.getAbstractFileByPath(filePath);

        if (!(file instanceof TFile)) {
            new Notice('日记文件不存在');
            return;
        }

        // 检查是否已经打开
        const leaves = this.app.workspace.getLeavesOfType('markdown');
        const existingLeaf = leaves.find(leaf =>
            leaf.view?.file?.path === filePath
        );

        if (existingLeaf) {
            // 已打开 → 聚焦到该 tab
            this.app.workspace.setActiveLeaf(existingLeaf);
        } else {
            // 未打开 → 新打开
            const leaf = this.app.workspace.getLeaf();
            await leaf.openFile(file);
        }
    }
}

// 编辑后复制模态框
class EditCopyModal extends Modal {
    plugin: any;
    record: AccountingRecord;
    amountInput: HTMLInputElement;
    descInput: HTMLInputElement;
    onSave: () => Promise<void>;

    constructor(app: any, plugin: any, record: AccountingRecord, onSave: () => Promise<void>) {
        super(app);
        this.plugin = plugin;
        this.record = record;
        this.onSave = onSave;
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass('edit-copy-modal');

        this.titleEl.setText('编辑后复制');

        // 分类显示
        const categorySection = contentEl.createDiv('edit-copy-section');
        categorySection.createEl('label', { text: '分类', cls: 'edit-copy-label' });
        categorySection.createEl('span', {
            text: this.record.category,
            cls: 'edit-copy-category-display'
        });

        // 金额输入
        const amountSection = contentEl.createDiv('edit-copy-section');
        amountSection.createEl('label', { text: '金额', cls: 'edit-copy-label' });
        this.amountInput = amountSection.createEl('input', {
            type: 'number',
            cls: 'edit-copy-input',
            attr: {
                value: this.record.amount,
                step: '0.01',
                min: '0'
            }
        });

        // 描述输入
        const descSection = contentEl.createDiv('edit-copy-section');
        descSection.createEl('label', { text: '描述', cls: 'edit-copy-label' });
        this.descInput = descSection.createEl('input', {
            type: 'text',
            cls: 'edit-copy-input',
            attr: {
                value: this.record.description,
                placeholder: '输入描述...'
            }
        });

        // 按钮
        const buttons = contentEl.createDiv('edit-copy-buttons');
        const saveBtn = buttons.createEl('button', {
            text: '复制',
            cls: 'edit-copy-btn edit-copy-btn-save'
        });
        saveBtn.onclick = () => this.saveAndCopy();

        const cancelBtn = buttons.createEl('button', {
            text: '取消',
            cls: 'edit-copy-btn edit-copy-btn-cancel'
        });
        cancelBtn.onclick = () => this.close();

        // 回车保存
        this.amountInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') this.saveAndCopy();
        });
        this.descInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') this.saveAndCopy();
        });

        setTimeout(() => this.amountInput.focus(), 100);
    }

    async saveAndCopy() {
        const amount = parseFloat(this.amountInput.value);
        const description = this.descInput.value.trim();

        if (!amount || amount <= 0) {
            new Notice('请输入有效金额');
            return;
        }

        const emoji = this.plugin.config.expenseEmoji;
        const recordLine = `- ${emoji}${this.record.keyword} ${amount}${description ? ' ' + description : ''}`;

        try {
            await this.appendRecordToJournal(recordLine);
            new Notice('复制成功');
            this.close();

            if (this.onSave) {
                await this.onSave();
            }
        } catch (error) {
            console.error('复制记录失败:', error);
            new Notice('复制失败');
        }
    }

    async appendRecordToJournal(recordLine: string) {
        const today = formatLocalDate(new Date());
        const journalPath = `${this.plugin.config.journalsPath}/${today}.md`;
        const file = this.app.vault.getAbstractFileByPath(journalPath);

        if (file instanceof TFile) {
            let content = await this.app.vault.read(file);
            const lines = content.split('\n');

            while (lines.length > 0 && (lines[lines.length - 1].trim() === '' || lines[lines.length - 1].trim() === '-')) {
                lines.pop();
            }

            let newContent = lines.join('\n');
            if (newContent.length > 0) {
                newContent += '\n' + recordLine;
            } else {
                newContent = recordLine;
            }

            await this.app.vault.modify(file, newContent);
        } else {
            await this.app.vault.create(journalPath, recordLine);
        }
    }
}

// 记账视图
const ACCOUNTING_VIEW = 'accounting-view';

class AccountingView extends ItemView {
    plugin: any;
    currentRecords: AccountingRecord[];
    currentStats: AccountingStats;
    filteredRecords: AccountingRecord[];
    currentDateRange: { start: string; end: string; label: string };
    statsContainer: HTMLElement;
    recordsContainer: HTMLElement;
    timeDisplay: HTMLElement;
    
    constructor(leaf: any, plugin: any) {
        super(leaf);
        this.plugin = plugin;
        this.currentRecords = [];
        this.currentStats = null;
        this.filteredRecords = [];
        this.currentDateRange = { start: '', end: '', label: '本月' };
    }

    getViewType() {
        return ACCOUNTING_VIEW;
    }

    getDisplayText() {
        return this.plugin.config.appName || '每日记账';
    }

    getIcon() {
        return 'calculator';
    }

    async onOpen() {
        await this.render();
    }

    async onClose() {
        // 清理资源
    }

    async render() {
        const container = this.containerEl.children[1];
        container.empty();
        container.addClass('accounting-view');

        this.renderHeader(container);
        this.renderFilters(container);
        this.renderStats(container);
        this.renderRecordsList(container);
        
        // 初始加载数据
        await this.loadAllRecords();
    }

    renderHeader(container) {
        const header = container.createDiv('accounting-header');

        // 使用配置的应用名称
        const appName = this.plugin.config.appName || '每日记账';
        header.createEl('h2', { text: `💰 ${appName}`, cls: 'accounting-title' });

        const actions = header.createDiv('accounting-actions');

        const quickEntryBtn = actions.createEl('button', {
            text: '快速记账',
            cls: 'accounting-btn accounting-btn-primary'
        });
        quickEntryBtn.onclick = () => this.showQuickEntryModal();

        // 快速复制按钮（根据配置显示）
        if (this.plugin.config.enableQuickCopy !== false) {
            const quickCopyBtn = actions.createEl('button', {
                text: '快速复制',
                cls: 'accounting-btn accounting-btn-primary'
            });
            quickCopyBtn.onclick = () => this.showQuickCopyModal();
        }

        const refreshBtn = actions.createEl('button', {
            text: '刷新数据',
            cls: 'accounting-btn'
        });
        refreshBtn.onclick = () => this.loadAllRecords(true); // 强制刷新

        const exportPDFBtn = actions.createEl('button', {
            text: '导出 PDF',
            cls: 'accounting-btn'
        });
        exportPDFBtn.onclick = () => this.showExportPDFModal();

        const exportMDBtn = actions.createEl('button', {
            text: '导出 MD',
            cls: 'accounting-btn'
        });
        exportMDBtn.onclick = () => this.exportToMarkdown();

        const configBtn = actions.createEl('button', {
            text: '配置分类',
            cls: 'accounting-btn'
        });
        configBtn.onclick = () => this.showConfigModal();
    }

    renderFilters(container) {
        const filters = container.createDiv('accounting-filters');
        
        // 时间筛选区域
        const timeSection = filters.createDiv('filter-section');
        timeSection.createEl('label', { text: '时间筛选:', cls: 'filter-label' });
        
        // 快速时间按钮组
        const quickButtons = timeSection.createDiv('quick-time-buttons');
        
        const timeRanges = [
            { label: '本周', key: 'thisWeek' },
            { label: '上周', key: 'lastWeek' },
            { label: '本月', key: 'thisMonth' },
            { label: '上月', key: 'lastMonth' },
            { label: '自定义', key: 'custom' }
        ];
        
        timeRanges.forEach(range => {
            const btn = quickButtons.createEl('button', {
                text: range.label,
                cls: 'quick-time-btn'
            });
            btn.setAttribute('data-range', range.key);
            btn.onclick = () => this.applyTimeRange(range.key, btn);
        });
        
        // 当前时间范围显示
        this.timeDisplay = timeSection.createDiv('current-time-display');
        this.timeDisplay.style.display = 'none';
        
        // 清除筛选按钮
        const clearBtn = timeSection.createEl('button', {
            text: '重置为本月',
            cls: 'clear-filter-btn'
        });
        clearBtn.onclick = () => this.resetToThisMonth();
    }
    
    // 应用时间范围筛选
    applyTimeRange(rangeKey, buttonEl) {
        console.log(`🔍 应用时间范围筛选: ${rangeKey}`);
        
        const now = new Date();
        let startDate, endDate, displayText;
        
        switch (rangeKey) {
            case 'thisWeek':
                startDate = this.getWeekStart(now);
                endDate = this.getWeekEnd(now);
                displayText = '本周';
                break;
                
            case 'lastWeek':
                const lastWeek = new Date(now);
                lastWeek.setDate(lastWeek.getDate() - 7);
                startDate = this.getWeekStart(lastWeek);
                endDate = this.getWeekEnd(lastWeek);
                displayText = '上周';
                break;
                
            case 'thisMonth':
                startDate = new Date(now.getFullYear(), now.getMonth(), 1);
                endDate = new Date(now.getFullYear(), now.getMonth() + 1, 0);
                displayText = '本月';
                break;
                
            case 'lastMonth':
                startDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
                endDate = new Date(now.getFullYear(), now.getMonth(), 0);
                displayText = '上月';
                break;
                
            case 'custom':
                this.showDateRangePicker();
                return;
        }
        
        // 格式化日期
        const startStr = this.formatDate(startDate);
        const endStr = this.formatDate(endDate);
        
        console.log(`📅 筛选日期范围: ${startStr} 至 ${endStr}`);
        console.log(`📊 筛选前记录数: ${this.currentRecords.length}`);
        
        // 应用筛选
        const filteredRecords = this.plugin.storage.filterRecordsByDateRange(
            this.currentRecords, startStr, endStr
        );
        
        console.log(`📊 筛选后记录数: ${filteredRecords.length}`);
        
        // 保存筛选后的记录和日期范围
        this.filteredRecords = filteredRecords;
        this.currentDateRange = { start: startStr, end: endStr, label: displayText };
        
        this.currentStats = this.plugin.storage.calculateStatistics(filteredRecords);
        
        // 更新显示
        this.timeDisplay.textContent = `${displayText} (${startStr} 至 ${endStr})`;
        this.timeDisplay.style.display = 'block';
        
        // 更新按钮状态
        document.querySelectorAll('.quick-time-btn').forEach(btn => btn.classList.remove('active'));
        buttonEl.classList.add('active');
        
        this.updateStatsDisplay();
        this.updateRecordsDisplay(filteredRecords);
        
        console.log(`✅ 时间筛选完成`);
    }
    
    // 重置为本月
    resetToThisMonth() {
        // 清除所有按钮状态
        document.querySelectorAll('.quick-time-btn').forEach(btn => btn.classList.remove('active'));
        
        // 应用本月筛选
        const thisMonthBtn = document.querySelector('.quick-time-btn[data-range="thisMonth"]');
        if (thisMonthBtn) {
            this.applyTimeRange('thisMonth', thisMonthBtn);
        } else {
            // 如果找不到按钮，直接应用本月筛选
            this.applyDefaultTimeRange();
        }
    }
    
    // 清除时间筛选（显示全部数据）
    clearTimeFilter() {
        this.currentStats = this.plugin.storage.calculateStatistics(this.currentRecords);
        this.timeDisplay.style.display = 'none';
        
        // 清除按钮状态
        document.querySelectorAll('.quick-time-btn').forEach(btn => btn.classList.remove('active'));
        
        this.updateStatsDisplay();
        this.updateRecordsDisplay();
    }
    
    // 获取周开始日期（周一）
    getWeekStart(date) {
        const d = new Date(date);
        const day = d.getDay();
        const diff = d.getDate() - day + (day === 0 ? -6 : 1); // 周一为一周开始
        return new Date(d.setDate(diff));
    }
    
    // 获取周结束日期（周日）
    getWeekEnd(date) {
        const d = new Date(date);
        const day = d.getDay();
        const diff = d.getDate() - day + (day === 0 ? 0 : 7); // 周日为一周结束
        return new Date(d.setDate(diff));
    }
    
    // 格式化日期为 YYYY-MM-DD（使用本地时区）
    formatDate(date: Date): string {
        return formatLocalDate(date);
    }

    renderStats(container) {
        this.statsContainer = container.createDiv('accounting-stats');
        this.updateStatsDisplay();
    }

    renderRecordsList(container) {
        this.recordsContainer = container.createDiv('accounting-records');
        this.updateRecordsDisplay();
    }

    async loadAllRecords(forceRefresh = false): Promise<void> {
        try {
            this.currentRecords = await this.plugin.storage.getAllRecords(forceRefresh);
            this.currentStats = this.plugin.storage.calculateStatistics(this.currentRecords);
            
            // 默认显示本月数据
            this.applyDefaultTimeRange();
        } catch (error) {
            console.error('加载记账记录失败:', error);
            new Notice('加载记账记录失败');
        }
    }
    
    // 应用默认时间范围（本月）
    applyDefaultTimeRange() {
        const now = new Date();
        const startDate = new Date(now.getFullYear(), now.getMonth(), 1);
        const endDate = new Date(now.getFullYear(), now.getMonth() + 1, 0);
        
        const startStr = this.formatDate(startDate);
        const endStr = this.formatDate(endDate);
        
        // 筛选本月数据
        const filteredRecords = this.plugin.storage.filterRecordsByDateRange(
            this.currentRecords, startStr, endStr
        );
        
        // 保存筛选后的记录和日期范围
        this.filteredRecords = filteredRecords;
        this.currentDateRange = { start: startStr, end: endStr, label: '本月' };
        
        this.currentStats = this.plugin.storage.calculateStatistics(filteredRecords);
        
        // 更新显示
        this.timeDisplay.textContent = `本月 (${startStr} 至 ${endStr})`;
        this.timeDisplay.style.display = 'block';
        
        // 设置本月按钮为激活状态
        setTimeout(() => {
            const thisMonthBtn = document.querySelector('.quick-time-btn[data-range="thisMonth"]');
            if (thisMonthBtn) {
                thisMonthBtn.classList.add('active');
            }
        }, 100);
        
        this.updateStatsDisplay();
        this.updateRecordsDisplay(filteredRecords);
    }

    showDateRangePicker() {
        new DateRangeModal(this.app, {
            onSelect: (startDate, endDate) => {
                const filteredRecords = this.plugin.storage.filterRecordsByDateRange(
                    this.currentRecords, startDate, endDate
                );
                
                // 保存筛选后的记录和日期范围
                this.filteredRecords = filteredRecords;
                this.currentDateRange = { start: startDate, end: endDate, label: '自定义' };
                
                this.currentStats = this.plugin.storage.calculateStatistics(filteredRecords);
                
                // 更新时间显示
                this.timeDisplay.textContent = `自定义 (${startDate} 至 ${endDate})`;
                this.timeDisplay.style.display = 'block';
                
                // 清除所有按钮的激活状态
                document.querySelectorAll('.quick-time-btn').forEach(btn => btn.classList.remove('active'));
                
                this.updateStatsDisplay();
                this.updateRecordsDisplay(filteredRecords);
            }
        }).open();
    }

    // 获取分类颜色
    getCategoryColor(category) {
        const colors = {
            '餐饮': '#dc3545',    // 红色
            '交通': '#007bff',    // 蓝色
            '娱乐': '#6f42c1',    // 紫色
            '购物': '#fd7e14',    // 橙色
            '医疗': '#20c997',    // 青色
            '教育': '#198754',    // 绿色
            '房租': '#6c757d',    // 灰色
            '其他': '#495057',    // 深灰色
            '收入': '#28a745',    // 成功绿色
            '投资': '#17a2b8',    // 信息蓝色
            '礼物': '#e83e8c',    // 粉色
            '旅游': '#ffc107',    // 警告黄色
            '运动': '#fd7e14'     // 橙色
        };
        return colors[category] || '#6c757d'; // 默认灰色
    }

    updateStatsDisplay() {
        if (!this.statsContainer) return;
        
        this.statsContainer.empty();
        
        if (!this.currentStats) {
            this.statsContainer.createDiv({ text: '暂无数据', cls: 'no-data' });
            return;
        }

        const { totalIncome, totalExpense, categoryStats, budgetStatus } = this.currentStats;
        const balance = totalIncome - totalExpense;

        // 预算告警（如果有）
        if (budgetStatus && budgetStatus.alerts.length > 0) {
            this.renderBudgetAlerts(budgetStatus.alerts);
        }

        // 总览统计
        const overview = this.statsContainer.createDiv('stats-overview');
        
        const incomeCard = overview.createDiv('stat-card income');
        incomeCard.createDiv({ text: '总收入', cls: 'stat-label' });
        incomeCard.createDiv({ text: `¥${totalIncome.toFixed(2)}`, cls: 'stat-value' });

        const expenseCard = overview.createDiv('stat-card expense');
        expenseCard.createDiv({ text: '总支出', cls: 'stat-label' });
        expenseCard.createDiv({ text: `¥${totalExpense.toFixed(2)}`, cls: 'stat-value' });

        const balanceCard = overview.createDiv(`stat-card balance ${balance >= 0 ? 'positive' : 'negative'}`);
        balanceCard.createDiv({ text: '结余', cls: 'stat-label' });
        balanceCard.createDiv({ text: `¥${balance.toFixed(2)}`, cls: 'stat-value' });

        // 预算状态卡片
        if (budgetStatus && budgetStatus.totalBudget > 0) {
            const budgetCard = overview.createDiv('stat-card budget');
            budgetCard.createDiv({ text: '预算状态', cls: 'stat-label' });
            const remaining = budgetStatus.totalRemaining;
            const progressPercent = (budgetStatus.totalProgress * 100).toFixed(0);
            budgetCard.createDiv({ 
                text: remaining >= 0 ? `剩余 ¥${remaining.toFixed(2)}` : `超支 ¥${Math.abs(remaining).toFixed(2)}`,
                cls: `stat-value ${remaining >= 0 ? 'positive' : 'negative'}`
            });
            budgetCard.createDiv({ text: `已用 ${progressPercent}%`, cls: 'stat-progress' });
        }

        // 分类统计
        if (Object.keys(categoryStats).length > 0) {
            const categorySection = this.statsContainer.createDiv('category-stats');
            categorySection.createEl('h3', { text: '分类统计' });
            
            const categoryList = categorySection.createDiv('category-list');
            
            Object.entries(categoryStats)
                .sort(([,a], [,b]) => b.total - a.total)
                .forEach(([category, data]) => {
                    const item = categoryList.createDiv('category-item');
                    
                    const info = item.createDiv('category-info');
                    
                    // 创建彩色标签
                    const categoryLabel = info.createDiv('category-label');
                    const color = this.getCategoryColor(category);
                    categoryLabel.style.backgroundColor = color;
                    categoryLabel.style.color = '#ffffff';
                    categoryLabel.textContent = category;
                    
                    const amountInfo = info.createDiv('category-amount-info');
                    amountInfo.createDiv({ text: `¥${data.total.toFixed(2)}`, cls: 'category-amount' });
                    amountInfo.createDiv({ text: `${data.count}笔`, cls: 'category-count' });
                    
                    // 预算进度条（如果有预算设置）
                    if (budgetStatus && budgetStatus.categories[category]) {
                        const budgetInfo = budgetStatus.categories[category];
                        const progressBar = item.createDiv('budget-progress');
                        const progressFill = progressBar.createDiv('budget-progress-fill');
                        const progressPercent = Math.min(budgetInfo.progress * 100, 100);
                        progressFill.style.width = `${progressPercent}%`;
                        
                        // 根据进度设置颜色
                        if (budgetInfo.progress >= 1) {
                            progressFill.classList.add('exceeded');
                        } else if (budgetInfo.progress >= 0.8) {
                            progressFill.classList.add('warning');
                        } else {
                            progressFill.classList.add('normal');
                        }
                        
                        const budgetText = item.createDiv('budget-text');
                        budgetText.textContent = `预算: ¥${budgetInfo.budget} | 剩余: ¥${budgetInfo.remaining.toFixed(2)}`;
                    }
                });
        }
    }
    
    // 渲染预算告警
    renderBudgetAlerts(alerts) {
        const alertsContainer = this.statsContainer.createDiv('budget-alerts');
        
        alerts.forEach(alert => {
            const alertItem = alertsContainer.createDiv(`budget-alert ${alert.type}`);
            const icon = alert.type === 'exceeded' ? '⚠️' : '⚡';
            alertItem.innerHTML = `${icon} ${alert.message}`;
        });
    }

    updateRecordsDisplay(records = this.currentRecords) {
        if (!this.recordsContainer) return;
        
        this.recordsContainer.empty();
        
        if (!records || records.length === 0) {
            this.recordsContainer.createDiv({ text: '暂无记账记录', cls: 'no-records' });
            return;
        }

        const recordsList = this.recordsContainer.createDiv('records-list');
        recordsList.createEl('h3', { text: `记账记录 (${records.length}条)` });

        // 按日期分组
        const groupedRecords = this.groupRecordsByDate(records);
        
        Object.entries(groupedRecords)
            .sort(([a], [b]) => new Date(b) - new Date(a))
            .forEach(([date, dayRecords]) => {
                this.renderDayRecords(recordsList, date, dayRecords);
            });
    }

    groupRecordsByDate(records) {
        const grouped = {};
        records.forEach(record => {
            if (!grouped[record.date]) {
                grouped[record.date] = [];
            }
            grouped[record.date].push(record);
        });
        return grouped;
    }

    // 获取分类颜色
    getCategoryColor(category) {
        const colors = {
            '餐饮': '#dc3545',    // 红色
            '交通': '#007bff',    // 蓝色
            '娱乐': '#6f42c1',    // 紫色
            '购物': '#fd7e14',    // 橙色
            '医疗': '#20c997',    // 青色
            '教育': '#198754',    // 绿色
            '房租': '#6c757d',    // 灰色
            '其他': '#495057',    // 深灰色
            '收入': '#28a745',    // 成功绿色
            '投资': '#17a2b8',    // 信息蓝色
            '礼物': '#e83e8c',    // 粉色
            '旅游': '#ffc107',    // 警告黄色
            '运动': '#fd7e14'     // 橙色
        };
        return colors[category] || '#6c757d'; // 默认灰色
    }

    renderDayRecords(container, date, records) {
        const dayGroup = container.createDiv('day-group');
        
        const dayHeader = dayGroup.createDiv('day-header');
        const dayTotal = records.reduce((sum, r) => sum + (r.isIncome ? r.amount : -r.amount), 0);
        
        const dateSpan = dayHeader.createSpan({ text: this.formatDateDisplay(date), cls: 'day-date clickable' });
        
        // 添加点击事件，打开对应日期的日记
        dateSpan.onclick = async () => {
            await this.openJournalFile(date);
        };
        
        dayHeader.createSpan({ 
            text: `¥${dayTotal.toFixed(2)}`, 
            cls: `day-total ${dayTotal >= 0 ? 'positive' : 'negative'}`
        });

        const recordsList = dayGroup.createDiv('day-records');
        
        records.forEach(record => {
            const recordItem = recordsList.createDiv('record-item');
            
            // 如果是补录记录，添加标记
            if (record.isBackfill) {
                recordItem.classList.add('backfill');
                recordItem.title = `补录记录 (原记录于 ${record.fileDate})`;
            }
            
            const recordInfo = recordItem.createDiv('record-info');
            
            // 创建彩色分类标签
            const categoryLabel = recordInfo.createDiv('record-category-label');
            const color = this.getCategoryColor(record.category);
            categoryLabel.style.backgroundColor = color;
            categoryLabel.style.color = '#ffffff';
            categoryLabel.textContent = record.category;
            
            // 显示描述，如果是补录则高亮日期
            let description = record.description;
            if (record.isBackfill) {
                const dateRegex = /(\d{4}-\d{2}-\d{2})/;
                description = description.replace(dateRegex, '<strong>$1</strong>');
            }
            
            const descDiv = recordInfo.createDiv({ cls: 'record-description' });
            descDiv.innerHTML = description;
            
            const recordAmount = recordItem.createDiv('record-amount');
            const amountText = record.isIncome ? `+¥${record.amount}` : `-¥${record.amount}`;
            recordAmount.createDiv({ 
                text: amountText, 
                cls: `amount ${record.isIncome ? 'income' : 'expense'}`
            });
            
            // 右键菜单
            recordItem.oncontextmenu = (e) => {
                e.preventDefault();
                this.showRecordContextMenu(e, record);
            };
        });
    }

    showRecordContextMenu(event, record) {
        const menu = new Menu();
        
        menu.addItem(item => {
            item.setTitle('查看原文')
                .setIcon('file-text')
                .onClick(() => {
                    this.openJournalFile(record.date);
                });
        });

        menu.showAtMouseEvent(event);
    }

    async openJournalFile(date) {
        const fileName = `${date}.md`;
        const filePath = `${this.plugin.config.journalsPath}/${fileName}`;
        
        const file = this.app.vault.getAbstractFileByPath(filePath);
        if (file instanceof TFile) {
            const leaf = this.app.workspace.getLeaf();
            await leaf.openFile(file);
        } else {
            new Notice(`未找到日记文件: ${filePath}`);
        }
    }

    formatDateDisplay(dateStr) {
        const date = new Date(dateStr);
        const today = new Date();
        const yesterday = new Date(today);
        yesterday.setDate(yesterday.getDate() - 1);
        
        // 使用本地日期格式，避免 UTC 时区问题
        const todayStr = today.getFullYear() + '-' + 
            String(today.getMonth() + 1).padStart(2, '0') + '-' + 
            String(today.getDate()).padStart(2, '0');
        const yesterdayStr = yesterday.getFullYear() + '-' + 
            String(yesterday.getMonth() + 1).padStart(2, '0') + '-' + 
            String(yesterday.getDate()).padStart(2, '0');
        
        if (dateStr === todayStr) {
            return '今天';
        } else if (dateStr === yesterdayStr) {
            return '昨天';
        } else {
            return date.toLocaleDateString('zh-CN', { 
                month: 'long', 
                day: 'numeric',
                weekday: 'short'
            });
        }
    }

    showConfigModal() {
        new CategoryConfigModal(this.app, this.plugin).open();
    }
    
    showQuickEntryModal() {
        new QuickEntryModal(this.app, this.plugin, async () => {
            // 保存后的回调：刷新数据
            await this.loadAllRecords(true);
        }).open();
    }

    showQuickCopyModal() {
        // 获取最近N天的记录（去重）
        const days = this.plugin.config.quickCopyDays || 14;
        const recentRecords = this.getRecentUniqueRecords(days);

        if (recentRecords.length === 0) {
            new Notice('暂无最近记账记录');
            return;
        }

        new QuickCopyModal(this.app, this.plugin, recentRecords, async () => {
            // 保存后的回调：刷新数据
            await this.loadAllRecords(true);
        }).open();
    }

    getRecentUniqueRecords(days: number): AccountingRecord[] {
        const now = new Date();
        const startDate = new Date(now);
        startDate.setDate(startDate.getDate() - days);
        const startStr = formatLocalDate(startDate);

        // 筛选最近N天的记录
        const recentRecords = this.currentRecords.filter(r => r.date >= startStr);

        // 去重：相同关键词+金额+描述只保留一条
        const seen = new Set<string>();
        const uniqueRecords: AccountingRecord[] = [];

        for (const record of recentRecords) {
            const key = `${record.keyword}|${record.amount}|${record.description}`;
            if (!seen.has(key)) {
                seen.add(key);
                uniqueRecords.push(record);
            }
        }

        // 按最近使用时间排序
        uniqueRecords.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

        return uniqueRecords;
    }

    showExportPDFModal() {
        if (this.filteredRecords.length === 0) {
            new Notice('当前时间范围内没有记账记录');
            return;
        }
        
        new ExportPDFModal(
            this.app, 
            this.plugin, 
            this.filteredRecords, 
            this.currentStats, 
            this.currentDateRange
        ).open();
    }

    async exportToMarkdown() {
        if (this.filteredRecords.length === 0) {
            new Notice('当前时间范围内没有记账记录');
            return;
        }

        try {
            const markdown = this.generateMarkdown();
            
            // 生成默认文件名：应用名_时间范围
            const appName = this.plugin.config.appName || '每日记账';
            const fileName = `${appName}_${this.currentDateRange.start}_${this.currentDateRange.end}`;
            
            // 显示导出模态框
            new MarkdownExportModal(this.app, markdown, fileName).open();
        } catch (error) {
            console.error('导出 Markdown 失败:', error);
            new Notice('导出失败，请重试');
        }
    }

    generateMarkdown(): string {
        const appName = this.plugin.config.appName || '每日记账';
        const { totalIncome, totalExpense, categoryStats } = this.currentStats;
        const balance = totalIncome - totalExpense;
        
        let md = '';
        
        // 标题和标签
        md += `# ${appName} - 账单报告\n\n`;
        md += `#每日记账 #账单报告\n\n`;
        md += `时间范围: ${this.currentDateRange.start} 至 ${this.currentDateRange.end} | 总收入: ¥${totalIncome.toFixed(2)} | 总支出: ¥${totalExpense.toFixed(2)} | 结余: ¥${balance.toFixed(2)}\n\n`;
        
        // 分类统计
        if (Object.keys(categoryStats).length > 0) {
            md += `## 分类统计\n\n`;
            md += `| 分类 | 金额 | 笔数 | 占比 |\n`;
            md += `|------|------|------|------|\n`;
            
            const totalForPercentage = totalExpense > 0 ? totalExpense : 1;
            
            Object.entries(categoryStats)
                .sort(([,a], [,b]) => b.total - a.total)
                .forEach(([category, data]) => {
                    const isIncome = data.records.some(r => r.isIncome);
                    const percentage = isIncome ? '-' : `${((data.total / totalForPercentage) * 100).toFixed(1)}%`;
                    md += `| ${category} | ¥${data.total.toFixed(2)} | ${data.count} | ${percentage} |\n`;
                });
            
            md += '\n';
        }
        
        // 详细记录 - 一个大表格
        md += `## 详细记录 (共 ${this.filteredRecords.length} 笔)\n\n`;
        md += `| 日期 | 分类 | 描述 | 金额 |\n`;
        md += `|------|------|------|------|\n`;
        
        // 按日期排序（最新的在前）
        const sortedRecords = [...this.filteredRecords].sort((a, b) => 
            new Date(b.date).getTime() - new Date(a.date).getTime()
        );
        
        sortedRecords.forEach(record => {
            const amount = record.isIncome ? `+${record.amount.toFixed(2)}` : `-${record.amount.toFixed(2)}`;
            const desc = record.description || '-';
            md += `| ${record.date} | ${record.category} | ${desc} | ${amount} |\n`;
        });
        
        return md;
    }
}

// 主插件类
export default class AccountingPlugin extends Plugin {
    config: AccountingConfig;
    storage: AccountingStorage;
    
    async onload() {
        console.log('加载记账管理插件');

        // 加载配置
        await this.loadConfig();
        
        // 初始化存储管理器
        this.storage = new AccountingStorage(this.app, this.config);

        // 监听日记文件变化（Alfred/外部写入等），清除缓存并刷新视图，无需定时轮询
        this.registerEvent(
            this.app.vault.on('modify', (file) => {
                if (file instanceof TFile && this.storage.onFileChange(file)) {
                    this.refreshData();
                }
            })
        );
        this.registerEvent(
            this.app.vault.on('create', (file) => {
                if (file instanceof TFile && this.storage.onFileChange(file)) {
                    this.refreshData();
                }
            })
        );
        this.registerEvent(
            this.app.vault.on('delete', (file) => {
                if (file instanceof TFile && this.storage.onFileChange(file)) {
                    this.refreshData();
                }
            })
        );
        this.registerEvent(
            this.app.metadataCache.on('changed', (file) => {
                if (file instanceof TFile && this.storage.onFileChange(file)) {
                    this.refreshData();
                }
            })
        );

        // 注册视图
        this.registerView(ACCOUNTING_VIEW, (leaf) => new AccountingView(leaf, this));

        // 添加功能区图标
        const appName = this.config.appName || '每日记账';
        this.addRibbonIcon('calculator', appName, () => {
            this.activateView();
        });

        // 快速记账侧边栏图标（根据配置显示）
        if (this.config.enableQuickCopy !== false) {
            this.addRibbonIcon('copy', '快速记账', () => {
                this.openQuickCopy();
            });
        }

        // 添加命令
        this.addCommand({
            id: 'open-accounting',
            name: `打开${appName}`,
            callback: () => this.activateView()
        });

        this.addCommand({
            id: 'refresh-accounting',
            name: '刷新记账数据',
            callback: () => this.refreshData()
        });

        this.addCommand({
            id: 'quick-entry',
            name: '新建记账',
            icon: 'wallet',
            callback: () => this.openQuickEntry()
        });

        // 快速记账命令（根据配置注册）
        if (this.config.enableQuickCopy !== false) {
            this.addCommand({
                id: 'quick-copy',
                name: '快速记账',
                icon: 'copy',
                callback: () => this.openQuickCopy()
            });
        }

        this.addCommand({
            id: 'export-pdf',
            name: '导出账单 PDF',
            icon: 'file-down',
            callback: () => this.exportPDF()
        });

        this.addCommand({
            id: 'export-markdown',
            name: '导出账单 Markdown',
            icon: 'file-text',
            callback: () => this.exportMarkdown()
        });

        // 添加设置页面
        this.addSettingTab(new AccountingSettingTab(this.app, this));
    }

    async onunload() {
        console.log('卸载记账管理插件');
        this.app.workspace.detachLeavesOfType(ACCOUNTING_VIEW);
    }

    async loadConfig() {
        try {
            const configPath = `${this.manifest.dir}/config.json`;
            const adapter = this.app.vault.adapter;
            
            if (await adapter.exists(configPath)) {
                const configContent = await adapter.read(configPath);
                this.config = JSON.parse(configContent);
                // 确保 journalsPath 存在，如果不存在则使用默认值
                if (!this.config.journalsPath || typeof this.config.journalsPath !== 'string') {
                    this.config.journalsPath = 'journals';
                }
                console.log('配置加载成功:', this.config);
            } else {
                console.log('配置文件不存在，使用默认配置');
                this.config = this.getDefaultConfig();
            }
        } catch (error) {
            console.error('加载配置失败:', error);
            this.config = this.getDefaultConfig();
        }
    }

    async saveConfig() {
        try {
            const configPath = `${this.manifest.dir}/config.json`;
            const adapter = this.app.vault.adapter;
            const configContent = JSON.stringify(this.config, null, 4);
            await adapter.write(configPath, configContent);
            // 清除缓存，重新加载数据
            if (this.storage) {
                this.storage.clearCache();
            }
            console.log('配置保存成功');
        } catch (error) {
            console.error('保存配置失败:', error);
            new Notice('保存配置失败');
        }
    }

    getDefaultConfig() {
        return {
            appName: "每日记账",
            categories: {
                "cy": "餐饮",
                "gw": "购物",
                "dk": "贷款",
                "jf": "生活缴费",
                "qt": "其他"
            },
            defaultCategory: "cy", // 默认分类为餐饮
            expenseEmoji: "#",
            journalsPath: "journals",
            enableQuickCopy: true, // 默认启用快速记账
            quickCopyDays: 14 // 默认显示最近14天的记录
        };
    }

    async activateView() {
        const { workspace } = this.app;
        
        // 检查是否已经有打开的视图
        let leaf = workspace.getLeavesOfType(ACCOUNTING_VIEW)[0];
        
        if (!leaf) {
            // 创建新的标签页
            leaf = workspace.getLeaf('tab');
            await leaf.setViewState({
                type: ACCOUNTING_VIEW,
                active: true
            });
        }
        
        // 激活视图
        workspace.setActiveLeaf(leaf, { focus: true });
        
        // 强制刷新数据
        if (leaf.view instanceof AccountingView) {
            await leaf.view.loadAllRecords(true);
        }
    }

    async refreshData() {
        const leaves = this.app.workspace.getLeavesOfType(ACCOUNTING_VIEW);
        for (const leaf of leaves) {
            if (leaf.view instanceof AccountingView) {
                await leaf.view.loadAllRecords();
            }
        }
    }

    openQuickEntry() {
        // 打开快速记账模态框
        new QuickEntryModal(this.app, this, async () => {
            // 保存后的回调：刷新所有打开的记账视图
            await this.refreshData();
        }).open();
    }

    async openQuickCopy() {
        // 获取最近N天的记录
        const days = this.config.quickCopyDays || 14;

        // 先加载所有记录
        const allRecords = await this.storage.getAllRecords();

        // 筛选并去重
        const recentRecords = this.getRecentUniqueRecords(allRecords, days);

        if (recentRecords.length === 0) {
            new Notice('暂无最近记账记录');
            return;
        }

        new QuickCopyModal(this.app, this, recentRecords, async () => {
            // 保存后的回调：刷新所有打开的记账视图
            await this.refreshData();
        }).open();
    }

    getRecentUniqueRecords(allRecords: AccountingRecord[], days: number): AccountingRecord[] {
        const now = new Date();
        const startDate = new Date(now);
        startDate.setDate(startDate.getDate() - days);
        const startStr = formatLocalDate(startDate);

        // 筛选最近N天的记录
        const recentRecords = allRecords.filter(r => r.date >= startStr);

        // 去重：相同关键词+金额+描述只保留一条
        const seen = new Set<string>();
        const uniqueRecords: AccountingRecord[] = [];

        for (const record of recentRecords) {
            const key = `${record.keyword}|${record.amount}|${record.description}`;
            if (!seen.has(key)) {
                seen.add(key);
                uniqueRecords.push(record);
            }
        }

        // 按最近使用时间排序
        uniqueRecords.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

        return uniqueRecords;
    }

    async exportPDF() {
        // 先确保视图已打开
        const leaves = this.app.workspace.getLeavesOfType(ACCOUNTING_VIEW);
        if (leaves.length > 0 && leaves[0].view instanceof AccountingView) {
            const view = leaves[0].view as AccountingView;
            view.showExportPDFModal();
        } else {
            // 如果视图未打开，先打开视图再导出
            await this.activateView();
            setTimeout(() => {
                const leaves = this.app.workspace.getLeavesOfType(ACCOUNTING_VIEW);
                if (leaves.length > 0 && leaves[0].view instanceof AccountingView) {
                    const view = leaves[0].view as AccountingView;
                    view.showExportPDFModal();
                }
            }, 500);
        }
    }

    async exportMarkdown() {
        // 先确保视图已打开
        const leaves = this.app.workspace.getLeavesOfType(ACCOUNTING_VIEW);
        if (leaves.length > 0 && leaves[0].view instanceof AccountingView) {
            const view = leaves[0].view as AccountingView;
            await view.exportToMarkdown();
        } else {
            // 如果视图未打开，先打开视图再导出
            await this.activateView();
            setTimeout(async () => {
                const leaves = this.app.workspace.getLeavesOfType(ACCOUNTING_VIEW);
                if (leaves.length > 0 && leaves[0].view instanceof AccountingView) {
                    const view = leaves[0].view as AccountingView;
                    await view.exportToMarkdown();
                }
            }, 500);
        }
    }
}

// 设置页面
class AccountingSettingTab extends PluginSettingTab {
    plugin: AccountingPlugin;

    constructor(app: any, plugin: AccountingPlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display(): void {
        const { containerEl } = this;
        containerEl.empty();

        containerEl.createEl('h2', { text: '记账管理插件设置' });

        new Setting(containerEl)
            .setName('日记文件夹路径')
            .setDesc('日记文件存放的文件夹路径（相对 vault 根目录），默认为 journals')
            .addText(text => text
                .setPlaceholder('journals')
                .setValue(this.plugin.config.journalsPath || 'journals')
                .onChange(async (value) => {
                    const normalizedPath = (value || 'journals').trim().replace(/^\/+/, '').replace(/\/+$/, '');
                    this.plugin.config.journalsPath = normalizedPath || 'journals';
                    await this.plugin.saveConfig();
                    // 清除缓存并刷新视图
                    if (this.plugin.storage) {
                        this.plugin.storage.clearCache();
                        await this.plugin.refreshData();
                    }
                }));

        new Setting(containerEl)
            .setName('启用快速记账')
            .setDesc('在侧边栏显示"快速记账"按钮，记账视图中显示"快速复制"按钮，可快速复制最近N天的记账记录到今天')
            .addToggle(toggle => toggle
                .setValue(this.plugin.config.enableQuickCopy !== false)
                .onChange(async (value) => {
                    this.plugin.config.enableQuickCopy = value;
                    await this.plugin.saveConfig();
                    // 刷新视图
                    await this.plugin.refreshData();
                }));

        new Setting(containerEl)
            .setName('快速记账天数')
            .setDesc('快速记账显示最近N天的记录（默认14天）')
            .addText(text => text
                .setPlaceholder('14')
                .setValue(String(this.plugin.config.quickCopyDays || 14))
                .onChange(async (value) => {
                    const days = parseInt(value) || 14;
                    this.plugin.config.quickCopyDays = Math.max(1, Math.min(365, days));
                    await this.plugin.saveConfig();
                }));

        containerEl.createEl('p', {
            text: '💡 提示：修改后会自动保存并刷新数据。日记文件应存放在此文件夹下，格式为 YYYY-MM-DD.md',
            cls: 'setting-item-description'
        });
    }
}
