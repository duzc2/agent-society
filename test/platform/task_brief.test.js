import { describe, test } from "node:test";
import assert from "node:assert";
import fc from "fast-check";
import { validateTaskBrief, formatTaskBrief } from "../../src/platform/utils/message/task_brief.js";

describe("TaskBrief", () => {
  /**
   * Property 1: Task Brief 验证
   * *For any* Task_Brief 对象，如果缺少任何必填字段（objective、constraints、inputs、outputs、completion_criteria），
   * validateTaskBrief 函数应返回 valid=false 并列出所有缺失字段
   *
   * **Validates: Requirements 1.2, 1.4**
   * **Feature: agent-communication-protocol, Property 1: Task Brief 验证**
   */
  test("Property 1: Task Brief 验证 - 缺少必填字段时应返回 valid=false", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          objective: fc.option(fc.string({ minLength: 1 }), { nil: undefined }),
          constraints: fc.option(fc.array(fc.string()), { nil: undefined }),
          inputs: fc.option(fc.string({ minLength: 1 }), { nil: undefined }),
          outputs: fc.option(fc.string({ minLength: 1 }), { nil: undefined }),
          completion_criteria: fc.option(fc.string({ minLength: 1 }), { nil: undefined })
        }),
        async (taskBrief) => {
          const result = validateTaskBrief(taskBrief);

          const hasMissingFields =
            taskBrief.objective === undefined ||
            taskBrief.constraints === undefined ||
            taskBrief.inputs === undefined ||
            taskBrief.outputs === undefined ||
            taskBrief.completion_criteria === undefined;

          // 验证：valid 应该等于 !hasMissingFields
          assert.strictEqual(result.valid, !hasMissingFields);

          // 验证：如果有缺失字段，errors 应该包含对应的错误信？
          if (hasMissingFields) {
            assert.ok(result.errors.length > 0);

            if (taskBrief.objective === undefined) {
              assert.strictEqual(result.errors.some(e => e.includes('objective')), true);
            }
            if (taskBrief.constraints === undefined) {
              assert.strictEqual(result.errors.some(e => e.includes('constraints')), true);
            }
            if (taskBrief.inputs === undefined) {
              assert.strictEqual(result.errors.some(e => e.includes('inputs')), true);
            }
            if (taskBrief.outputs === undefined) {
              assert.strictEqual(result.errors.some(e => e.includes('outputs')), true);
            }
            if (taskBrief.completion_criteria === undefined) {
              assert.strictEqual(result.errors.some(e => e.includes('completion_criteria')), true);
            }
          } else {
            assert.strictEqual(result.errors.length, 0);
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  test("Property 1: Task Brief 验证 - constraints 必须是数组", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          objective: fc.string({ minLength: 1 }),
          constraints: fc.oneof(
            fc.array(fc.string()),  // 有效：数组
            fc.string(),            // 无效：字符串
            fc.integer(),           // 无效：数字
            fc.record({})           // 无效：对象
          ),
          inputs: fc.string({ minLength: 1 }),
          outputs: fc.string({ minLength: 1 }),
          completion_criteria: fc.string({ minLength: 1 })
        }),
        async (taskBrief) => {
          const result = validateTaskBrief(taskBrief);
          const constraintsIsArray = Array.isArray(taskBrief.constraints);

          if (!constraintsIsArray) {
            assert.strictEqual(result.valid, false);
            assert.strictEqual(result.errors.some(e => e.includes('constraints') && e.includes('数组')), true);
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  test("Property 1: Task Brief 验证 - null 和非对象输入应返回错误", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.oneof(
          fc.constant(null),
          fc.constant(undefined),
          fc.string(),
          fc.integer(),
          fc.array(fc.anything())
        ),
        async (invalidInput) => {
          const result = validateTaskBrief(invalidInput);
          assert.strictEqual(result.valid, false);
          assert.ok(result.errors.length > 0);
        }
      ),
      { numRuns: 100 }
    );
  });

  test("完整有效的 TaskBrief 应通过验证", () => {
    const validTaskBrief = {
      objective: "创建一个简单的计算器程序",
      constraints: ["使用 HTML + JavaScript 实现", "必须是静态网页"],
      inputs: "用户通过网页界面输入数字和运算符",
      outputs: "在网页上显示计算结果",
      completion_criteria: "计算器能正确执行加减乘除运算"
    };

    const result = validateTaskBrief(validTaskBrief);
    assert.strictEqual(result.valid, true);
    assert.strictEqual(result.errors.length, 0);
  });
});

describe("formatTaskBrief", () => {
  test("格式化完整的 TaskBrief 应包含所有字段", () => {
    const taskBrief = {
      objective: "创建一个简单的计算器程序",
      constraints: ["使用 HTML + JavaScript 实现", "必须是静态网页"],
      inputs: "用户通过网页界面输入数字和运算符",
      outputs: "在网页上显示计算结果",
      completion_criteria: "计算器能正确执行加减乘除运算",
      collaborators: [
        { agentId: "agent-ui", role: "UI设计师", description: "界面设计支持" }
      ],
      references: ["参考现有计算器应用"],
      priority: "high"
    };

    const formatted = formatTaskBrief(taskBrief);

    // 验证包含标题
    assert.ok(formatted.includes("【任务委托书 Task Brief】"));

    // 验证包含必填字段
    assert.ok(formatted.includes("## 目标描述"));
    assert.ok(formatted.includes(taskBrief.objective));
    assert.ok(formatted.includes("## 技术约束"));
    assert.ok(formatted.includes("使用 HTML + JavaScript 实现"));
    assert.ok(formatted.includes("必须是静态网页"));
    assert.ok(formatted.includes("## 输入说明"));
    assert.ok(formatted.includes(taskBrief.inputs));
    assert.ok(formatted.includes("## 输出要求"));
    assert.ok(formatted.includes(taskBrief.outputs));
    assert.ok(formatted.includes("## 完成标准"));
    assert.ok(formatted.includes(taskBrief.completion_criteria));

    // 验证包含可选字段
    assert.ok(formatted.includes("## 参考资料"));
    assert.ok(formatted.includes("参考现有计算器应用"));
    assert.ok(formatted.includes("## 优先级"));
    assert.ok(formatted.includes("high"));
  });

  test("格式化 null 或非对象输入应返回空字符串", () => {
    assert.strictEqual(formatTaskBrief(null), "");
    assert.strictEqual(formatTaskBrief(undefined), "");
    assert.strictEqual(formatTaskBrief("string"), "");
    assert.strictEqual(formatTaskBrief(123), "");
  });

  test("格式化只有部分字段的 TaskBrief 应只包含存在的字段", () => {
    const partialTaskBrief = {
      objective: "测试目标",
      constraints: ["约束1"]
    };

    const formatted = formatTaskBrief(partialTaskBrief);

    assert.ok(formatted.includes("## 目标描述"));
    assert.ok(formatted.includes("测试目标"));
    assert.ok(formatted.includes("## 技术约束"));
    assert.ok(formatted.includes("约束1"));
    assert.ok(!formatted.includes("## 输入说明"));
    assert.ok(!formatted.includes("## 输出要求"));
    assert.ok(!formatted.includes("## 完成标准"));
  });
});
