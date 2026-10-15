// USD / 1M tokens. Source checked 2026-10-15; retain the snapshot with cached readings.
export const pricing = { date: '2026-10-15', source: 'https://api-docs.deepseek.com/quick_start/pricing/', currency: 'USD', flash: { input: .3, cached: .006, output: 1.2 }, pro: { input: 1.32, cached: .044, output: 3.96 } };
function ratesFor(model) { if (['deepseek-flash', 'deepseek-v4-flash', 'deepseek-v4-flash-vision-exp'].includes(model)) return pricing.flash; if (model === 'deepseek-v4-pro') return pricing.pro; return null; }
export function estimateCost(events, model) {
  let subtotal = 0, inputTokens = 0, cachedTokens = 0, outputTokens = 0, calls = 0, searches = 0, searchEstimate = 0, unknown = false;
  const rates = ratesFor(model);
  for (const event of events) {
    if (event.type === 'assistant/message' && event.data?.usage) {
      const u = event.data.usage; calls++;
      const input = Math.max(0, Number(u.inputTokens) || 0) + Math.max(0, Number(u.cacheWriteTokens) || 0), cached = Math.max(0, Number(u.cacheReadTokens) || 0), output = Math.max(0, Number(u.outputTokens) || 0);
      inputTokens += input; cachedTokens += cached; outputTokens += output;
      if (rates) subtotal += (input * rates.input + cached * rates.cached + output * rates.output) / 1e6; else unknown = true;
    }
    if (event.type === 'web/deepseek-search-llm-request') { searches++; searchEstimate += (10000 * pricing.flash.input + 4096 * pricing.flash.output) / 1e6; }
  }
  return { currency: 'USD', minUsd: calls && !unknown ? subtotal / 2 : null, maxUsd: calls && !unknown ? subtotal + searchEstimate : null, inputTokens, cachedTokens, outputTokens, modelCalls: calls, searchCalls: searches, estimated: true, partial: unknown || !calls || searches > 0, pricingDate: pricing.date, pricingSource: pricing.source, note: !calls || unknown ? '该模型缺少价格或用量，暂不能可靠估算。' : searches ? '主模型按实际 token 估算；搜索未返回用量，以每次约 1 万输入、4096 输出 token 作参考，实际可能超出。范围包含峰谷价格差异，账单以 DeepSeek 为准。' : '按实际 token 与峰谷价格区间估算，账单以 DeepSeek 为准。' };
}
