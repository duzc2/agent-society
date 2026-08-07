# Agent Society 图标资源

## 📁 文件说明

| 文件 | 说明 | 用途 |
|------|------|------|
| `icon.ico` | Windows 图标文件 | 桌面快捷方式、窗口图标 |
| `icon.svg` | 矢量图标源文件 | 可编辑，用于生成其他格式 |

## 🎨 图标设计理念

Agent Society 图标采用**智能体网络**概念：

- **中央大节点（蓝色）**: 代表 Root 智能体
- **周围小节点（多色）**: 代表子智能体/工作组
- **连接线**: 表示智能体之间的协作关系
- **六边形布局**: 象征自组织的网络结构
- **渐变色**: 体现科技感与活力

## 🚀 使用方法

### 方式一：自动生成

```powershell
# 生成 ICO 图标
python scripts\generate_icon.py

# 创建桌面快捷方式（自动使用图标）
python scripts\create-shortcut.ps1
```

### 方式二：手动创建快捷方式

1. 右键 `start.ps1` → "发送到" → "桌面快捷方式"
2. 右键桌面快捷方式 → "属性"
3. "更改图标" → 浏览选择 `assets\icon.ico`
4. 确定保存

## ✏️ 自定义图标

### 编辑矢量图标

`icon.svg` 可用以下工具编辑：

- **专业工具**: Adobe Illustrator, Figma, Sketch
- **免费工具**: Inkscape, Boxy SVG (浏览器)
- **在线工具**: [SVG-Edit](https://svg-edit.github.io/svgedit/)

### 转换为 ICO

编辑 SVG 后，转换为 ICO 文件：

```powershell
# 方法 1: 使用 Python Pillow
pip install Pillow
python scripts\generate_icon.py

# 方法 2: 使用在线转换工具
# https://convertio.co/svg-ico/
# https://cloudconvert.com/svg-to-ico

# 方法 3: 使用 ImageMagick（如已安装）
convert icon.svg -define icon:auto-resize=256,128,64,48,32,16 icon.ico
```

## 🎨 颜色方案

| 元素 | 颜色 | 色值 |
|------|------|------|
| Root 节点 | Google Blue | `#4285f4` → `#64b5f6` |
| 智能体 1 | Green | `#34a853` → `#81c784` |
| 智能体 2 | Yellow | `#fbbc04` → `#ffd54f` |
| 智能体 3 | Red | `#ea4335` → `#ef5350` |
| 智能体 4 | Purple | `#ab47bc` → `#ba68c8` |
| 背景 | Dark Blue | `#1a1f2e` → `#2d3548` |

## 📐 技术规格

### ICO 文件包含尺寸

| 尺寸 | 用途 |
|------|------|
| 16×16 | 任务栏、小图标 |
| 32×32 | 窗口标题栏 |
| 48×48 | 资源管理器列表 |
| 64×64 | 工具栏 |
| 128×128 | 大图标显示 |
| 256×256 | 桌面大图标、高 DPI |

### SVG 规格

- **画布大小**: 256×256
- **视口**: 0 0 256 256
- **渐变**: 径向渐变 + 线性渐变
- **滤镜**: 阴影 + 发光效果

## 🖼️ 预览

图标在不同场景的显示效果：

```
桌面大图标 (256×256):
┌─────────────────┐
│    ◯────◯      │
│   /    ⭐    \   │  ⭐ = Root (蓝色)
│  ◯ ── ◆ ── ◯  │  ◯ = Agent (彩色)
│   \    │    /   │  ◆ = 连接线
│    ◯───┴───◯    │
└─────────────────┘

任务栏小图标 (16×16):
┌────┐
│ ◆  │
│◯⭐◯ │  简化为核心元素
│ ◆  │
└────┘
```

## 🔧 故障排除

### 图标不显示

```powershell
# 清除图标缓存（需要管理员权限）
ie4uinit.exe -ClearIconCache
taskkill /IM explorer.exe /F
start explorer.exe
```

### 生成失败

```powershell
# 安装依赖
pip install Pillow

# 重新生成
python scripts\generate_icon.py
```

### 颜色失真

ICO 文件使用有损压缩时可能出现颜色失真，建议：
1. 使用更高质量的转换工具
2. 保留 SVG 源文件便于重新生成

## 📄 许可

图标设计遵循项目 MIT 许可证。

---

**设计理念**: 网络、协作、智能体社会 🤖🔗🤖
