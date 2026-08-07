
/**
 * 标签页管理模块
 * 负责创建、关闭和列出标签页
 */
export class TabsFeature {
  constructor(options) {
    this.log = options.log;
    this.tabManager = options.tabManager;
  }

  getToolDefinitions() {
    return [
      {
        type: "function",
        function: {
          name: "chrome_new_tab",
          description: "创建新标签页。如果该智能体还没有浏览器，会自动启动一个。返回 tabId 用于后续的页面操作。",
          parameters: {
            type: "object",
            properties: {
              url: { type: "string", description: "初始 URL（可选）。如果不指定，将打开一个空白页（about:blank）。" }
            }
          }
        }
      },
      {
        type: "function",
        function: {
          name: "chrome_close_tab",
          description: "关闭指定的标签页。返回剩余标签页列表（包含 tabId、title、url）。如果这是该智能体的最后一个标签页，浏览器会自动关闭。",
          parameters: {
            type: "object",
            properties: {
              tabId: { type: "string", description: "要关闭的标签页 ID。必须提供。" }
            },
            required: ["tabId"]
          }
        }
      },
      {
        type: "function",
        function: {
          name: "chrome_list_tabs",
          description: "列出当前智能体的所有标签页，返回每个标签页的 ID、URL 和标题",
          parameters: {
            type: "object",
            properties: {}
          }
        }
      }
    ];
  }

  async handleToolCall(toolName, args, ctx, agentId) {
    switch (toolName) {
      case "chrome_new_tab":
        return await this.tabManager.newTab(agentId, args.url);
      case "chrome_close_tab":
        return await this.tabManager.closeTab(args.tabId);
      case "chrome_list_tabs":
        return await this.tabManager.listTabs(agentId);
      default:
        throw new Error(`Unknown tool: ${toolName}`);
    }
  }
}
