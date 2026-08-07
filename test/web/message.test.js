/**
 * 消息处理属性测试
 * 功能: agent-web-viewer
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import * as fc from 'fast-check';

// 消息过滤函数
const MessageUtils = {
  /**
   * 过滤指定智能体的消息
   * @param {Array} messages - 消息数组
   * @param {string} agentId - 智能体 ID
   * @returns {Array} 过滤后的消息
   */
  filterByAgent(messages, agentId) {
    if (!Array.isArray(messages)) {
      return [];
    }
    return messages.filter(msg => msg.from === agentId || msg.to === agentId);
  },

  /**
   * 按时间排序消息
   * @param {Array} messages - 消息数组
   * @param {string} order - 排序方向 ('asc' 或 'desc')
   * @returns {Array} 排序后的消息
   */
  sortByTime(messages, order = 'asc') {
    if (!Array.isArray(messages)) {
      return [];
    }
    const sorted = [...messages];
    sorted.sort((a, b) => {
      const timeA = new Date(a.createdAt || 0).getTime();
      const timeB = new Date(b.createdAt || 0).getTime();
      return order === 'asc' ? timeA - timeB : timeB - timeA;
    });
    return sorted;
  },

  /**
   * 获取消息文本内容
   * @param {object} message - 消息对象
   * @returns {string} 消息文本
   */
  getMessageText(message) {
    if (!message.payload) return '[空消息]';
    if (typeof message.payload === 'string') return message.payload;
    if (message.payload.message) return message.payload.message;
    if (message.payload.content) return message.payload.content;
    if (message.payload.text) return message.payload.text;
    return '[复杂消息]';
  },
};

// 使用整数时间戳生成日期字符串
const dateStringArb = fc.integer({ min: 1577836800000, max: 1893456000000 })
  .map(ts => new Date(ts).toISOString());

// 消息生成器
const messageArbitrary = fc.record({
  id: fc.uuid(),
  from: fc.uuid(),
  to: fc.uuid(),
  taskId: fc.option(fc.uuid(), { nil: undefined }),
  payload: fc.oneof(
    fc.string({ minLength: 1, maxLength: 100 }),
    fc.record({
      message: fc.string({ minLength: 1, maxLength: 100 }),
    }),
    fc.record({
      content: fc.string({ minLength: 1, maxLength: 100 }),
    })
  ),
  createdAt: dateStringArb,
});

describe('功能: agent-web-viewer, 属性 4: 消息过滤正确性', () => {
  it('过滤后的消息列表中每条消息的 from 或 to 字段应等于该智能体 ID', () => {
    fc.assert(
      fc.property(
        fc.array(messageArbitrary, { minLength: 0, maxLength: 100 }),
        fc.uuid(),
        (messages, agentId) => {
          const filtered = MessageUtils.filterByAgent(messages, agentId);

          // 验证每条消息都与该智能体相关
          for (const msg of filtered) {
            assert.ok(msg.from === agentId || msg.to === agentId);
          }

          return true;
        }
      ),
      { numRuns: 100 }
    );
  });

  it('过滤结果应包含所有与该智能体相关的消息', () => {
    fc.assert(
      fc.property(
        fc.array(messageArbitrary, { minLength: 0, maxLength: 100 }),
        fc.uuid(),
        (messages, agentId) => {
          const filtered = MessageUtils.filterByAgent(messages, agentId);

          // 手动计算应该包含的消息数量
          const expectedCount = messages.filter(
            msg => msg.from === agentId || msg.to === agentId
          ).length;

          assert.strictEqual(filtered.length, expectedCount);

          return true;
        }
      ),
      { numRuns: 100 }
    );
  });

  it('过滤不应修改原数组', () => {
    fc.assert(
      fc.property(
        fc.array(messageArbitrary, { minLength: 1, maxLength: 50 }),
        fc.uuid(),
        (messages, agentId) => {
          const original = JSON.stringify(messages);
          MessageUtils.filterByAgent(messages, agentId);
          assert.strictEqual(JSON.stringify(messages), original);
          return true;
        }
      ),
      { numRuns: 100 }
    );
  });
});

describe('功能: agent-web-viewer, 属性 5: 消息时间排序正确性', () => {
  it('升序排序后，每条消息的创建时间应小于或等于其后一条消息的创建时间', () => {
    fc.assert(
      fc.property(
        fc.array(messageArbitrary, { minLength: 0, maxLength: 100 }),
        (messages) => {
          const sorted = MessageUtils.sortByTime(messages, 'asc');

          for (let i = 0; i < sorted.length - 1; i++) {
            const timeA = new Date(sorted[i].createdAt).getTime();
            const timeB = new Date(sorted[i + 1].createdAt).getTime();
            assert.ok(timeA <= timeB);
          }

          return true;
        }
      ),
      { numRuns: 100 }
    );
  });

  it('降序排序后，每条消息的创建时间应大于或等于其后一条消息的创建时间', () => {
    fc.assert(
      fc.property(
        fc.array(messageArbitrary, { minLength: 0, maxLength: 100 }),
        (messages) => {
          const sorted = MessageUtils.sortByTime(messages, 'desc');

          for (let i = 0; i < sorted.length - 1; i++) {
            const timeA = new Date(sorted[i].createdAt).getTime();
            const timeB = new Date(sorted[i + 1].createdAt).getTime();
            assert.ok(timeA >= timeB);
          }

          return true;
        }
      ),
      { numRuns: 100 }
    );
  });

  it('排序不应改变数组长度', () => {
    fc.assert(
      fc.property(
        fc.array(messageArbitrary, { minLength: 0, maxLength: 100 }),
        fc.oneof(fc.constant('asc'), fc.constant('desc')),
        (messages, order) => {
          const sorted = MessageUtils.sortByTime(messages, order);
          assert.strictEqual(sorted.length, messages.length);
          return true;
        }
      ),
      { numRuns: 100 }
    );
  });

  it('排序不应修改原数组', () => {
    fc.assert(
      fc.property(
        fc.array(messageArbitrary, { minLength: 1, maxLength: 50 }),
        (messages) => {
          const original = JSON.stringify(messages);
          MessageUtils.sortByTime(messages, 'asc');
          assert.strictEqual(JSON.stringify(messages), original);
          return true;
        }
      ),
      { numRuns: 100 }
    );
  });
});

describe('功能: agent-web-viewer, 属性 6: 消息渲染完整性', () => {
  it('消息文本提取应正确处理各种 payload 格式', () => {
    // 字符串 payload
    assert.strictEqual(MessageUtils.getMessageText({ payload: 'hello' }), 'hello');

    // 对象 payload with message
    assert.strictEqual(MessageUtils.getMessageText({ payload: { message: 'hello' } }), 'hello');

    // 对象 payload with content
    assert.strictEqual(MessageUtils.getMessageText({ payload: { content: 'hello' } }), 'hello');

    // 对象 payload with text
    assert.strictEqual(MessageUtils.getMessageText({ payload: { text: 'hello' } }), 'hello');

    // 空 payload
    assert.strictEqual(MessageUtils.getMessageText({ payload: null }), '[空消息]');
    assert.strictEqual(MessageUtils.getMessageText({}), '[空消息]');

    // 复杂 payload
    assert.strictEqual(MessageUtils.getMessageText({ payload: { data: [1, 2, 3] } }), '[复杂消息]');
  });

  it('消息文本提取应返回非空字符串', () => {
    fc.assert(
      fc.property(
        messageArbitrary,
        (message) => {
          const text = MessageUtils.getMessageText(message);
          assert.strictEqual(typeof text, 'string');
          assert.ok(text.length > 0);
          return true;
        }
      ),
      { numRuns: 100 }
    );
  });
});
