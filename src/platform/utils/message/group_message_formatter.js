/**
 * 群消息格式化器（纯函数模块，无 DI 注册）
 *
 * 职责：
 * - 将群消息格式化为智能体可理解的结构化文本
 * - 将群系统消息格式化为简短提示行
 *
 * 消息形态约定（群扇出信封）：
 * - message.from = 群ID（群身份）
 * - message.extras.groupName = 群名
 * - message.extras.senderAgentId = 原发送者（'system' = 系统通知）
 *
 * 纯函数，无类、无依赖、可直接 import。
 */

/**
 * 格式化群消息以呈现给智能体。
 * 消息对象由内部系统构造，字段保证存在。
 * @param {object} message - 原始消息
 * @param {string} message.from - 群 ID
 * @param {object} message.extras - 附加字段（groupName / senderAgentId）
 * @param {object} message.payload - 消息内容
 * @param {object} [senderInfo] - 发送者信息（外部数据，可能为空）
 * @param {string} [senderInfo.role] - 发送者角色名称
 * @returns {string} 格式化后的消息文本
 */
export function formatGroupMessageForAgent(message, senderInfo) {
  const senderId = message.extras?.senderAgentId ?? "unknown";
  const groupId = message.from;
  const groupName = message.extras?.groupName ?? groupId;
  const payload = message.payload;

  let senderLabel;
  if (senderId === "user") {
    senderLabel = "用户";
  } else {
    const senderRole = (senderInfo && senderInfo.role) ? senderInfo.role : "unknown";
    senderLabel = `${senderRole}（${senderId}）`;
  }

  // 提取消息内容
  let content = "";
  if (payload === null || payload === undefined) {
    content = "";
  } else if (typeof payload === "object") {
    const textField = payload.text || payload.content || "";
    if (typeof textField === "string") {
      content = textField;
    } else {
      content = JSON.stringify(textField);
    }
  } else {
    content = String(payload);
  }

  return [
    `【群聊 ${groupName}】`,
    `来自 ${senderLabel} 的消息：`,
    content,
    "",
    `如需回复，请使用 send_group_message(groupId='${groupId}', payload={text:'...'})`,
    `注意：你不需要对每条群消息都回复。请根据消息内容是否与你的职责和当前任务相关来决定是否回复。`
  ].join("\n");
}

/**
 * 格式化群系统消息以呈现给智能体。
 * 消息对象由内部系统构造，字段保证存在。
 * @param {object} message - 系统消息
 * @param {string} message.from - 群 ID
 * @param {object} message.extras - 附加字段（groupName）
 * @param {object} message.payload - 消息内容
 * @returns {string} 格式化后的系统消息文本
 */
export function formatGroupSystemMessageForAgent(message) {
  const groupId = message.from;
  const groupName = message.extras?.groupName ?? groupId;
  const payload = message.payload;

  let text = "";
  if (payload === null || payload === undefined) {
    text = "";
  } else if (typeof payload === "object") {
    const textField = payload.text || payload.content || "";
    text = typeof textField === "string" ? textField : JSON.stringify(textField);
  } else {
    text = String(payload);
  }

  return [
    `【群聊 ${groupName} · 系统通知】`,
    text
  ].join("\n");
}
