/**
 * 配置管理器
 *
 * 职责：
 * - 管理自动化模块配置
 * - 通过 configService 注册默认值、加载合并配置、持久化变更
 * - 提供配置查询接口
 */

const DEFAULTS = {
  enabled: false,
  allowMouse: false,
  allowKeyboard: false,
  allowAccessibility: false,
  restrictedRegions: [],
  requireConfirmation: false,
  logAllActions: true
};

/**
 * 配置管理器类
 */
export class ConfigManager {
  /**
   * @param {{configService: any, log: any}} options
   */
  constructor(options) {
    this.configService = options.configService;
    this.log = options.log;

    /** @type {boolean} */
    this.enabled = false;

    /** @type {boolean} */
    this.allowMouse = false;

    /** @type {boolean} */
    this.allowKeyboard = false;

    /** @type {boolean} */
    this.allowAccessibility = false;

    /** @type {Array<{x: number, y: number, width: number, height: number, reason: string}>} */
    this.restrictedRegions = [];

    /** @type {boolean} */
    this.requireConfirmation = false;

    /** @type {boolean} */
    this.logAllActions = true;

    /** @type {boolean} */
    this._initialized = false;
  }

  /**
   * 初始化：注册默认值 → 与 config/modules/automation.json 合并 → 应用到实例
   */
  async init() {
    if (this._initialized) return;

    if (this.configService) {
      this.configService.registerModuleConfig('automation', DEFAULTS);
      const merged = await this.configService.getModuleConfig('automation');
      this.enabled = merged.enabled;
      this.allowMouse = merged.allowMouse;
      this.allowKeyboard = merged.allowKeyboard;
      this.allowAccessibility = merged.allowAccessibility;
      this.restrictedRegions = Array.isArray(merged.restrictedRegions) ? [...merged.restrictedRegions] : [];
      this.requireConfirmation = merged.requireConfirmation;
      this.logAllActions = merged.logAllActions;
    }

    this._initialized = true;

    this.log.info("[Automation] 配置管理器初始化完成", {
      enabled: this.enabled,
      allowMouse: this.allowMouse,
      allowKeyboard: this.allowKeyboard,
      allowAccessibility: this.allowAccessibility
    });
  }

  /**
   * 持久化当前配置到 configService
   * @private
   */
  async _persist() {
    if (!this.configService) return;

    try {
      await this.configService.saveModuleConfig('automation', {
        enabled: this.enabled,
        allowMouse: this.allowMouse,
        allowKeyboard: this.allowKeyboard,
        allowAccessibility: this.allowAccessibility,
        restrictedRegions: this.restrictedRegions,
        requireConfirmation: this.requireConfirmation,
        logAllActions: this.logAllActions
      });
    } catch (error) {
      this.log.error("[Automation] 保存配置失败", { error: error.message });
    }
  }

  /**
   * 更新配置
   * @param {object} updates
   * @returns {Promise<{ok: boolean, error?: string}>}
   */
  async updateConfig(updates) {
    try {
      if (updates.enabled !== undefined) this.enabled = Boolean(updates.enabled);
      if (updates.allowMouse !== undefined) this.allowMouse = Boolean(updates.allowMouse);
      if (updates.allowKeyboard !== undefined) this.allowKeyboard = Boolean(updates.allowKeyboard);
      if (updates.allowAccessibility !== undefined) this.allowAccessibility = Boolean(updates.allowAccessibility);
      if (updates.requireConfirmation !== undefined) this.requireConfirmation = Boolean(updates.requireConfirmation);
      if (updates.logAllActions !== undefined) this.logAllActions = Boolean(updates.logAllActions);
      if (Array.isArray(updates.restrictedRegions)) this.restrictedRegions = [...updates.restrictedRegions];

      await this._persist();
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  }

  /**
   * 获取当前配置
   * @returns {object}
   */
  getConfig() {
    return {
      enabled: this.enabled,
      allowMouse: this.allowMouse,
      allowKeyboard: this.allowKeyboard,
      allowAccessibility: this.allowAccessibility,
      restrictedRegions: [...this.restrictedRegions],
      requireConfirmation: this.requireConfirmation,
      logAllActions: this.logAllActions
    };
  }

  /**
   * 检查坐标是否在受限区域内
   * @param {number} x
   * @param {number} y
   * @returns {{restricted: boolean, reason?: string}}
   */
  checkRestrictedRegion(x, y) {
    for (const region of this.restrictedRegions) {
      if (x >= region.x && x <= region.x + region.width &&
          y >= region.y && y <= region.y + region.height) {
        return { restricted: true, reason: region.reason };
      }
    }
    return { restricted: false };
  }
}

export default ConfigManager;
