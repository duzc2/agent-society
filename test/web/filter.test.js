/**
 * 筛选函数属性测试
 * 功能: agent-web-viewer
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import * as fc from 'fast-check';

// 模拟 FilterUtils
const FilterUtils = {
  filterByRole(agents, keyword) {
    if (!Array.isArray(agents)) {
      return [];
    }
    if (!keyword || keyword.trim() === '') {
      return [...agents];
    }
    const lowerKeyword = keyword.toLowerCase().trim();
    return agents.filter(agent => {
      const roleName = (agent.roleName || '').toLowerCase();
      return roleName.includes(lowerKeyword);
    });
  },

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

describe('功能: agent-web-viewer, 属性 2: 岗位筛选结果正确性', () => {
  it('筛选结果中的每个智能体的岗位名称都应包含筛选关键词（不区分大小写）', () => {
    fc.assert(
      fc.property(
        fc.array(agentArbitrary, { minLength: 0, maxLength: 100 }),
        fc.string({ minLength: 1, maxLength: 10 }),
        (agents, keyword) => {
          const filtered = FilterUtils.filterByRole(agents, keyword);
          const lowerKeyword = keyword.toLowerCase().trim();

          // 验证每个结果都包含关键词
          for (const agent of filtered) {
            const roleName = (agent.roleName || '').toLowerCase();
            assert.ok(roleName.includes(lowerKeyword));
          }

          return true;
        }
      ),
      { numRuns: 100 }
    );
  });

  it('空关键词应返回所有智能体', () => {
    fc.assert(
      fc.property(
        fc.array(agentArbitrary, { minLength: 0, maxLength: 100 }),
        fc.oneof(fc.constant(''), fc.constant('  '), fc.constant(null), fc.constant(undefined)),
        (agents, keyword) => {
          const filtered = FilterUtils.filterByRole(agents, keyword);
          assert.strictEqual(filtered.length, agents.length);
          return true;
        }
      ),
      { numRuns: 100 }
    );
  });

  it('筛选结果应是原数组的子集', () => {
    fc.assert(
      fc.property(
        fc.array(agentArbitrary, { minLength: 0, maxLength: 100 }),
        fc.string({ minLength: 0, maxLength: 10 }),
        (agents, keyword) => {
          const filtered = FilterUtils.filterByRole(agents, keyword);
          assert.ok(filtered.length <= agents.length);

          // 验证每个结果都在原数组中
          const agentIds = new Set(agents.map(a => a.id));
          for (const agent of filtered) {
            assert.ok(agentIds.has(agent.id));
          }

          return true;
        }
      ),
      { numRuns: 100 }
    );
  });

  it('筛选不应修改原数组', () => {
    fc.assert(
      fc.property(
        fc.array(agentArbitrary, { minLength: 1, maxLength: 50 }),
        fc.string({ minLength: 1, maxLength: 10 }),
        (agents, keyword) => {
          const original = JSON.stringify(agents);
          FilterUtils.filterByRole(agents, keyword);
          assert.strictEqual(JSON.stringify(agents), original);
          return true;
        }
      ),
      { numRuns: 100 }
    );
  });

  it('筛选应不区分大小写', () => {
    fc.assert(
      fc.property(
        fc.array(agentArbitrary, { minLength: 0, maxLength: 50 }),
        fc.string({ minLength: 1, maxLength: 10 }),
        (agents, keyword) => {
          const lowerResult = FilterUtils.filterByRole(agents, keyword.toLowerCase());
          const upperResult = FilterUtils.filterByRole(agents, keyword.toUpperCase());

          // 结果应该相同
          assert.strictEqual(lowerResult.length, upperResult.length);

          return true;
        }
      ),
      { numRuns: 100 }
    );
  });
});

describe('功能: agent-web-viewer, 综合筛选测试', () => {
  it('综合筛选应匹配岗位名称或智能体 ID', () => {
    fc.assert(
      fc.property(
        fc.array(agentArbitrary, { minLength: 0, maxLength: 100 }),
        fc.string({ minLength: 1, maxLength: 10 }),
        (agents, keyword) => {
          const filtered = FilterUtils.filterByKeyword(agents, keyword);
          const lowerKeyword = keyword.toLowerCase().trim();

          // 验证每个结果都匹配关键词
          for (const agent of filtered) {
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
});
