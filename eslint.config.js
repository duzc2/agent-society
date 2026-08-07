import { defineConfig } from "eslint/config";
import js from "@eslint/js";
import globals from "globals";

export default defineConfig([
  {
    files: ["**/*.{js,mjs,cjs}"],
    plugins: {
      js: js
    },
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.browser
      }
    }
  },
  {
    files: ["**/*.{js,mjs,cjs}"],
    rules: {
      // 基础规则
      "no-unused-vars": "warn",
      "no-undef": "error",
      "no-console": "off",
      "no-debugger": "error",
      
      // 最佳实践
      "eqeqeq": ["error", "always"],
      "curly": ["error", "all"],
      "no-throw-literal": "error",
      "prefer-const": "warn",
      
      // 风格
      "semi": ["error", "always"],
      "quotes": ["warn", "double", { "avoidEscape": true }],
      "indent": ["warn", 2, { "SwitchCase": 1 }]
    }
  },
  {
    // 测试文件特殊配置
    files: ["test/**/*.{js,mjs,cjs}"],
    languageOptions: {
      globals: {
        ...globals.node,
        describe: "readonly",
        it: "readonly",
        test: "readonly",
        expect: "readonly",
        beforeEach: "readonly",
        afterEach: "readonly",
        beforeAll: "readonly",
        afterAll: "readonly"
      }
    }
  },
  {
    // 忽略文件
    ignores: [
      "node_modules/**",
      "coverage/**",
      "data/**",
      ".tmp/**",
      "web/**",
      "dist/**"
    ]
  }
]);
