#!/usr/bin/env node
/**
 * 测试覆盖率检查脚本
 * 
 * 功能：
 * - 解析 LCOV 覆盖率报告
 * - 检查覆盖率是否达到阈值
 * - 生成覆盖率摘要报告
 * 
 * 使用方法：
 * node scripts/check-coverage.js [--threshold=80] [--lcov-file=coverage/lcov.info]
 */

import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';

// 默认配置
const DEFAULT_THRESHOLD = 80;
const DEFAULT_LCOV_FILE = 'coverage/lcov.info';

/**
 * 解析命令行参数
 */
function parseArgs() {
  const args = process.argv.slice(2);
  const config = {
    threshold: DEFAULT_THRESHOLD,
    lcovFile: DEFAULT_LCOV_FILE,
  };

  for (const arg of args) {
    if (arg.startsWith('--threshold=')) {
      config.threshold = parseFloat(arg.split('=')[1]);
    } else if (arg.startsWith('--lcov-file=')) {
      config.lcovFile = arg.split('=')[1];
    }
  }

  return config;
}

/**
 * 解析 LCOV 文件
 * @param {string} lcovPath - LCOV 文件路径
 * @returns {Object} 覆盖率统计
 */
function parseLcov(lcovPath) {
  if (!existsSync(lcovPath)) {
    console.error(`❌ LCOV 文件不存在: ${lcovPath}`);
    process.exit(1);
  }

  const content = readFileSync(lcovPath, 'utf8');
  const lines = content.split('\n');

  let totalLines = 0;
  let coveredLines = 0;
  let totalFunctions = 0;
  let coveredFunctions = 0;
  let totalBranches = 0;
  let coveredBranches = 0;

  for (const line of lines) {
    // 行覆盖率
    if (line.startsWith('LF:')) {
      totalLines += parseInt(line.substring(3));
    } else if (line.startsWith('LH:')) {
      coveredLines += parseInt(line.substring(3));
    }
    // 函数覆盖率
    else if (line.startsWith('FNF:')) {
      totalFunctions += parseInt(line.substring(4));
    } else if (line.startsWith('FNH:')) {
      coveredFunctions += parseInt(line.substring(4));
    }
    // 分支覆盖率
    else if (line.startsWith('BRF:')) {
      totalBranches += parseInt(line.substring(4));
    } else if (line.startsWith('BRH:')) {
      coveredBranches += parseInt(line.substring(4));
    }
  }

  return {
    lines: {
      total: totalLines,
      covered: coveredLines,
      percentage: totalLines > 0 ? (coveredLines / totalLines) * 100 : 0,
    },
    functions: {
      total: totalFunctions,
      covered: coveredFunctions,
      percentage: totalFunctions > 0 ? (coveredFunctions / totalFunctions) * 100 : 0,
    },
    branches: {
      total: totalBranches,
      covered: coveredBranches,
      percentage: totalBranches > 0 ? (coveredBranches / totalBranches) * 100 : 0,
    },
  };
}

/**
 * 计算总体覆盖率
 * @param {Object} stats - 覆盖率统计
 * @returns {number} 总体覆盖率百分比
 */
function calculateOverallCoverage(stats) {
  // 使用加权平均：行覆盖率权重最高
  const lineWeight = 0.5;
  const functionWeight = 0.3;
  const branchWeight = 0.2;

  return (
    stats.lines.percentage * lineWeight +
    stats.functions.percentage * functionWeight +
    stats.branches.percentage * branchWeight
  );
}

/**
 * 格式化百分比
 * @param {number} percentage - 百分比
 * @returns {string} 格式化后的百分比字符串
 */
function formatPercentage(percentage) {
  return `${percentage.toFixed(2)}%`;
}

/**
 * 生成覆盖率报告
 * @param {Object} stats - 覆盖率统计
 * @param {number} threshold - 覆盖率阈值
 */
function generateReport(stats, threshold) {
  const overall = calculateOverallCoverage(stats);
  const passed = overall >= threshold;

  console.log('\n='.repeat(60));
  console.log('📊 测试覆盖率报告');
  console.log('='.repeat(60));
  console.log();
  console.log('行覆盖率:');
  console.log(`  覆盖: ${stats.lines.covered} / ${stats.lines.total}`);
  console.log(`  百分比: ${formatPercentage(stats.lines.percentage)}`);
  console.log();
  console.log('函数覆盖率:');
  console.log(`  覆盖: ${stats.functions.covered} / ${stats.functions.total}`);
  console.log(`  百分比: ${formatPercentage(stats.functions.percentage)}`);
  console.log();
  console.log('分支覆盖率:');
  console.log(`  覆盖: ${stats.branches.covered} / ${stats.branches.total}`);
  console.log(`  百分比: ${formatPercentage(stats.branches.percentage)}`);
  console.log();
  console.log('='.repeat(60));
  console.log(`总体覆盖率: ${formatPercentage(overall)}`);
  console.log(`覆盖率阈值: ${threshold}%`);
  console.log('='.repeat(60));
  console.log();

  if (passed) {
    console.log(`✅ 覆盖率检查通过！(${formatPercentage(overall)} >= ${threshold}%)`);
    process.exit(0);
  } else {
    console.log(`❌ 覆盖率检查失败！(${formatPercentage(overall)} < ${threshold}%)`);
    console.log(`需要提高 ${formatPercentage(threshold - overall)} 才能达到目标`);
    process.exit(1);
  }
}

/**
 * 主函数
 */
function main() {
  const config = parseArgs();

  console.log('🔍 检查测试覆盖率...');
  console.log(`LCOV 文件: ${config.lcovFile}`);
  console.log(`覆盖率阈值: ${config.threshold}%`);

  const lcovPath = resolve(config.lcovFile);
  const stats = parseLcov(lcovPath);
  generateReport(stats, config.threshold);
}

// 运行主函数
main();
