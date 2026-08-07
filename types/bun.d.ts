// Bun 类型声明文件
// 为 bun:test 和其他 Bun 特有 API 提供类型声明

declare module "bun:test" {
  export function describe(name: string, fn: () => void): void;
  export function it(name: string, fn: () => void | Promise<void>): void;
  export function test(name: string, fn: (done?: () => void) => void | Promise<void>, timeout?: number): void;
  export function beforeEach(fn: () => void | Promise<void>): void;
  export function afterEach(fn: () => void | Promise<void>): void;
  export function beforeAll(fn: () => void | Promise<void>, timeout?: number): void;
  export function afterAll(fn: () => void | Promise<void>): void;
  
  // 扩展 expect 类型
  export function expect<T>(value: T): {
    toBe(expected: T): void;
    toEqual(expected: any): void;
    toStrictEqual(expected: any): void;
    toBeNull(): void;
    toBeUndefined(): void;
    toBeDefined(): void;
    toBeTruthy(): void;
    toBeFalsy(): void;
    toBeGreaterThan(expected: number): void;
    toBeGreaterThanOrEqual(expected: number): void;
    toBeLessThan(expected: number): void;
    toBeLessThanOrEqual(expected: number): void;
    toContain(expected: any): void;
    toContainEqual(expected: any): void;
    toHaveLength(expected: number): void;
    toMatch(expected: RegExp | string): void;
    toMatchObject(expected: any): void;
    toThrow(expected?: string | RegExp): void;
    toBeInstanceOf(expected: any): void;
    // 扩展方法
    toBeCloseTo(expected: number, precision?: number): void;
    toHaveProperty(key: string, value?: any): void;
    toHaveBeenCalled(): void;
    toHaveBeenCalledWith(...args: any[]): void;
    toHaveBeenCalledTimes(n: number): void;
    toBeArray(): void;
    toBeTypeOf(type: string): void;
    resolves: any;
    rejects: any;
    not: any;
  };
  
  // vi mock 函数
  export const vi: {
    fn<T extends (...args: any[]) => any>(implementation?: T): Mock<T>;
    spyOn<T extends object, M extends keyof T>(object: T, method: M): SpyInstance<T[M]>;
    clearAllMocks(): void;
    resetAllMocks(): void;
    restoreAllMocks(): void;
  };
  
  interface Mock<T extends (...args: any[]) => any> {
    (...args: Parameters<T>): ReturnType<T>;
    mockReturnValue(value: ReturnType<T>): this;
    mockResolvedValue(value: Awaited<ReturnType<T>>): this;
    mockRejectedValue(value: any): this;
    mockImplementation(fn: T): this;
    mockClear(): void;
    mockReset(): void;
    mockRestore(): void;
    mock: {
      calls: any[][];
    };
  }
  
  interface SpyInstance<T> {
    mockReturnValue(value: T): this;
    mockResolvedValue(value: Awaited<T>): this;
    mockImplementation(fn: (...args: any[]) => T): this;
    mockClear(): void;
    mockRestore(): void;
    mock: {
      calls: any[][];
    };
  }
  
  // test.skip 支持
  export namespace test {
    export function skip(name: string, fn: () => void | Promise<void>): void;
  }
}

declare var Bun: {
  file(path: string): {
    text(): Promise<string>;
    json(): Promise<any>;
    exists(): Promise<boolean>;
  };
  write(path: string, data: string | ArrayBuffer | Uint8Array): Promise<number>;
  glob(pattern: string, options?: { cwd?: string }): AsyncIterable<string>;
};

declare module "bun" {
  export function file(path: string): {
    text(): Promise<string>;
    json(): Promise<any>;
    exists(): Promise<boolean>;
  };
  export function write(path: string, data: string | ArrayBuffer | Uint8Array): Promise<number>;
  export function glob(pattern: string, options?: { cwd?: string }): AsyncIterable<string>;
}

// 扩展 ImportMeta
declare interface ImportMeta {
  dir: string;
  file: string;
  path: string;
  url: string;
  main: boolean;
}

// vitest 兼容层
declare module "vitest" {
  export function describe(name: string, fn: () => void): void;
  export function it(name: string, fn: () => void | Promise<void>): void;
  export function test(name: string, fn: () => void | Promise<void>): void;
  export function beforeEach(fn: () => void | Promise<void>): void;
  export function afterEach(fn: () => void | Promise<void>): void;
  export function beforeAll(fn: () => void | Promise<void>): void;
  export function afterAll(fn: () => void | Promise<void>): void;
  export function expect<T>(value: T): any;
  export const vi: {
    fn<T extends (...args: any[]) => any>(implementation?: T): any;
    spyOn<T extends object, M extends keyof T>(object: T, method: M): any;
    clearAllMocks(): void;
    resetAllMocks(): void;
    restoreAllMocks(): void;
  };
}
