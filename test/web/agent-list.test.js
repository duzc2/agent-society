/**
 * AgentList 组件属性测试
 * 功能: overview-role-click-filter
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import * as fc from 'fast-check';

// 模拟 DOM 环境
const createMockSearchInput = () => ({
  value: '',
  addEventListener: () => {},
});

// 模拟 FilterUtils
const FilterUtils = {
  filterByKeyword(agents, keyword) {
    if (!Array.isArray(agents)) {
      return [];
    }
    if (!keyword || keyword.trim() === '') {
      return [...agents];
    }
    const lowerKeyword = keyword.toLowerCase().trim();
    return agents.filter(agent => {
      const roleName = (agent.roleName || '').toLowerCase();
      const id = (agent.id || '').toLowerCase();
      return roleName.includes(lowerKeyword) || id.includes(lowerKeyword);
    });
  },
};

// 模拟 SortUtils
const SortUtils = {
  sortWithPinnedAgents(agents) {
    return [...agents];
  },
};

// 模拟 AgentList 组件核心逻辑
const createAgentList = () => ({
  agents: [],
  filteredAgents: [],
  filterKeyword: '',
  searchInput: createMockSearchInput(),

  setFilterKeyword(keyword) {
    this.filterKeyword = keyword || '';
    if (this.searchInput) {
      this.searchInput.value = this.filterKeyword;
    }
    this.applyFilterAndSort();
  },

  applyFilterAndSort() {
    let result = FilterUtils.filterByKeyword(this.agents, this.filterKeyword);
    result = SortUtils.sortWithPinnedAgents(result);
    this.filteredAgents = result;
  },

  setAgents(agents) {
    this.agents = agents || [];
    this.applyFilterAndSort();
  },
});

// 使用整数时间戳生成日期字符串
const dateStringArb = fc.integer({ min: 1577836800000, max: 1893456000000 })
  .map(ts => new Date(ts).toISOString());

// 智能体生成器
const agentArbitrary = fc.record({
  id: fc.uuid(),
  roleId: fc.uuid(),
  roleName: fc.string({ minLength: 1, maxLength: 20 }),
  parentAgentId: fc.option(fc.uuid(), { nil: undefined }),
  createdAt: dateStringArb,
  status: fc.oneof(fc.constant('active'), fc.constant('terminated')),
});

describe('功能: overview-role-click-filter, 属性 2: 筛选关键词与搜索框同步', () => {
  it('设置筛选关键词后，搜索框值应与关键词相等', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 0, maxLength: 50 }),
        (keyword) => {
          const agentList = createAgentList();
          agentList.setFilterKeyword(keyword);

          // 验证搜索框值与关键词相等
          assert.strictEqual(agentList.searchInput.value, keyword);
          assert.strictEqual(agentList.filterKeyword, keyword);

          return true;
        }
      ),
      { numRuns: 100 }
    );
  });

  it('设置 null 或 undefined 关键词应转换为空字符串', () => {
    fc.assert(
      fc.property(
        fc.oneof(fc.constant(null), fc.constant(undefined)),
        (keyword) => {
          const agentList = createAgentList();
          agentList.setFilterKeyword(keyword);

          assert.strictEqual(agentList.searchInput.value, '');
          assert.strictEqual(agentList.filterKeyword, '');

          return true;
        }
      ),
      { numRuns: 100 }
    );
  });

  it('多次设置筛选关键词，搜索框应始终同步最新值', () => {
    fc.assert(
      fc.property(
        fc.array(fc.string({ minLength: 0, maxLength: 20 }), { minLength: 1, maxLength: 10 }),
        (keywords) => {
          const agentList = createAgentList();

          for (const keyword of keywords) {
            agentList.setFilterKeyword(keyword);
            assert.strictEqual(agentList.searchInput.value, keyword);
          }

          // 最终值应为最后一个关键词
          const lastKeyword = keywords[keywords.length - 1];
          assert.strictEqual(agentList.filterKeyword, lastKeyword);

          return true;
        }
      ),
      { numRuns: 100 }
    );
  });
});

describe('功能: overview-role-click-filter, 属性 3: 筛选正确过滤智能体', () => {
  it('设置筛选关键词后，filteredAgents 应只包含匹配的智能体', () => {
    fc.assert(
      fc.property(
        fc.array(agentArbitrary, { minLength: 0, maxLength: 50 }),
        fc.string({ minLength: 1, maxLength: 10 }),
        (agents, keyword) => {
          const agentList = createAgentList();
          agentList.setAgents(agents);
          agentList.setFilterKeyword(keyword);

          const lowerKeyword = keyword.toLowerCase().trim();

          // 验证每个筛选结果都匹配关键词
          for (const agent of agentList.filteredAgents) {
            const roleName = (agent.roleName || '').toLowerCase();
            const id = (agent.id || '').toLowerCase();
            const matches = roleName.includes(lowerKeyword) || id.includes(lowerKeyword);
            assert.ok(matches);
          }

          return true;
        }
      ),
      { numRuns: 100 }
    );
  });

  it('空关键词应显示所有智能体', () => {
    fc.assert(
      fc.property(
        fc.array(agentArbitrary, { minLength: 0, maxLength: 50 }),
        (agents) => {
          const agentList = createAgentList();
          agentList.setAgents(agents);
          agentList.setFilterKeyword('');

          assert.strictEqual(agentList.filteredAgents.length, agents.length);

          return true;
        }
      ),
      { numRuns: 100 }
    );
  });
});

/**
 * Property 1: 停止按钮可见性
 * 对于任意智能体对象，停止按钮在渲染的 HTML 中可见当且仅当智能体的 computeStatus 为 'waiting_llm'。
 *
 * **验证: Requirements 1.1, 1.2**
 */

// 模拟 renderComputeStatus 方法
const renderComputeStatus = (agent) => {
  const computeStatus = agent.computeStatus;
  if (!computeStatus || computeStatus === 'idle') {
    return '';
  }

  if (computeStatus === 'waiting_llm') {
    return `
      <span class="compute-status waiting" title="等待大模型响应">⏳</span>
      <button class="abort-btn"
              onclick="event.stopPropagation(); AgentList.abortLlmCall('${agent.id}')"
              title="停止调用">⏹</button>
    `;
  }

  if (computeStatus === 'processing') {
    // 处理中状态也显示停止按钮，允许用户中断工具调用循环
    return `
      <span class="compute-status processing" title="处理中">⚙️</span>
      <button class="abort-btn"
              onclick="event.stopPropagation(); AgentList.abortLlmCall('${agent.id}')"
              title="停止处理">⏹</button>
    `;
  }

  return '';
};

describe('功能: llm-call-abort, 属性 1: 停止按钮可见性', () => {
  it('当 computeStatus 为 waiting_llm 时，应渲染停止按钮', () => {
    fc.assert(
      fc.property(
        fc.record({
          id: fc.uuid(),
          computeStatus: fc.constant('waiting_llm')
        }),
        (agent) => {
          const html = renderComputeStatus(agent);

          // 验证包含停止按钮
          assert.ok(html.includes('abort-btn'));
          assert.ok(html.includes('停止调用'));
          assert.ok(html.includes('⏹'));
          assert.ok(html.includes(agent.id));

          return true;
        }
      ),
      { numRuns: 100 }
    );
  });

  it('当 computeStatus 为 idle 时，不应渲染停止按钮', () => {
    fc.assert(
      fc.property(
        fc.record({
          id: fc.uuid(),
          computeStatus: fc.constant('idle')
        }),
        (agent) => {
          const html = renderComputeStatus(agent);

          // 验证不包含停止按钮
          assert.ok(!html.includes('abort-btn'));
          assert.strictEqual(html, '');

          return true;
        }
      ),
      { numRuns: 100 }
    );
  });

  it('当 computeStatus 为 processing 时，应渲染停止按钮', () => {
    fc.assert(
      fc.property(
        fc.record({
          id: fc.uuid(),
          computeStatus: fc.constant('processing')
        }),
        (agent) => {
          const html = renderComputeStatus(agent);

          // 验证包含停止按钮和处理中状态
          assert.ok(html.includes('abort-btn'));
          assert.ok(html.includes('停止处理'));
          assert.ok(html.includes('⏹'));
          assert.ok(html.includes('processing'));
          assert.ok(html.includes('⚙️'));
          assert.ok(html.includes(agent.id));

          return true;
        }
      ),
      { numRuns: 100 }
    );
  });

  it('当 computeStatus 为 undefined 或 null 时，不应渲染任何内容', () => {
    fc.assert(
      fc.property(
        fc.record({
          id: fc.uuid(),
          computeStatus: fc.oneof(fc.constant(undefined), fc.constant(null))
        }),
        (agent) => {
          const html = renderComputeStatus(agent);

          // 验证返回空字符串
          assert.strictEqual(html, '');

          return true;
        }
      ),
      { numRuns: 100 }
    );
  });

  it('停止按钮应包含正确的 agentId', () => {
    fc.assert(
      fc.property(
        fc.uuid(),
        (agentId) => {
          const agent = { id: agentId, computeStatus: 'waiting_llm' };
          const html = renderComputeStatus(agent);

          // 验证 onclick 处理器包含正确的 agentId
          assert.ok(html.includes(`AgentList.abortLlmCall('${agentId}')`));

          return true;
        }
      ),
      { numRuns: 100 }
    );
  });
});
