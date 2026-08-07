# Windows 进程崩溃取证使用说明

## 目标
通过 WER LocalDumps、ProcDump 和事件日志，获取“进程突然消失”时的系统级证据。

## 前置条件
- 操作系统：Windows
- 已安装 Sysinternals ProcDump（建议放到固定路径）
- 运行 `enable-wer-dumps.ps1` 需要管理员权限

## 步骤 1：启用 WER 崩溃转储
```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\win\enable-wer-dumps.ps1
```

可选参数示例：
```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\win\enable-wer-dumps.ps1 -Executables bun.exe,node.exe -DumpType Full -DumpCount 50
```

## 步骤 2：启动 ProcDump 监控
```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\win\start-procdump-monitor.ps1 -ProcDumpPath C:\tools\procdump\procdump64.exe -TargetProcessNames bun.exe,node.exe
```

如果你希望连“正常终止”也抓 dump，再加 `-IncludeTerminate`。

脚本会返回会话目录，例如：
`agent-society-data\crash\procdump\20260314-180000`

## 步骤 3：异常后导出事件日志
```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\win\export-crash-events.ps1 -StartTime "2026-03-14 17:00:00" -EndTime "2026-03-14 17:10:00"
```

## 步骤 4：停止 ProcDump 监控
```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\win\stop-procdump-monitor.ps1 -SessionDir .\agent-society-data\crash\procdump\20260314-180000
```

## 产物目录
- WER dump：`agent-society-data\crash\dumps`
- ProcDump dump：`agent-society-data\crash\procdump\<sessionId>\`
- 事件日志：`agent-society-data\crash\events\<timeWindow>\`

## 关闭 WER 配置
```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\win\disable-wer-dumps.ps1
```
