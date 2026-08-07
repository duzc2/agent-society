import { spawn } from "node:child_process";

/**
 * 按目标平台规范化路径分隔符。
 * 这里不能依赖当前 Node 进程所在平台，否则跨平台测试会得到错误结果。
 *
 * @param {NodeJS.Platform | string} platformName 目标平台
 * @param {string} targetPath 原始路径
 * @returns {string}
 */
function normalizeTargetPathForPlatform(platformName, targetPath) {
  if (platformName === "win32") {
    return targetPath.replace(/\//g, "\\");
  }

  return targetPath.replace(/\\/g, "/");
}

/**
 * 根据目标平台判断路径是否为绝对路径。
 * 这里显式兼容 Windows 盘符路径与 UNC 路径，避免把合法路径误判为相对路径。
 *
 * @param {NodeJS.Platform | string} platformName 目标平台
 * @param {string} targetPath 待校验路径
 * @returns {boolean}
 */
function isAbsolutePathForPlatform(platformName, targetPath) {
  if (platformName === "win32") {
    return /^[a-zA-Z]:[\\/]/.test(targetPath) || targetPath.startsWith("\\\\");
  }

  return targetPath.startsWith("/");
}

/**
 * 转义 Windows `cmd /c start` 所需的双引号。
 * 这里只处理参数中的引号，空格由 start 的参数引号负责保护。
 *
 * @param {string} targetPath 目标路径
 * @returns {string}
 */
function escapeWindowsStartArgument(targetPath) {
  return targetPath.replace(/"/g, '""');
}

/**
 * 计算当前平台打开文件管理器所需的命令、参数与附加启动选项。
 * Windows 使用 `cmd /c start`，避免直接拉起 `explorer.exe` 时出现无前台窗口的情况。
 *
 * @param {NodeJS.Platform | string} platformName 当前运行平台
 * @param {string} targetPath 需要打开的绝对路径
 * @returns {{command: string, args: string[], spawnOptions?: Record<string, any>}}
 */
export function getFileManagerLaunchSpec(platformName, targetPath) {
  const normalizedPath = normalizeTargetPathForPlatform(platformName, targetPath);

  switch (platformName) {
    case "win32": {
      const escapedPath = escapeWindowsStartArgument(normalizedPath);
      return {
        command: "cmd.exe",
        args: ["/d", "/s", "/c", `start "" "${escapedPath}"`],
        spawnOptions: {
          windowsVerbatimArguments: true
        }
      };
    }
    case "darwin":
      return {
        command: "open",
        args: [normalizedPath]
      };
    default:
      return {
        command: "xdg-open",
        args: [normalizedPath]
      };
  }
}

/**
 * 调用系统文件管理器打开指定目录。
 * 该函数只接受绝对路径，避免未校验的相对路径直接进入系统命令。
 *
 * @param {string} targetPath 需要打开的绝对目录路径
 * @param {{platform?: NodeJS.Platform | string, spawnImpl?: typeof spawn}} [options] 可选测试注入项
 * @returns {Promise<void>}
 */
export function openPathInFileManager(targetPath, options = {}) {
  if (typeof targetPath !== "string" || targetPath.trim() === "") {
    throw new Error("invalid_target_path");
  }

  const platformName = options.platform ?? process.platform;
  if (!isAbsolutePathForPlatform(platformName, targetPath)) {
    throw new Error("target_path_must_be_absolute");
  }

  const spawnImpl = options.spawnImpl ?? spawn;
  const spec = getFileManagerLaunchSpec(platformName, targetPath);

  return new Promise((resolve, reject) => {
    let settled = false;
    const child = spawnImpl(spec.command, spec.args, {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      ...(spec.spawnOptions ?? {})
    });

    /**
     * 在系统成功接管启动后立刻结束等待，避免调用方被资源管理器生命周期阻塞。
     */
    const handleSpawn = () => {
      if (settled) {
        return;
      }

      settled = true;
      child.unref?.();
      resolve();
    };

    /**
     * 统一把系统层启动失败转换成普通错误，交由上层处理。
     *
     * @param {Error} error 启动错误
     */
    const handleError = (error) => {
      if (settled) {
        return;
      }

      settled = true;
      reject(error);
    };

    child.once("spawn", handleSpawn);
    child.once("error", handleError);
  });
}
