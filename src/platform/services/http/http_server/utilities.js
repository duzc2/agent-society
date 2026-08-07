/**
 * HTTP服务器工具函数。
 * 包含 JSON 读取/发送、systemPromptAppendix 归一化等纯工具方法。
 */

/**
 * 读取请求体JSON。
 * @param {import("node:http").IncomingMessage} req
 * @param {(err:Error|null, body?:any)=>void} callback
 */
export function readJsonBody(req, callback) {
  let body = "";
  req.on("data", (chunk) => {
    body += chunk.toString();
  });
  req.on("end", () => {
    try {
      // 如果请求体为空，返回null而不是尝试解析
      if (body.trim() === "") {
        callback(null, null);
        return;
      }
      const parsed = JSON.parse(body);
      callback(null, parsed);
    } catch (err) {
      callback(err);
    }
  });
  req.on("error", (err) => {
    callback(err);
  });
}

/**
 * 发送JSON响应。
 * @param {import("node:http").ServerResponse} res
 * @param {number} statusCode
 * @param {any} data
 */
export function sendJson(res, statusCode, data) {
  try {
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.writeHead(statusCode);
    const jsonStr = JSON.stringify(data);
    res.end(jsonStr);
  } catch (err) {
    // JSON序列化失败时，尝试发送一个简单的错误响应
    try {
      if (!res.headersSent) {
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.writeHead(500);
      }
      res.end(JSON.stringify({ error: "json_serialization_error", message: err.message }));
    } catch {
      res.end();
    }
  }
}

/**
 * 统一归一化 systemPromptAppendix 条目。
 * 该函数用于保证 HTTP 接口和运行时数据结构一致，避免空白条目进入持久化数据。
 * @param {unknown} rawItems
 * @returns {string[]}
 */
export function normalizeSystemPromptAppendix(rawItems) {
  if (Array.isArray(rawItems)) {
    return rawItems
      .filter((item) => typeof item === "string")
      .map((item) => item.trim())
      .filter(Boolean);
  }
  if (typeof rawItems === "string" && rawItems.trim()) {
    return [rawItems.trim()];
  }
  return [];
}

