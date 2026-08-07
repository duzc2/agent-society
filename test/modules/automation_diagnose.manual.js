/**
 * 自动化模块诊断测试
 *
 * 诊断内容：
 * 1. 获取桌面所有顶级窗口
 * 2. 列出可用进程
 * 3. 测试基本UIAutomation功能
 */

import { describe, it, before } from "node:test";
import assert from "node:assert";
import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

// PowerShell 绝对路径
const PS_PATH = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';

/**
 * 检测 PowerShell 是否可用
 * @returns {Promise<boolean>}
 */
async function isPowerShellAvailable() {
  try {
    await execAsync(`"${PS_PATH}" -Command "$PSVersionTable.PSVersion"`, { timeout: 10000 });
    return true;
  } catch {
    return false;
  }
}

describe("自动化模块诊断", () => {
  let powershellAvailable = false;

  before(async () => {
    powershellAvailable = await isPowerShellAvailable();
  });

  it("PowerShell 可用性检查", async () => {
    if (!powershellAvailable) {
      console.log("[SKIP] PowerShell 不可用，跳过测试");
      return;
    }

    const { stdout } = await execAsync(`"${PS_PATH}" -Command "$PSVersionTable.PSVersion"`, { timeout: 10000 });
    assert.ok(stdout.includes("Major"));
  });

  it("UIAutomation 程序集检查", async () => {
    if (!powershellAvailable) {
      console.log("[SKIP] PowerShell 不可用，跳过测试");
      return;
    }

    const psScript = `
Add-Type -AssemblyName UIAutomationClient
$assembly = [System.Reflection.Assembly]::GetAssembly([System.Windows.Automation.AutomationElement])
Write-Host "UIAutomation 程序集已加载"
Write-Host "位置: $($assembly.Location)"
Write-Host "版本: $($assembly.GetName().Version)"

# 获取桌面元素
$desktop = [System.Windows.Automation.AutomationElement]::RootElement
Write-Host "桌面元素名称: $($desktop.Current.Name)"
Write-Host "桌面元素类型: $($desktop.Current.ControlType.ProgrammaticName)"

# 获取所有顶级窗口
$condition = [System.Windows.Automation.Condition]::TrueCondition
$windows = $desktop.FindAll([System.Windows.Automation.TreeScope]::Children, $condition)
Write-Host "顶级窗口数量: $($windows.Count)"

# 列出前10个窗口
Write-Host "前10个窗口:"
for ($i = 0; $i -lt [Math]::Min(10, $windows.Count); $i++) {
    $win = $windows[$i]
    $name = $win.Current.Name
    $className = $win.Current.ClassName
    $processId = $win.Current.ProcessId
    Write-Host "  [$i] Name='$name' Class='$className' PID=$processId"
}
`;

    // 使用 Base64 编码避免特殊字符问题（包括 Conda 编码问题）
    const buffer = Buffer.from(psScript, 'utf16le');
    const base64Script = buffer.toString('base64');

    const { stdout, stderr } = await execAsync(
      `"${PS_PATH}" -NoProfile -ExecutionPolicy Bypass -EncodedCommand ${base64Script}`,
      { timeout: 30000, maxBuffer: 1024 * 1024 }
    );

    // 处理 Conda 可能产生的编码警告
    if (stderr && !stderr.includes("WARNING") && !stderr.includes("Conda")) {
      throw new Error(`PowerShell stderr: ${stderr}`);
    }

    assert.ok(stdout.includes("UIAutomation 程序集已加载"));
    assert.ok(stdout.includes("桌面元素名称:"));
    assert.ok(stdout.includes("顶级窗口数量:"));
  });
});
