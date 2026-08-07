# Agent Society Windows 安装包构建方案

## 1. 目标
将 Agent Society 打包为标准的 Windows 安装程序 (`setup.exe`)，安装后提供独立的 `.exe` 可执行文件，具备以下特性：
- **独立运行**：无需用户手动安装 Bun 或 Node.js 环境。
- **一键安装**：通过向导式界面完成安装、快捷方式创建。
- **完整功能**：包含 Web 界面、FFmpeg 视频处理、SSH 等所有现有功能。

## 2. 技术方案

采用 **Bun Compile** + **Inno Setup** 的组合方案。

### 2.1 核心组件
1.  **主程序 (`agent-society.exe`)**
    - 使用 `bun build --compile` 将 `start.js` 及其依赖编译为单文件可执行程序。
    - 内置 Bun 运行时，性能优异。
2.  **外部资源**
    - **`web/`**: 前端静态资源，需保持目录结构，供 HTTP 服务加载。
    - **`modules/`**: 模块静态资源（如 `panel.html`），需保持目录结构。
    - **`config/`**: 配置文件，需暴露给用户以便修改（如 API Key）。
3.  **第三方依赖**
    - **FFmpeg**: 从 `node_modules/ffmpeg-static` 中提取 `ffmpeg.exe`，随安装包分发。
    - **Native Modules**: (`ssh2`, `canvas`) 尝试通过 Bun 编译集成，如遇兼容性问题，保留必要的 `.node` 文件或 `node_modules` 子集。

### 2.2 目录结构 (安装后)
```text
C:\Program Files\Agent Society\
├── agent-society.exe      # 主程序
├── ffmpeg.exe             # 视频处理工具
├── config/                # 配置文件
│   ├── app.json
│   └── ...
├── web/                   # Web 界面资源
└── modules/               # 模块资源
```

### 2.3 安装制作工具 (Inno Setup)
- 使用 Inno Setup 制作安装包。
- 脚本定义文件安装路径、快捷方式、卸载程序等。
- 自动将安装目录加入 PATH 或配置环境变量（可选）。

## 3. 构建流程

1.  **编译**: 运行 `bun build --compile ./start.js --outfile dist/bin/agent-society.exe`。
2.  **资源收集**:
    - 复制 `web/`, `modules/`, `config/` 到 `dist/`。
    - 复制 `node_modules/ffmpeg-static/ffmpeg.exe` 到 `dist/`。
3.  **打包**: 运行 Inno Setup 编译器 (`ISCC`) 读取 `setup.iss`，生成最终的 `AgentSociety_Setup.exe`。

## 4. 兼容性与限制
- **平台**: 仅限 Windows (x64)。
- **浏览器**: 依赖系统默认浏览器或 Chrome (Puppeteer 功能需用户系统有 Chrome/Edge)。
