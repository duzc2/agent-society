/**
 * 客户端交换状态容器。
 *
 * 承载 LlmClient 在单次 LLM 调用期间所需的可变共享状态，
 * 包括最后一次 HTTP 交换信息、请求体增强注册表和动态 token 上限覆盖。
 */
export class ClientExchangeState {
  constructor() {
    this.lastHttpExchange = null;
    this.augmentations = new Map();
    this.maxTokensOverride = null;
  }
}
