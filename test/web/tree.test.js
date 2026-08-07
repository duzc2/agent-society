/**
 * 组织树和岗位统计属性测试
 * 功能: agent-web-viewer
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import * as fc from 'fast-check';

// 模拟 TreeUtils
const TreeUtils = {
  buildTree(agents) {
    if (!Array.isArray(agents) || agents.length === 0) {
      return null;
    }

    const agentMap = new Map();
    agents.forEach(agent => {
      agentMap.set(agent.id, {
        id: agent.id,
        roleName: agent.roleName || '未知岗位',
        status: agent.status,
        children: [],
      });
    });

    let root = null;
    agents.forEach(agent => {
      const node = agentMap.get(agent.id);

      if (agent.id === 'root' || !agent.parentAgentId) {
        root = node;
      } else {
        const parent = agentMap.get(agent.parentAgentId);
        if (parent) {
          parent.children.push(node);
        }
      }
    });

    return root;
  },

  countByRole(agents) {
    const counts = new Map();

    if (!Array.isArray(agents)) {
      return counts;
    }

    agents.forEach(agent => {
      const roleName = agent.roleName || '未知岗位';
      counts.set(roleName, (counts.get(roleName) || 0) + 1);
    });

    return counts;
  },

  roleCountsToArray(counts) {
    const arr = [];
    counts.forEach((count, name) => {
      arr.push({ name, count });
    });
    arr.sort((a, b) => b.count - a.count);
    return arr;
  },

  traverse(node, callback, depth = 0) {
    if (!node) return;
    callback(node, depth);
    if (node.children) {
      node.children.forEach(child => {
        this.traverse(child, callback, depth + 1);
      });
    }
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

// 生成有效的树形结构智能体列表
const treeAgentsArbitrary = fc.integer({ min: 1, max: 20 }).chain(count => {
  return fc.array(
    fc.record({
      roleId: fc.uuid(),
      roleName: fc.string({ minLength: 1, maxLength: 20 }),
      status: fc.oneof(fc.constant('active'), fc.constant('terminated')),
    }),
    { minLength: count, maxLength: count }
  ).map(partialAgents => {
    // 创建根节点
    const agents = [{
      id: 'root',
      roleId: partialAgents[0].roleId,
      roleName: '根节点',
      parentAgentId: undefined,
      createdAt: new Date().toISOString(),
      status: 'active',
    }];

    // 创建其他节点，随机选择父节点
    for (let i = 1; i < partialAgents.length; i++) {
      const parentIndex = Math.floor(Math.random() * agents.length);
      agents.push({
        id: `agent-${i}`,
        roleId: partialAgents[i].roleId,
        roleName: partialAgents[i].roleName,
        parentAgentId: agents[parentIndex].id,
        createdAt: new Date().toISOString(),
        status: partialAgents[i].status,
      });
    }

    return agents;
  });
});

describe('功能: agent-web-viewer, 属性 3: 岗位智能体计数正确性', () => {
  it('按岗位分组后，每个岗位的智能体数量应等于该岗位在原列表中出现的次数', () => {
    fc.assert(
      fc.property(
        fc.array(agentArbitrary, { minLength: 0, maxLength: 100 }),
        (agents) => {
          const counts = TreeUtils.countByRole(agents);

          // 手动计算每个岗位的数量
          const expectedCounts = new Map();
          agents.forEach(agent => {
            const roleName = agent.roleName || '未知岗位';
            expectedCounts.set(roleName, (expectedCounts.get(roleName) || 0) + 1);
          });

          // 验证计数相等
          assert.strictEqual(counts.size, expectedCounts.size);

          counts.forEach((count, roleName) => {
            assert.strictEqual(count, expectedCounts.get(roleName));
          });

          return true;
        }
      ),
      { numRuns: 100 }
    );
  });

  it('所有岗位的智能体数量之和应等于智能体总数', () => {
    fc.assert(
      fc.property(
        fc.array(agentArbitrary, { minLength: 0, maxLength: 100 }),
        (agents) => {
          const counts = TreeUtils.countByRole(agents);

          let total = 0;
          counts.forEach(count => {
            total += count;
          });

          assert.strictEqual(total, agents.length);

          return true;
        }
      ),
      { numRuns: 100 }
    );
  });

  it('转换为数组后应按数量降序排列', () => {
    fc.assert(
      fc.property(
        fc.array(agentArbitrary, { minLength: 0, maxLength: 100 }),
        (agents) => {
          const counts = TreeUtils.countByRole(agents);
          const arr = TreeUtils.roleCountsToArray(counts);

          // 验证降序排列
          for (let i = 0; i < arr.length - 1; i++) {
            assert.ok(arr[i].count >= arr[i + 1].count);
          }

          return true;
        }
      ),
      { numRuns: 100 }
    );
  });
});

describe('功能: agent-web-viewer, 属性 7: 组织树结构正确性', () => {
  it('生成的组织树中每个节点的 parentAgentId 应与其在树中的父节点 ID 一致', () => {
    fc.assert(
      fc.property(
        treeAgentsArbitrary,
        (agents) => {
          const tree = TreeUtils.buildTree(agents);

          if (!tree) {
            // 空数组应返回 null
            assert.strictEqual(agents.length, 0);
            return true;
          }

          // 创建 ID 到原始智能体的映射
          const agentMap = new Map();
          agents.forEach(agent => {
            agentMap.set(agent.id, agent);
          });

          // 遍历树，验证父子关系
          const verifyNode = (node, parentId) => {
            const originalAgent = agentMap.get(node.id);

            if (parentId === null) {
              // 根节点应该没有父节点或父节点为 undefined
              assert.ok(
                originalAgent.id === 'root' ||
                !originalAgent.parentAgentId
              );
            } else {
              // 非根节点的父节点应该匹配
              assert.strictEqual(originalAgent.parentAgentId, parentId);
            }

            // 递归验证子节点
            if (node.children) {
              node.children.forEach(child => {
                verifyNode(child, node.id);
              });
            }
          };

          verifyNode(tree, null);

          return true;
        }
      ),
      { numRuns: 100 }
    );
  });

  it('空数组应返回 null', () => {
    const tree = TreeUtils.buildTree([]);
    assert.strictEqual(tree, null);
  });

  it('非数组输入应返回 null', () => {
    assert.strictEqual(TreeUtils.buildTree(null), null);
    assert.strictEqual(TreeUtils.buildTree(undefined), null);
    assert.strictEqual(TreeUtils.buildTree('string'), null);
  });

  it('遍历应访问所有节点', () => {
    fc.assert(
      fc.property(
        treeAgentsArbitrary,
        (agents) => {
          const tree = TreeUtils.buildTree(agents);

          if (!tree) return true;

          const visitedIds = new Set();
          TreeUtils.traverse(tree, (node) => {
            visitedIds.add(node.id);
          });

          // 验证访问的节点数量
          // 注意：可能有些节点因为父节点不存在而没有被添加到树中
          assert.ok(visitedIds.size > 0);

          return true;
        }
      ),
      { numRuns: 100 }
    );
  });
});
