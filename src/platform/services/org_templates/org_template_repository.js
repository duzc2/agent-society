import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

export class OrgTemplateRepository {
  /**
   * @param {{baseDir?: string, userBaseDir?: string, logger?: any}} [options]
   */
  constructor(options = {}) {
    this.baseDir = options.baseDir ? path.resolve(options.baseDir) : path.resolve(process.cwd(), "org");
    this.userBaseDir = options.userBaseDir ? path.resolve(options.userBaseDir) : null;
    this.log = options.logger;
  }

  isValidOrgName(orgName) {
    return typeof orgName === "string" && /^[A-Za-z0-9_-]+$/.test(orgName);
  }

  async listOrgNames() {
    const names = new Set();

    if (this.userBaseDir) {
      try {
        const userEntries = await fs.readdir(this.userBaseDir, { withFileTypes: true });
        for (const entry of userEntries) {
          if (!entry.isDirectory()) continue;
          if (!this.isValidOrgName(entry.name)) {
            void this.log.warn("跳过非法组织模板目录名（用户层）", { orgName: entry.name });
            continue;
          }
          names.add(entry.name);
        }
      } catch (err) {
        if (!(err && err.code === "ENOENT")) throw err;
      }
    }

    try {
      const entries = await fs.readdir(this.baseDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (!this.isValidOrgName(entry.name)) {
          void this.log.warn("跳过非法组织模板目录名", { orgName: entry.name });
          continue;
        }
        names.add(entry.name);
      }
    } catch (err) {
      if (!(err && err.code === "ENOENT")) throw err;
    }

    const sorted = Array.from(names).sort((a, b) => a.localeCompare(b));
    return sorted;
  }

  async listTemplateInfos() {
    const orgNames = await this.listOrgNames();
    const templates = [];
    for (const orgName of orgNames) {
      try {
        const infoMd = await this.readInfo(orgName);
        templates.push({ orgName, infoMd });
      } catch (err) {
        if (err && err.code === "ENOENT") {
          void this.log.warn("组织模板缺少 info.md，已跳过", { orgName });
          continue;
        }
        throw err;
      }
    }
    return templates;
  }

  async readInfo(orgName) {
    return await this._readFile(orgName, "info.md");
  }

  async writeInfo(orgName, infoMd) {
    if (typeof infoMd !== "string") throw Object.assign(new Error("infoMd 必须是字符串"), { code: "INVALID_INPUT" });
    await this._writeFile(orgName, "info.md", infoMd);
  }

  async readOrg(orgName) {
    return await this._readFile(orgName, "org.md");
  }

  async writeOrg(orgName, orgMd) {
    if (typeof orgMd !== "string") throw Object.assign(new Error("orgMd 必须是字符串"), { code: "INVALID_INPUT" });
    await this._writeFile(orgName, "org.md", orgMd);
  }

  async createTemplate(orgName) {
    this._assertOrgName(orgName);
    const targetDir = this.userBaseDir ?? this.baseDir;
    await fs.mkdir(targetDir, { recursive: true });

    // Check if org already exists in either layer
    if (this.userBaseDir) {
      const existing = await this.listOrgNames();
      if (existing.includes(orgName)) {
        throw Object.assign(new Error("组织模板已存在"), { code: "EEXIST" });
      }
    }

    const dir = path.join(targetDir, orgName);
    await fs.mkdir(dir, { recursive: false });
    await fs.writeFile(path.join(dir, "info.md"), "", "utf8");
    await fs.writeFile(path.join(dir, "org.md"), "", "utf8");
    return { ok: true, orgName };
  }

  async deleteTemplate(orgName) {
    this._assertOrgName(orgName);

    if (!this.userBaseDir) {
      // Single-layer: delete from baseDir
      return await this._deleteFromDir(orgName, this.baseDir);
    }

    // Dual-layer: check what exists where
    const inDefault = await this._dirExists(path.join(this.baseDir, orgName));
    const inUser = await this._dirExists(path.join(this.userBaseDir, orgName));

    if (!inDefault && !inUser) {
      throw Object.assign(new Error("组织模板不存在"), { code: "ENOENT" });
    }

    if (inDefault && !inUser) {
      throw Object.assign(new Error("不能删除内置模板"), { code: "CANNOT_DELETE_BUILTIN" });
    }

    // Delete user layer (whether or not default also exists)
    return await this._deleteFromDir(orgName, this.userBaseDir);
  }

  async renameTemplate(orgName, newOrgName) {
    this._assertOrgName(orgName);
    this._assertOrgName(newOrgName);
    if (orgName === newOrgName) return { ok: true, orgName };

    const targetDir = this.userBaseDir ?? this.baseDir;

    // For dual-layer: only allow rename on user-layer dirs
    if (this.userBaseDir) {
      const inUser = await this._dirExists(path.join(this.userBaseDir, orgName));
      if (!inUser) {
        throw Object.assign(new Error("不能对内置模板重命名"), { code: "CANNOT_RENAME_BUILTIN" });
      }
    }

    await fs.mkdir(targetDir, { recursive: true });

    const fromDir = path.join(targetDir, orgName);
    const toDir = path.join(targetDir, newOrgName);
    const resolvedFrom = path.resolve(fromDir);
    const resolvedTo = path.resolve(toDir);
    const resolvedBase = path.resolve(targetDir);
    if (!resolvedFrom.startsWith(resolvedBase + path.sep) || !resolvedTo.startsWith(resolvedBase + path.sep)) {
      throw Object.assign(new Error("非法重命名路径"), { code: "INVALID_PATH" });
    }

    await fs.rename(resolvedFrom, resolvedTo);
    return { ok: true, oldOrgName: orgName, orgName: newOrgName };
  }

  /**
   * Gets the canonical directory for a resolved org name (user layer wins, then default).
   * Used internally and by external consumers that need the actual fs path.
   */
  _resolveOrgDir(orgName) {
    if (this.userBaseDir) {
      return path.join(this.userBaseDir, orgName);
    }
    return path.join(this.baseDir, orgName);
  }

  _assertOrgName(orgName) {
    if (!this.isValidOrgName(orgName)) {
      throw Object.assign(new Error("orgName 非法，只允许字母数字下划线短横线"), { code: "INVALID_ORG_NAME" });
    }
  }

  async _readFile(orgName, filename) {
    this._assertOrgName(orgName);
    if (this.userBaseDir) {
      const userPath = path.join(this.userBaseDir, orgName, filename);
      try {
        return await fs.readFile(userPath, "utf8");
      } catch (err) {
        if (!(err && err.code === "ENOENT")) throw err;
      }
    }
    const filePath = path.join(this.baseDir, orgName, filename);
    return await fs.readFile(filePath, "utf8");
  }

  async _writeFile(orgName, filename, content) {
    this._assertOrgName(orgName);
    const targetDir = this.userBaseDir ?? this.baseDir;
    const dir = path.join(targetDir, orgName);
    await fs.mkdir(dir, { recursive: true });
    const filePath = path.join(dir, filename);
    await this._atomicWriteUtf8(filePath, content);
  }

  async _deleteFromDir(orgName, base) {
    const targetDir = path.join(base, orgName);
    const resolvedTarget = path.resolve(targetDir);
    const resolvedBase = path.resolve(base);
    if (!resolvedTarget.startsWith(resolvedBase + path.sep)) {
      throw Object.assign(new Error("非法删除路径"), { code: "INVALID_PATH" });
    }
    await fs.rm(resolvedTarget, { recursive: true, force: false });
    return { ok: true, orgName };
  }

  async _dirExists(dirPath) {
    try {
      const stat = await fs.stat(dirPath);
      return stat.isDirectory();
    } catch (err) {
      if (err && err.code === "ENOENT") return false;
      throw err;
    }
  }

  async _atomicWriteUtf8(filePath, content) {
    const dir = path.dirname(filePath);
    const tmpPath = path.join(dir, `${path.basename(filePath)}.${randomUUID()}.tmp`);
    await fs.writeFile(tmpPath, content, "utf8");
    try {
      await fs.unlink(filePath);
    } catch (err) {
      if (!(err && err.code === "ENOENT")) throw err;
    }
    await fs.rename(tmpPath, filePath);
  }
}
