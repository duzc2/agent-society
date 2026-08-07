import { defineStore } from 'pinia';
import { ref } from 'vue';
import type { Organization } from '../types';
import { orgTreeState } from '../services/heartbeatService';

export const useOrgStore = defineStore('org', () => {
  const orgs = ref<Organization[]>([]);
  const loading = ref(false);
  const lastUpdated = ref(0);

  const fetchOrgs = (silent = false) => {
    if (!silent) loading.value = true;
    try {
      const tree = orgTreeState.tree;
      const rootNode = tree.find(node => node.id === 'root');
      const allOrgs: Organization[] = [];

      if (rootNode && Array.isArray(rootNode.children)) {
        rootNode.children.forEach((node: any) => {
          const name = node.orgName || node.customName || node.id;
          allOrgs.push({
            id: node.id,
            name,
            role: node.orgName ? (node.customName || node.id)+'-'+ node.roleName : node.roleName,
            initial: name.substring(0, 1).toUpperCase(),
            description: node.orgName ? (node.customName || node.id) +'-'+ node.roleName: (node.roleName || '组织部门'),
            sortOrder: node.sortOrder
          });
        });
      }

      // 过滤掉 root 和 user，它们是智能体，不是组织
      const filteredOrgs = allOrgs.filter(org => org.id !== 'root' && org.id !== 'user');

      // 按 sortOrder 排序（降序，新值在前；如果没有 sortOrder，则保持相对顺序）
      filteredOrgs.sort((a, b) => {
        if (a.sortOrder === undefined && b.sortOrder === undefined) return 0;
        if (a.sortOrder === undefined) return 1;
        if (b.sortOrder === undefined) return -1;
        return b.sortOrder - a.sortOrder;
      });

      // 添加虚拟的"首页"组织（固定在第一位）
      const homeOrg: Organization = {
        id: 'home',
        name: '首页',
        initial: 'H',
        description: '系统总览与核心智能体'
      };

      orgs.value = [homeOrg, ...filteredOrgs];
      lastUpdated.value = Date.now();
    } finally {
      if (!silent) loading.value = false;
    }
  };

  return {
    orgs,
    loading,
    lastUpdated,
    fetchOrgs
  };
});
