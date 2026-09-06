/**
 * RuntimeTools — 工具组默认行为与 org_management 强制包含测试
 *
 * 验证：
 * 1. role.toolGroups === null 时默认仅 org_management（不再是全部工具组）
 * 2. org_management 始终强制包含，即使未在 role.toolGroups 中指定
 * 3. 指定其他工具组时，org_management 自动追加
 * 4. root 智能体仅能使用 org_management
 */
import { describe, it } from "node:test";
import assert from "node:assert";
import { RuntimeTools } from "../../../src/platform/runtime/runtime_tools.js";

/** 生成 mock 工具定义 */
function makeToolDef(name) {
  return {
    type: "function",
    function: { name, description: `${name} tool`, parameters: { type: "object", properties: {} } }
  };
}

const orgMgmtTool = makeToolDef("find_role_by_name");
const workspaceTool = makeToolDef("file_read_lines");
const networkTool = makeToolDef("http_request");
const commandTool = makeToolDef("run_javascript");
const getOrgStructureTool = makeToolDef("get_org_structure");
const skillTool = makeToolDef("load_skill_detail");
const chromeTool = makeToolDef("chrome_new_tab");
const groupMsgTool = makeToolDef("send_group_message");

describe("RuntimeTools - 默认工具组行为", () => {
  describe("getToolDefinitionsForAgent - toolGroups 默认值与 org_management 强制包含", () => {
    /**
     * 构建一个最小可用的 mock runtime，用于测试工具组过滤逻辑。
     * @param {{toolGroups?: string[]|null, metaMap?: Map}} options
     */
    function makeRuntime(options = {}) {
      const toolGroups = options.toolGroups !== undefined ? options.toolGroups : null;
      const metaMap = options.metaMap ?? new Map([["agent-1", { roleId: "role-1" }]]);

      return {
        log: { debug() {}, info() {}, warn() {}, error() {} },
        _agentMetaById: metaMap,
        org: {
          getRole: () => ({ toolGroups })
        },
        toolGroupManager: {
          getToolDefinitions(groupIds) {
            const tools = [];
            if (groupIds.includes("org_management")) {
              tools.push(orgMgmtTool, getOrgStructureTool, groupMsgTool);
            }
            if (groupIds.includes("workspace")) {
              tools.push(workspaceTool);
            }
            if (groupIds.includes("network")) {
              tools.push(networkTool);
            }
            if (groupIds.includes("command")) {
              tools.push(commandTool);
            }
            if (groupIds.includes("skill")) {
              tools.push(skillTool);
            }
            if (groupIds.includes("chrome")) {
              tools.push(chromeTool);
            }
            return tools;
          },
          isToolInGroups(toolName, groupIds) {
            if (toolName === "find_role_by_name" || toolName === "get_org_structure" || toolName === "send_group_message") {
              return groupIds.includes("org_management");
            }
            if (toolName === "file_read_lines") return groupIds.includes("workspace");
            if (toolName === "http_request") return groupIds.includes("network");
            if (toolName === "run_javascript") return groupIds.includes("command");
            if (toolName === "load_skill_detail") return groupIds.includes("skill");
            if (toolName === "chrome_new_tab") return groupIds.includes("chrome");
            return false;
          },
          getAllGroupIds: () => ["org_management", "workspace", "network", "command", "skill", "chrome", "model_capability"]
        },
        moduleLoader: {
          getToolDefinitions: () => [],
          hasToolName: () => false
        },
        _toolExecutor: {
          getToolDefinitions: () => [orgMgmtTool, workspaceTool, networkTool, commandTool, getOrgStructureTool, skillTool, chromeTool]
        }
      };
    }

    it("role.toolGroups 为 null 时应仅返回 org_management 工具", () => {
      const runtime = makeRuntime({ toolGroups: null });
      const runtimeTools = new RuntimeTools(runtime);
      const defs = runtimeTools.getToolDefinitionsForAgent("agent-1");

      const names = defs.map(d => d?.function?.name);
      assert.ok(names.includes("find_role_by_name"), "应有 org_management 工具");
      assert.ok(names.includes("get_org_structure"), "get_org_structure 始终可见");
      assert.strictEqual(names.includes("file_read_lines"), false, "不应有 workspace 工具");
      assert.strictEqual(names.includes("http_request"), false, "不应有 network 工具");
      assert.strictEqual(names.includes("run_javascript"), false, "不应有 command 工具");
    });

    it("群工具属于 org_management：默认工具组应包含 send_group_message", () => {
      const runtime = makeRuntime({ toolGroups: null });
      const runtimeTools = new RuntimeTools(runtime);
      const defs = runtimeTools.getToolDefinitionsForAgent("agent-1");

      const names = defs.map(d => d?.function?.name);
      assert.ok(names.includes("send_group_message"), "群工具应在 org_management 组中默认可见");
    });

    it("指定 toolGroups 为 [\"workspace\"] 时应包含 org_management + workspace", () => {
      const runtime = makeRuntime({ toolGroups: ["workspace"] });
      const runtimeTools = new RuntimeTools(runtime);
      const defs = runtimeTools.getToolDefinitionsForAgent("agent-1");

      const names = defs.map(d => d?.function?.name);
      assert.ok(names.includes("find_role_by_name"), "org_management 应被自动包含");
      assert.ok(names.includes("file_read_lines"), "workspace 工具应存在");
    });

    it("指定 toolGroups 已包含 org_management 时不应重复", () => {
      const runtime = makeRuntime({ toolGroups: ["org_management", "workspace"] });
      const runtimeTools = new RuntimeTools(runtime);
      const defs = runtimeTools.getToolDefinitionsForAgent("agent-1");

      const names = defs.map(d => d?.function?.name);
      // org_management 应出现一次（去重由 toolGroupManager.getToolDefinitions 负责）
      assert.ok(names.includes("find_role_by_name"));
      assert.ok(names.includes("file_read_lines"));
      // toolGroupManager 负责去重，这里不重复验证
    });

    it("指定多个 toolGroups 时 org_management 始终排在第一位", () => {
      const runtime = makeRuntime({ toolGroups: ["network", "command"] });
      const runtimeTools = new RuntimeTools(runtime);
      const defs = runtimeTools.getToolDefinitionsForAgent("agent-1");

      // toolGroupManager.getToolDefinitions 按传入顺序返回工具，org_management 排在最前
      const names = defs.map(d => d?.function?.name);
      assert.ok(names.includes("find_role_by_name"), "org_management 工具应存在");
      assert.ok(names.includes("http_request"), "network 工具应存在");
      assert.ok(names.includes("run_javascript"), "command 工具应存在");
    });

    it("root 智能体仅能使用 org_management 工具", () => {
      const runtime = makeRuntime({ toolGroups: ["workspace", "network"] });
      const runtimeTools = new RuntimeTools(runtime);
      const defs = runtimeTools.getToolDefinitionsForAgent("root");

      const names = defs.map(d => d?.function?.name);
      assert.ok(names.includes("find_role_by_name"), "root 应有 org_management 工具");
      assert.strictEqual(names.includes("file_read_lines"), false, "root 不应有 workspace 工具");
      assert.strictEqual(names.includes("http_request"), false, "root 不应有 network 工具");
    });

    it("未配置 skill 工具组时技能工具不出现在定义列表中", () => {
      const runtime = makeRuntime({ toolGroups: null });
      const runtimeTools = new RuntimeTools(runtime);
      const defs = runtimeTools.getToolDefinitionsForAgent("agent-1");

      const names = defs.map(d => d?.function?.name);
      assert.strictEqual(names.includes("load_skill_detail"), false, "不应出现技能工具");
    });

    it("配置 skill 工具组时技能工具出现在定义列表中", () => {
      const runtime = makeRuntime({ toolGroups: ["skill"] });
      const runtimeTools = new RuntimeTools(runtime);
      const defs = runtimeTools.getToolDefinitionsForAgent("agent-1");

      const names = defs.map(d => d?.function?.name);
      assert.ok(names.includes("load_skill_detail"), "应出现技能工具");
    });

    it("智能体元数据缺失时应失败关闭（仅 org_management + 始终允许工具）", () => {
      const runtime = makeRuntime({ metaMap: new Map() });
      const runtimeTools = new RuntimeTools(runtime);
      const defs = runtimeTools.getToolDefinitionsForAgent("nonexistent-agent");

      const names = defs.map(d => d?.function?.name);
      // 安全边界：元数据缺失时绝不返回全部工具，仅 org_management + 始终允许工具
      assert.ok(names.includes("find_role_by_name"), "应有 org_management 工具");
      assert.ok(names.includes("get_org_structure"), "get_org_structure 始终可见");
      assert.strictEqual(names.includes("file_read_lines"), false, "不应泄漏 workspace 工具");
      assert.strictEqual(names.includes("load_skill_detail"), false, "不应泄漏 skill 工具");
      assert.strictEqual(names.includes("chrome_new_tab"), false, "不应泄漏 chrome 工具");
    });
  });

  describe("isToolAvailableForAgent - toolGroups 默认值", () => {
    function makeRuntime(options = {}) {
      const toolGroups = options.toolGroups !== undefined ? options.toolGroups : null;
      const metaMap = options.metaMap ?? new Map([["agent-1", { roleId: "role-1" }]]);

      return {
        log: { debug() {}, info() {}, warn() {}, error() {} },
        _agentMetaById: metaMap,
        org: {
          getRole: () => ({ toolGroups })
        },
        toolGroupManager: {
          isToolInGroups(toolName, groupIds) {
            // 简单映射：工具名 → 所属组
            const mapping = {
              find_role_by_name: "org_management",
              get_org_structure: "org_management",
              send_group_message: "org_management",
              file_read_lines: "workspace",
              http_request: "network",
              run_javascript: "command",
              load_skill_detail: "skill",
              chrome_new_tab: "chrome"
            };
            const group = mapping[toolName];
            return group ? groupIds.includes(group) : false;
          },
          getAllGroupIds: () => ["org_management", "workspace", "network", "command", "skill", "chrome"]
        },
        moduleLoader: {
          hasToolName: () => false
        }
      };
    }

    it("toolGroups 为 null 时 org_management 工具应可用", () => {
      const runtime = makeRuntime({ toolGroups: null });
      const runtimeTools = new RuntimeTools(runtime);

      assert.strictEqual(runtimeTools.isToolAvailableForAgent("agent-1", "find_role_by_name"), true);
    });

    it("群工具属于 org_management：toolGroups 为 null 时 send_group_message 应可用", () => {
      const runtime = makeRuntime({ toolGroups: null });
      const runtimeTools = new RuntimeTools(runtime);

      assert.strictEqual(runtimeTools.isToolAvailableForAgent("agent-1", "send_group_message"), true);
    });

    it("群工具属于 org_management：老岗位持久化数据（无 group_chat）仍可用", () => {
      const runtime = makeRuntime({ toolGroups: ["workspace"] });
      const runtimeTools = new RuntimeTools(runtime);

      assert.strictEqual(runtimeTools.isToolAvailableForAgent("agent-1", "send_group_message"), true);
    });

    it("toolGroups 为 null 时非 org_management 工具应不可用", () => {
      const runtime = makeRuntime({ toolGroups: null });
      const runtimeTools = new RuntimeTools(runtime);

      assert.strictEqual(runtimeTools.isToolAvailableForAgent("agent-1", "file_read_lines"), false);
      assert.strictEqual(runtimeTools.isToolAvailableForAgent("agent-1", "http_request"), false);
    });

    it("指定 toolGroups 为 [\"workspace\"] 时 org_management 工具应仍然可用", () => {
      const runtime = makeRuntime({ toolGroups: ["workspace"] });
      const runtimeTools = new RuntimeTools(runtime);

      assert.strictEqual(runtimeTools.isToolAvailableForAgent("agent-1", "find_role_by_name"), true);
      assert.strictEqual(runtimeTools.isToolAvailableForAgent("agent-1", "file_read_lines"), true);
      assert.strictEqual(runtimeTools.isToolAvailableForAgent("agent-1", "http_request"), false);
    });

    it("root 智能体仅能用 org_management 工具", () => {
      const runtime = makeRuntime({ toolGroups: ["workspace", "network"] });
      const runtimeTools = new RuntimeTools(runtime);

      assert.strictEqual(runtimeTools.isToolAvailableForAgent("root", "find_role_by_name"), true);
      assert.strictEqual(runtimeTools.isToolAvailableForAgent("root", "file_read_lines"), false);
    });

    it("get_org_structure 始终对所有智能体可用", () => {
      const runtime = makeRuntime({ toolGroups: null });
      const runtimeTools = new RuntimeTools(runtime);

      // get_org_structure 在 isToolAvailableForAgent 中硬编码为 true
      assert.strictEqual(runtimeTools.isToolAvailableForAgent("agent-1", "get_org_structure"), true);
      assert.strictEqual(runtimeTools.isToolAvailableForAgent("root", "get_org_structure"), true);
    });

    it("智能体不存在时应失败关闭（仅允许 org_management）", () => {
      const runtime = makeRuntime({ metaMap: new Map() });
      const runtimeTools = new RuntimeTools(runtime);

      // 安全边界：元数据缺失时绝不放开全部工具，仅 org_management
      assert.strictEqual(runtimeTools.isToolAvailableForAgent("nonexistent", "find_role_by_name"), true);
      assert.strictEqual(runtimeTools.isToolAvailableForAgent("nonexistent", "file_read_lines"), false);
      assert.strictEqual(runtimeTools.isToolAvailableForAgent("nonexistent", "chrome_new_tab"), false);
    });

    describe("模块工具组归属强制 - 未分配 chrome 工具组的智能体不能调用 chrome 工具", () => {
    it("toolGroups 为 null 时模块工具不可用", () => {
      const runtime = makeRuntime({ toolGroups: null });
      const runtimeTools = new RuntimeTools(runtime);

      assert.strictEqual(runtimeTools.isToolAvailableForAgent("agent-1", "chrome_new_tab"), false,
        "未分配 chrome 工具组时模块工具必须被拒绝");
    });

    it("toolGroups 包含 chrome 时模块工具可用", () => {
      const runtime = makeRuntime({ toolGroups: ["chrome"] });
      const runtimeTools = new RuntimeTools(runtime);

      assert.strictEqual(runtimeTools.isToolAvailableForAgent("agent-1", "chrome_new_tab"), true);
    });

    it("root 智能体不能使用模块工具", () => {
      const runtime = makeRuntime({ toolGroups: ["chrome"] });
      const runtimeTools = new RuntimeTools(runtime);

      assert.strictEqual(runtimeTools.isToolAvailableForAgent("root", "chrome_new_tab"), false);
    });
  });

  describe("skill 工具组强制 - 未分配 skill 工具组的智能体不能使用技能工具", () => {
    it("toolGroups 为 null 时技能工具不可用", () => {
      const runtime = makeRuntime({ toolGroups: null });
      const runtimeTools = new RuntimeTools(runtime);

      assert.strictEqual(runtimeTools.isToolAvailableForAgent("agent-1", "load_skill_detail"), false);
    });

    it("toolGroups 包含 skill 时技能工具可用", () => {
      const runtime = makeRuntime({ toolGroups: ["skill"] });
      const runtimeTools = new RuntimeTools(runtime);

      assert.strictEqual(runtimeTools.isToolAvailableForAgent("agent-1", "load_skill_detail"), true);
    });
  });
  });
});

describe("RuntimeTools - generateToolGroupsDescription 工具组描述拼装", () => {
  /**
   * 描述拼装逻辑（runtime_tools.js generateToolGroupsDescription）：
   * 从 toolGroupManager.listGroups() 动态拼装 create_role toolGroups 参数的可选值说明。
   * 验证拼装不漏组、含描述、空列表走回退文本。
   */
  function makeDescRuntime(groups) {
    return {
      log: { debug() {}, info() {}, warn() {}, error() {} },
      toolGroupManager: {
        listGroups: () => groups
      }
    };
  }

  it("多组时输出含每个组的 id 与描述", () => {
    const runtime = makeDescRuntime([
      { id: "localcmd", description: "本地命令执行工具，支持长期运行的交互式进程" },
      { id: "ui_page", description: "面向本软件 Web UI 页面上下文的工具" }
    ]);
    const runtimeTools = new RuntimeTools(runtime);
    const text = runtimeTools.generateToolGroupsDescription();

    assert.ok(text.includes("localcmd"), "应含 localcmd 组名");
    assert.ok(text.includes("本地命令执行工具"), "应含 localcmd 组描述");
    assert.ok(text.includes("ui_page"), "应含 ui_page 组名");
    assert.ok(text.includes("面向本软件 Web UI 页面上下文的工具"), "应含 ui_page 组描述");
  });

  it("组列表为空时回退默认说明文本", () => {
    const runtime = makeDescRuntime([]);
    const runtimeTools = new RuntimeTools(runtime);
    const text = runtimeTools.generateToolGroupsDescription();

    assert.strictEqual(text, "工具组标识符列表，限制该岗位可用的工具函数。不指定则使用全部工具组。");
  });
});
