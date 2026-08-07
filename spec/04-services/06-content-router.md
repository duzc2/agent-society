# Content Router 内容路由服务

## 1. 职责

Content Router 负责处理多模态内容的适配和路由：
- 根据模型能力决定内容处理方式
- 将各种格式的输入转换为 LLM 可接受的格式
- 处理文件上传和附件解析

## 2. 内部工作机制

### 2.1 能力检测

**模型能力注册**

每个模型服务在配置中声明支持的能力：
- vision: 是否支持图像理解
- audio: 是否支持音频理解
- file: 是否支持文件附件
- json_mode: 是否支持结构化输出

**运行时检测**

Content Router 通过 ServiceRegistry 查询：
- 指定智能体使用的 LLM 服务
- 该服务的 capability 列表
- 判断是否支持特定内容类型

### 2.2 内容类型识别

**MIME 类型映射**

根据文件扩展名或内容识别 MIME 类型：

图像类型：
- image/png, image/jpeg, image/gif, image/webp
- image/svg+xml, image/bmp

音频类型：
- audio/wav, audio/mp3, audio/mpeg
- audio/ogg, audio/webm

文本类型：
- text/plain, text/markdown
- text/html, text/css, text/javascript
- application/json, application/xml

文档类型：
- application/pdf
- application/msword
- application/vnd.openxmlformats-officedocument.wordprocessingml.document

**内容分类**

内容分为三类：
1. 文本内容：直接传递，无需转换
2. 视觉内容：图像类，需要 vision 能力
3. 文件内容：非文本二进制，需要 file 能力或转换为描述

### 2.3 路由决策逻辑

**图像处理策略**

检测模型是否支持 vision：

*支持 vision 的情况*
- 将图像转换为 base64 编码
- 格式化为 OpenAI vision 格式：
  ```
  {
    "type": "image_url",
    "image_url": {
      "url": "data:image/png;base64,..."
    }
  }
  ```
- 注入到用户消息的多模态数组中

*不支持 vision 的情况*
- 调用 ContentAdapter 生成文本描述
- 描述包含：图像类型、尺寸、可能的场景推测
- 以文本形式传递给模型
- 提示词中说明"用户上传了一张图片：[描述]"

**音频处理策略**

检测模型是否支持 audio：

*支持 audio 的情况*
- 格式化为音频格式
- 作为多模态输入

*不支持 audio 的情况*
- 尝试转录为文本（如配置了语音识别服务）
- 或者返回文本描述："用户发送了音频文件"

**文件处理策略**

根据文件类型分别处理：

*文本文件*
- 读取内容（限制最大字符数，默认 5000）
- 直接附加到用户消息中
- 格式："【文件内容】\n{文件名}\n{内容}"

*二进制文件（PDF、Word等）*
- 如果模型支持 file 能力：作为附件传递
- 如果不支持：生成文本描述，包含文件名、类型、大小

### 2.4 消息格式化

**OpenAI 多模态格式**

最终输出为标准的多模态消息格式：

```
{
  "role": "user",
  "content": [
    { "type": "text", "text": "用户的问题" },
    { "type": "image_url", "image_url": { "url": "base64..." } },
    { "type": "text", "text": "【文件: doc.txt】\n文件内容..." }
  ]
}
```

**长度限制**

各类内容的大小限制：
- 图片：最大 5MB（base64 后约 6.7MB）
- 文本文件：最大 5000 字符
- 附件描述：最大 50000 字符
- 总消息大小：最大 100KB

超过限制时：
- 图片：拒绝上传或压缩
- 文本：截断并添加提示"内容已截断"
- 附件：仅保留描述信息

### 2.5 ContentAdapter 适配器

**职责**

当模型不支持某种内容类型时，ContentAdapter 负责：
1. 寻找有能力处理该内容的其他智能体或工具
2. 生成内容的文本描述
3. 建议将内容转发给有能力的处理者

**适配流程**

1. 分析内容类型和特征
2. 查询 ServiceRegistry 找到支持该类型的服务
3. 如果没有，使用基础描述模板
4. 返回适配结果和转发建议

### 2.6 错误处理

**文件读取失败**

可能原因：
- 文件不存在或路径错误
- 文件损坏
- 编码错误（文本文件）

处理策略：
- 记录警告日志
- 返回占位描述："[文件读取失败: {原因}]"
- 不中断主流程

**格式转换失败**

- 图片编码失败：返回错误提示
- 文本解码失败：使用 latin-1 编码并提示乱码可能
- 总消息过大：截断内容

## 3. 配置

### 3.1 内容路由配置

```json
{
  "contentRouter": {
    "maxImageSize": 5242880,
    "maxTextLength": 5000,
    "maxAttachmentLength": 50000,
    "supportedMimeTypes": ["image/*", "text/*", "audio/*"],
    "blockedExtensions": [".exe", ".dll", ".bat", ".sh"]
  }
}
```

### 3.2 能力映射

```json
{
  "llmServices": [
    {
      "id": "gpt-4o",
      "capabilities": ["vision", "audio", "json_mode"]
    },
    {
      "id": "claude-3",
      "capabilities": ["vision", "file"]
    }
  ]
}
```

## 4. 使用场景

### 4.1 用户上传图片

1. 前端上传图片文件
2. Content Router 接收文件，识别为 image/png
3. 查询智能体所用模型的 capabilities，发现支持 vision
4. 将图片转为 base64
5. 格式化为 OpenAI 多模态格式
6. 附加到用户消息中
7. LLM 可以看到图片内容并回答相关问题

### 4.2 用户上传代码文件

1. 前端上传 .py 文件
2. Content Router 识别为 text/x-python
3. 读取文件内容（在长度限制内）
4. 格式化为文本块："【文件: script.py】\n{代码内容}"
5. 附加到用户消息中
6. LLM 可以查看代码并给出建议

### 4.3 不支持 vision 的模型接收图片

1. 用户上传图片
2. Content Router 发现模型不支持 vision
3. 调用 ContentAdapter 生成描述
4. 返回："用户上传了一张图片：[基础描述]"
5. 可选择建议转发给有 vision 能力的智能体
6. 以纯文本形式传递给 LLM
