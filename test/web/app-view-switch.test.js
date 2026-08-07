/**
 * App 视图切换属性测试
 * 功能: overview-role-click-filter
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import * as fc from 'fast-check';

// 模拟 AgentList
const createMockAgentList = () => ({
  filterKeyword: '',
  searchInput: { value: '' },
  setFilterKeyword(keyword) {
    this.filterKeyword = keyword || '';
    this.searchInput.value = this.filterKeyword;
  },
});

// 模拟 OverviewPanel
const createMockOverviewPanel = () => ({
  isHidden: false,
  hide() {
    this.isHidden = true;
  },
  show() {
    this.isHidden = false;
  },
});

// 模拟 App 核心逻辑
const createApp = (agentList, overviewPanel) => ({
  currentView: 'overview',
  agentList,
  overviewPanel,

  switchToListView() {
    this.currentView = 'list';
    this.overviewPanel.hide();
  },

  switchToListViewWithFilter(filterKeyword) {
    this.switchToListView();
    this.agentList.setFilterKeyword(filterKeyword);
  },

  switchToOverviewView() {
    this.currentView = 'overview';
    this.overviewPanel.show();
  },
});

describe('功能: overview-role-click-filter, 属性 1: 岗位点击触发视图切换和筛选', () => {
  it('调用 switchToListViewWithFilter 后，视图应切换到 list', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 0, maxLength: 50 }),
        (roleName) => {
          const agentList = createMockAgentList();
          const overviewPanel = createMockOverviewPanel();
          const app = createApp(agentList, overviewPanel);

          // 初始状态为 overview
          app.currentView = 'overview';
          overviewPanel.isHidden = false;

          app.switchToListViewWithFilter(roleName);

          // 验证视图切换
          assert.strictEqual(app.currentView, 'list');
          assert.strictEqual(overviewPanel.isHidden, true);

          return true;
        }
      ),
      { numRuns: 100 }
    );
  });

  it('调用 switchToListViewWithFilter 后，筛选关键词应设置为岗位名称', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 0, maxLength: 50 }),
        (roleName) => {
          const agentList = createMockAgentList();
          const overviewPanel = createMockOverviewPanel();
          const app = createApp(agentList, overviewPanel);

          app.switchToListViewWithFilter(roleName);

          // 验证筛选关键词
          assert.strictEqual(agentList.filterKeyword, roleName);
          assert.strictEqual(agentList.searchInput.value, roleName);

          return true;
        }
      ),
      { numRuns: 100 }
    );
  });

  it('从任意视图调用 switchToListViewWithFilter 都应正确工作', () => {
    fc.assert(
      fc.property(
        fc.oneof(fc.constant('list'), fc.constant('overview')),
        fc.string({ minLength: 1, maxLength: 30 }),
        (initialView, roleName) => {
          const agentList = createMockAgentList();
          const overviewPanel = createMockOverviewPanel();
          const app = createApp(agentList, overviewPanel);

          // 设置初始视图
          app.currentView = initialView;
          overviewPanel.isHidden = initialView === 'list';

          app.switchToListViewWithFilter(roleName);

          // 无论初始状态如何，最终都应该是 list 视图且筛选关键词正确
          assert.strictEqual(app.currentView, 'list');
          assert.strictEqual(agentList.filterKeyword, roleName);

          return true;
        }
      ),
      { numRuns: 100 }
    );
  });

  it('连续调用 switchToListViewWithFilter 应使用最新的筛选关键词', () => {
    fc.assert(
      fc.property(
        fc.array(fc.string({ minLength: 1, maxLength: 20 }), { minLength: 2, maxLength: 5 }),
        (roleNames) => {
          const agentList = createMockAgentList();
          const overviewPanel = createMockOverviewPanel();
          const app = createApp(agentList, overviewPanel);

          for (const roleName of roleNames) {
            app.switchToListViewWithFilter(roleName);
          }

          // 最终筛选关键词应为最后一个
          const lastRoleName = roleNames[roleNames.length - 1];
          assert.strictEqual(agentList.filterKeyword, lastRoleName);

          return true;
        }
      ),
      { numRuns: 100 }
    );
  });
});
