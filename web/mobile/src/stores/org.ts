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
            role: node.orgName ? (node.customName || node.id)+'-'+ node.roleName: node.roleName,
            initial: name.substring(0, 1).toUpperCase(),
            description: node.orgName ? (node.customName || node.id) +'-'+ node.roleName: (node.roleName || '组织部门'),
            sortOrder: node.sortOrder
          });
        });
      }

      const filteredOrgs = allOrgs.filter(org => org.id !== 'root' && org.id !== 'user');

      filteredOrgs.sort((a, b) => {
        if (a.sortOrder === undefined && b.sortOrder === undefined) return 0;
        if (a.sortOrder === undefined) return 1;
        if (b.sortOrder === undefined) return -1;
        return b.sortOrder - a.sortOrder;
      });

      orgs.value = filteredOrgs;
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
