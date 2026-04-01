/**
 * 账单解析器测试 — 基于真实 OCR 文字
 * 运行: node test-parser.mjs
 */

// ── 从 main.ts 提取的解析逻辑 ────────────────────────────────────────────────

function findMerchantAbove(lines, amountLineIdx) {
    const skipPatterns = [
        /^\d{1,3}$/,
        /^[45]G$/i,
        /^(完成|支付成功|转账成功|已完成|付款方|收款方|确认付款)/,
        /^[•·…\-\s]+$/,
        /^使用.+支付$/,
        /^交易状态/,
        /^(已转账|已退款|已收款|待确认|已关闭|对方已收款)/,
    ];
    for (let i = amountLineIdx - 1; i >= 0; i--) {
        const line = lines[i];
        if (skipPatterns.some(p => p.test(line))) continue;
        if (/^\d{1,2}:\d{2}/.test(line)) continue;
        return line;
    }
    return '';
}

function extractTime(lines) {
    for (const line of lines) {
        const m = line.match(/(\d{1,2}:\d{2})/);
        if (m) return m[1];
    }
    return '';
}

function findAmountFromEnd(lines) {
    for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i];
        if (line.length > 20) continue;
        const m = line.match(/([\d]+\.[\d]{1,2})\s*$/);
        if (m) {
            const val = parseFloat(m[1]);
            if (val > 0) return { idx: i, amount: val };
        }
    }
    return null;
}

// 微信支付完成页
const wechatBillParser = {
    name: 'wechat_bill',
    detect(lines) {
        return lines.some(l => /^完成$/.test(l) || /^返回商家$/.test(l) || l.includes('支付成功'));
    },
    parse(lines) {
        const result = findAmountFromEnd(lines);
        if (!result) return null;
        const merchant = findMerchantAbove(lines, result.idx);
        if (!merchant) return null;
        return { time: extractTime(lines), merchant, amount: result.amount };
    }
};

// 微信支付账单页
const wechatHistoryParser = {
    name: 'wechat_history',
    detect(lines) {
        return lines.some(l => l.includes('我的账单')) &&
               lines.some(l => l.includes('支付服务'));
    },
    parse(lines) {
        const cutoff = lines.findIndex(l => l.includes('我的账单'));
        const searchLines = cutoff > 0 ? lines.slice(0, cutoff) : lines;
        let amountLineIdx = -1, amount = 0;
        for (let i = searchLines.length - 1; i >= 0; i--) {
            const line = searchLines[i];
            if (line.length > 20) continue;
            const m = line.match(/([\d]+\.[\d]{1,2})\s*$/);
            if (m) {
                const val = parseFloat(m[1]);
                if (val > 0) { amount = val; amountLineIdx = i; break; }
            }
        }
        if (amountLineIdx === -1) return null;
        const skipPatterns = [
            /^使用.+支付$/, /^账单详情/, /^\d{1,3}$/, /^[45]G$/i,
            /^[•·…\-\s]+$/, /^交易状态/,
            /^(已转账|已退款|已收款|待确认|已关闭|对方已收款)/,
        ];
        let merchant = '';
        for (let i = amountLineIdx - 1; i >= 0; i--) {
            const line = searchLines[i];
            if (skipPatterns.some(p => p.test(line))) continue;
            if (/^\d{1,2}:\d{2}/.test(line)) continue;
            merchant = line; break;
        }
        if (!merchant) return null;
        return { time: extractTime(searchLines), merchant, amount };
    }
};

// 支付宝完成页
const alipayBillParser = {
    name: 'alipay',
    detect(lines) {
        return lines.some(l => /^完成$/.test(l)) &&
               lines.some(l => /^付款方式$/.test(l));
    },
    parse(lines) {
        const doneIdx = lines.findIndex(l => /^完成$/.test(l));
        if (doneIdx === -1) return null;
        let amountLineIdx = -1, amount = 0;
        for (let i = doneIdx + 1; i < lines.length; i++) {
            const line = lines[i];
            if (line.length > 20) continue;
            const m = line.match(/([\d]+\.[\d]{1,2})\s*$/);
            if (m) {
                const val = parseFloat(m[1]);
                if (val > 0) { amount = val; amountLineIdx = i; break; }
            }
        }
        if (!amount || amountLineIdx === -1) return null;
        const payMethodIdx = lines.findIndex((l, i) => i > amountLineIdx && /^付款方式$/.test(l));
        let merchant = '';
        if (payMethodIdx > amountLineIdx + 1) {
            for (let i = amountLineIdx + 1; i < payMethodIdx; i++) {
                const line = lines[i];
                if (line && !/^\d{1,3}$/.test(line) && !/^[•·…\-\s]+$/.test(line)) {
                    merchant = line; break;
                }
            }
        }
        if (!merchant) merchant = findMerchantAbove(lines, doneIdx);
        if (!merchant) return null;
        return { time: extractTime(lines), merchant, amount };
    }
};

// 建设银行动账提醒
const ccbNotificationParser = {
    name: 'ccb',
    detect(lines) {
        return lines.some(l => l.includes('动账提醒') || l.includes('变动提醒'));
    },
    parse(lines) {
        let amount = 0;
        const amountLabelIdx = lines.findIndex(l => /^交易金额/.test(l));
        if (amountLabelIdx >= 0) {
            const m = lines[amountLabelIdx].match(/[：:]\s*([\d.]+)/);
            if (m) amount = parseFloat(m[1]);
            else {
                for (let i = amountLabelIdx + 1; i < lines.length; i++) {
                    const m2 = lines[i].match(/^([\d.]+)$/);
                    if (m2) { amount = parseFloat(m2[1]); break; }
                }
            }
        }
        if (!amount) return null;
        let merchant = '';
        const merchantLine = lines.find(l => /^交易对象/.test(l));
        if (merchantLine) {
            const m = merchantLine.match(/[：:]\s*(.+)/);
            if (m) merchant = m[1].replace(/^微信支付[-–—]/, '').replace(/^支付宝[-–—]/, '').trim();
        }
        if (!merchant) return null;
        let time = '';
        const timeLine = lines.find(l => /^交易时间/.test(l));
        if (timeLine) { const m = timeLine.match(/(\d{1,2}:\d{2})/); if (m) time = m[1]; }
        return { time, merchant, amount };
    }
};

// 解析器注册表（按优先级）
const BILL_PARSERS = [
    { source: 'wechat_history', parser: wechatHistoryParser },
    { source: 'alipay',         parser: alipayBillParser },
    { source: 'wechat_bill',    parser: wechatBillParser },
    { source: 'ccb',            parser: ccbNotificationParser },
];

function parseBillContent(content) {
    const lines = content.split('\n').map(l => l.trim()).filter(l => l.length > 0);
    if (lines.length === 0) return null;
    for (const { source, parser } of BILL_PARSERS) {
        if (!parser.detect(lines)) continue;
        const result = parser.parse(lines);
        if (!result) return { source, time: '', merchant: '', amount: 0, rawText: content };
        return { source, rawText: content, ...result };
    }
    return null;
}

// ── 测试用例 ─────────────────────────────────────────────────────────────────

const testCases = [
    // ── 微信支付完成页 ──────────────────────────────────────────────────────
    {
        name: '微信完成页 - 支付成功 + ¥ 被 OCR 为 *',
        content: `12:44 B
:!! 5GA €29
• 支付成功
Manner
*10.00
完成`,
        expect: { source: 'wechat_bill', merchant: 'Manner', amount: 10.00 },
    },
    {
        name: '微信完成页 - 支付成功 + ¥ 正常识别',
        content: `20:58
5G
18
支付成功
豆磨坊（**飞）
¥19.40
完成`,
        expect: { source: 'wechat_bill', merchant: '豆磨坊（**飞）', amount: 19.40 },
    },
    {
        name: '微信完成页 - 返回商家（无支付成功文字）',
        content: `12:42
5G
Manner
·10.00
返回商家`,
        expect: { source: 'wechat_bill', merchant: 'Manner', amount: 10.00 },
    },
    {
        name: '微信完成页 - 使用储蓄卡支付（跳过付款方式行）',
        content: `12:42
Manner
使用建设银行储蓄卡（0511）支付
·10.00
完成`,
        expect: { source: 'wechat_bill', merchant: 'Manner', amount: 10.00 },
    },
    {
        name: '微信完成页 - 使用亲属卡支付（跳过付款方式行）',
        content: `20:58
5G
100
林喜洪
使用林某的亲属卡支付
·5.50
完成`,
        expect: { source: 'wechat_bill', merchant: '林喜洪', amount: 5.50 },
    },
    {
        name: '微信完成页 - ¥ 被 OCR 为 . (点号)',
        content: `12:44
支付成功
Manner
.10.00
完成`,
        expect: { source: 'wechat_bill', merchant: 'Manner', amount: 10.00 },
    },

    // ── 微信支付账单页 ──────────────────────────────────────────────────────
    {
        name: '微信账单页 - 多笔记录取最后一笔（亲属卡）',
        content: `09:55
1
查看账单详情
查看名片
轻点背面
检测到轻点两下
Q
查看累计付款〉
李
交易状态
使用亲属卡支付
·20.00
支付成功，对方已收款
查看账单详情
商家名片
林喜洪
交易状态
使用亲属卡支付
·5.50
支付成功，对方已收款
查看账单详情
查看名片
查看累计付款＞
我的账单
nn.A7
支付服务
摇优惠`,
        expect: { source: 'wechat_history', merchant: '林喜洪', amount: 5.50 },
    },
    {
        name: '微信账单页 - 多笔记录（¥ 格式金额）',
        content: `19:36
查看账单详情
查看名片
查看累计付款〉
李
交易状态
使用亲属卡支付
¥20.00
支付成功，对方已收款
查看账单详情
商家名片
林喜洪
交易状态
使用亲属卡支付
·5.50
支付成功，对方已收款
查看账单详情
查看名片
查看累计付款〉
我的账单
支付服务
摇优惠`,
        expect: { source: 'wechat_history', merchant: '林喜洪', amount: 5.50 },
    },

    // ── 支付宝完成页 ────────────────────────────────────────────────────────
    {
        name: '支付宝完成页 - 抖音电商（商户全名在金额和付款方式之间）',
        content: `20:37
18
抖音
完成
·44.70
抖音电商商家
付款方式
·44.70
建设银行储蓄卡（0511）
绿色
能量
+5g 绿色能量点滴成林 护地球
立即领
+20 支付宝积分可兑换超值权益
立即领
完成`,
        expect: { source: 'alipay', merchant: '抖音电商商家', amount: 44.70 },
    },

    // ── 建设银行动账提醒 ────────────────────────────────────────────────────
    {
        name: '建设银行动账提醒 - 微信支付前缀',
        content: `中国建设银行
动账提醒
尾号0511的储蓄卡
交易时间：2026/03/31 12:42:19
交易金额：10.00
交易对象：微信支付-Manner
余额：1234.56`,
        expect: { source: 'ccb', merchant: 'Manner', amount: 10.00 },
    },
    {
        name: '建设银行动账提醒 - 无前缀商户',
        content: `中国建设银行
变动提醒
尾号0511的储蓄卡
交易时间：2026/04/01 09:30:00
交易金额：25.50
交易对象：盒马鲜生
余额：5678.90`,
        expect: { source: 'ccb', merchant: '盒马鲜生', amount: 25.50 },
    },

    // ── 边界情况 ────────────────────────────────────────────────────────────
    {
        name: '无法识别 - 纯文本无特征',
        content: `今天天气不错
去超市买了点东西`,
        expect: null,
    },
];

// ── 运行测试 ─────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

for (const tc of testCases) {
    const result = parseBillContent(tc.content);

    if (tc.expect === null) {
        if (result === null) {
            passed++;
            console.log(`  ✅ ${tc.name}`);
        } else {
            failed++;
            console.log(`  ❌ ${tc.name}`);
            console.log(`     期望: null`);
            console.log(`     实际: source=${result.source}, merchant=${result.merchant}, amount=${result.amount}`);
        }
        continue;
    }

    const ok = result &&
        result.source === tc.expect.source &&
        result.merchant === tc.expect.merchant &&
        result.amount === tc.expect.amount;

    if (ok) {
        passed++;
        console.log(`  ✅ ${tc.name}`);
    } else {
        failed++;
        console.log(`  ❌ ${tc.name}`);
        console.log(`     期望: source=${tc.expect.source}, merchant=${tc.expect.merchant}, amount=${tc.expect.amount}`);
        if (result) {
            console.log(`     实际: source=${result.source}, merchant=${result.merchant}, amount=${result.amount}`);
        } else {
            console.log(`     实际: null（未识别）`);
        }
    }
}

console.log(`\n${'═'.repeat(50)}`);
console.log(`  总计: ${passed + failed}  通过: ${passed}  失败: ${failed}`);
console.log(`${'═'.repeat(50)}`);

process.exit(failed > 0 ? 1 : 0);
