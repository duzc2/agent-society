/**
 * LocalFile 模块 — panel.js 下拉列表 label 格式测试
 *
 * 覆盖 REQ-2025-001:
 *   - orgName + firstAgentName 都存在 → label = "orgName-firstAgentName"
 *   - orgName 存在，firstAgentName 缺失 → label = "orgName-orgId"
 *   - orgName 缺失 → label = orgId（回退）
 *   - 边界情况
 */

import { describe, it } from "node:test";
import assert from "node:assert";

// =============================================================================
// 从 panel.js 提取的 label 生成逻辑（单行改动）
// =============================================================================

/**
 * 模拟 panel.js 中 loadOrgList() 的 label 生成逻辑
 * 对应代码：const label = org.orgName ? `${org.orgName}-${org.firstAgentName || org.orgId}` : org.orgId;
 */
function makeLabel(org) {
  return org.orgName ? `${org.orgName}-${org.firstAgentName || org.orgId}` : org.orgId;
}

// =============================================================================
// 测试用例
// =============================================================================

describe("panel.js - loadOrgList label 生成逻辑", () => {

  // --- 正常场景 ---

  it("orgName 和 firstAgentName 都存在 → orgName-firstAgentName", () => {
    const org = { orgId: "org-001", orgName: "研发部", firstAgentName: "张三" };
    const label = makeLabel(org);
    assert.strictEqual(label, "研发部-张三");
  });

  it("orgName 中文 + firstAgentName 英文 → 正常拼接", () => {
    const org = { orgId: "org-002", orgName: "测试组", firstAgentName: "Alice" };
    const label = makeLabel(org);
    assert.strictEqual(label, "测试组-Alice");
  });

  it("orgName 和 firstAgentName 相同 → 仍然按格式拼接", () => {
    const org = { orgId: "org-003", orgName: "Admin", firstAgentName: "Admin" };
    const label = makeLabel(org);
    assert.strictEqual(label, "Admin-Admin");
  });

  it("orgName 和 firstAgentName 都包含特殊字符 → 正常拼接", () => {
    const org = { orgId: "org-004", orgName: "Team@#1", firstAgentName: "User_Test-001" };
    const label = makeLabel(org);
    assert.strictEqual(label, "Team@#1-User_Test-001");
  });

  // --- firstAgentName 缺失/为空 → 回退到 orgId ---

  it("firstAgentName 为 undefined → orgName-orgId", () => {
    const org = { orgId: "org-100", orgName: "市场部", firstAgentName: undefined };
    const label = makeLabel(org);
    assert.strictEqual(label, "市场部-org-100");
  });

  it("firstAgentName 为 null → orgName-orgId", () => {
    const org = { orgId: "org-101", orgName: "销售部", firstAgentName: null };
    const label = makeLabel(org);
    assert.strictEqual(label, "销售部-org-101");
  });

  it("firstAgentName 为空字符串 → orgName-orgId", () => {
    const org = { orgId: "org-102", orgName: "财务部", firstAgentName: "" };
    const label = makeLabel(org);
    assert.strictEqual(label, "财务部-org-102");
  });

  it("firstAgentName 不存在（字段缺失）→ orgName-orgId", () => {
    const org = { orgId: "org-103", orgName: "行政部" };
    // 未定义 firstAgentName 字段
    const label = makeLabel(org);
    assert.strictEqual(label, "行政部-org-103");
  });

  // --- orgName 缺失/为空 → 回退到 orgId ---

  it("orgName 为 undefined → orgId", () => {
    const org = { orgId: "org-200", orgName: undefined, firstAgentName: "王五" };
    const label = makeLabel(org);
    assert.strictEqual(label, "org-200");
  });

  it("orgName 为 null → orgId", () => {
    const org = { orgId: "org-201", orgName: null, firstAgentName: "赵六" };
    const label = makeLabel(org);
    assert.strictEqual(label, "org-201");
  });

  it("orgName 为空字符串 → orgId", () => {
    const org = { orgId: "org-202", orgName: "", firstAgentName: "孙七" };
    const label = makeLabel(org);
    assert.strictEqual(label, "org-202");
  });

  it("orgName 不存在（字段缺失）→ orgId", () => {
    const org = { orgId: "org-203", firstAgentName: "周八" };
    const label = makeLabel(org);
    assert.strictEqual(label, "org-203");
  });

  // --- 两者都缺失 ---

  it("orgName 和 firstAgentName 都不存在 → orgId", () => {
    const org = { orgId: "org-300" };
    const label = makeLabel(org);
    assert.strictEqual(label, "org-300");
  });

  it("orgName 为 null，firstAgentName 为 null → orgId", () => {
    const org = { orgId: "org-301", orgName: null, firstAgentName: null };
    const label = makeLabel(org);
    assert.strictEqual(label, "org-301");
  });

  // --- 向后兼容：与旧版行为对比 ---

  it("向后兼容：旧格式 orgName || orgId 也是 orgId（当 orgName 为空时）", () => {
    const org = { orgId: "org-backward", orgName: "" };
    const oldLabel = org.orgName || org.orgId;
    const newLabel = makeLabel(org);
    assert.strictEqual(newLabel, oldLabel);  // 都回退到 orgId
  });

  it("向后兼容：有 orgName 但无 firstAgentName → 新 label 比旧 label 多 -orgId", () => {
    const org = { orgId: "org-bw-2", orgName: "产品部" };
    const label = makeLabel(org);
    // 旧格式只会是 "产品部"，新格式是 "产品部-org-bw-2"
    assert.strictEqual(label, "产品部-org-bw-2");
  });

  // --- option.textContent 逻辑 ---

  it("option.textContent：folderCount > 0 时追加 [N项]", () => {
    const org = { orgId: "org-400", orgName: "项目部", firstAgentName: "李明", folderCount: 5 };
    const label = makeLabel(org);
    const textContent = org.folderCount > 0 ? `${label} [${org.folderCount}项]` : label;
    assert.strictEqual(textContent, "项目部-李明 [5项]");
  });

  it("option.textContent：folderCount = 0 时不追加计数", () => {
    const org = { orgId: "org-401", orgName: "运维部", firstAgentName: "陈工", folderCount: 0 };
    const label = makeLabel(org);
    const textContent = org.folderCount > 0 ? `${label} [${org.folderCount}项]` : label;
    assert.strictEqual(textContent, "运维部-陈工");
  });

  // --- 真实场景模拟 ---

  it("模拟 API 返回的完整 org 对象（两个字段都有）", () => {
    const apiOrg = {
      orgId: "agent-abc-123",
      orgName: "AI研发中心",
      firstAgentName: "架构师-陈敏",
      hasConfig: true,
      folderCount: 3
    };
    const label = makeLabel(apiOrg);
    assert.strictEqual(label, "AI研发中心-架构师-陈敏");
  });

  it("模拟 API 返回的完整 org 对象（无 firstAgentName）", () => {
    const apiOrg = {
      orgId: "agent-xyz-789",
      orgName: "测试团队",
      hasConfig: false,
      folderCount: 0
    };
    const label = makeLabel(apiOrg);
    assert.strictEqual(label, "测试团队-agent-xyz-789");
  });
});
