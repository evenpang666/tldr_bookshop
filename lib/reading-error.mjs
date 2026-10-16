// Only fixed, actionable messages cross the HTTP boundary. Provider error text
// can contain request data or credentials and must stay out of the response.
export class ReadingError extends Error {
  constructor(reason) {
    const failure = reason?.kind === 'error' ? reason.error : undefined;
    const code = failure?.code;
    const status = failure?.status;
    let message;
    if (['AUTH', 'MISSING_CREDENTIAL', 'INVALID_CREDENTIAL'].includes(code) || status === 401 || status === 403) message = 'DeepSeek 认证失败，请在 DSH 中检查 API Key 与账户权限。';
    else if (['QUOTA', 'QUOTA_EXCEEDED', 'ACCOUNT_QUOTA_EXCEEDED'].includes(code) || status === 402) message = 'DeepSeek 账户额度不足，请检查余额与配额后重试。';
    else if (code === 'RATE_LIMIT' || status === 429) message = 'DeepSeek 请求过于频繁，请稍后重试。';
    else if (code === 'TRANSPORT') message = 'DSH 请求处理或网络连接失败，请重启 DSH Web 后重试；若仍失败，请检查网络与代理设置。';
    else if (['TIMEOUT', 'STREAM_CLOSED'].includes(code)) message = 'DeepSeek 响应超时或连接中断，请稍后重试。';
    else if (code === 'SERVER' || status >= 500) message = 'DeepSeek 服务暂时不可用，请稍后重试。';
    else if (code === 'CONTEXT_WINDOW_EXCEEDED' || status === 413) message = '原文超过当前模型的上下文容量，请分段提供后重试。';
    else if (['NO_ADAPTER', 'MODEL_NOT_FOUND', 'UNSUPPORTED_REASONING_EFFORT', 'INVALID_REQUEST'].includes(code) || status === 400 || status === 422) message = 'DSH 模型请求配置不被支持，请检查默认模型、推理设置与原文长度后重试。';
    else if (code === 'REQUEST_EXTENSION') message = 'DSH 请求初始化失败，请重新启动薄书以检查并更新 DSH 环境。';
    else if (code === 'WEB_INIT') message = 'DSH 联网工具初始化失败，请重启 DSH Web 加载最新薄书插件后重试。';
    else if (code === 'WEB_UNAVAILABLE') message = '联网检索暂时不可用，请检查 DSH 搜索服务与网络，或提供原文后重试。';
    else if (code === 'INSUFFICIENT_SOURCE') message = '资料不足，暂时无法可靠提炼。请补充原文或提供可靠资料后重试。';
    else if (['EMPTY_RESPONSE', 'MALFORMED_RESPONSE'].includes(code)) message = 'DeepSeek 返回了空白或无效响应，请重试。';
    else if (reason?.kind === 'max-tokens') message = '模型输出达到长度上限，正文尚未完成。请选择较短阅读时长，或将原文分段后重试。';
    else if (reason?.kind === 'blocked') message = 'DSH 已阻止本次提炼，请检查 DSH 的权限与运行策略后重试。';
    else if (['aborted', 'interrupted'].includes(reason?.kind) || code === 'ABORTED') message = '本次提炼已被中断，请重试。';
    else message = 'DSH 未完成提炼，请检查 DSH 会话错误记录后重试。';
    super(message);
    this.name = 'ReadingError';
  }
}
