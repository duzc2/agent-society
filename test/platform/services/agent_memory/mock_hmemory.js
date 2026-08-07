/**
 * Mock hmemory 模块
 * 用于在没有实际 hmemory 包时进行测试
 */

export class MockMemory {
  constructor(config) {
    this.config = config;
    this.entries = [];
  }

  async processConversation(messages) {
    for (const msg of messages) {
      this.entries.push({
        type: "text",
        content: msg.text || JSON.stringify(msg),
        confidence: 0.9
      });
    }
  }

  async recall(options = {}) {
    const limit = options.limit || 5;
    const minConfidence = options.minConfidence || 0.7;
    return this.entries
      .filter(e => (e.confidence || 0.5) >= minConfidence)
      .slice(0, limit);
  }

  async close() {
    this.entries = [];
  }
}

export const AgentMemory = {
  async create(config) {
    // 实际测试时可以使用 MockMemory
    if (process.env.USE_MOCK_HMEMORY) {
      return new MockMemory(config);
    }
    throw new Error("hmemory package not installed");
  }
};
