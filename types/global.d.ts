// 全局类型声明

// Puppeteer DOM 类型
declare var document: Document;
declare var window: Window & typeof globalThis;

declare namespace CSS {
  function escape(ident: string): string;
}

// 通用 DOM 类型
declare type HTMLInputElement = import("puppeteer").ElementHandle<Element>;
declare type HTMLTextAreaElement = import("puppeteer").ElementHandle<Element>;

// 类型辅助
declare type TypedArray = 
  | Int8Array
  | Uint8Array
  | Uint8ClampedArray
  | Int16Array
  | Uint16Array
  | Int32Array
  | Uint32Array
  | Float32Array
  | Float64Array
  | BigInt64Array
  | BigUint64Array;

// 扩展 Array 类型以包含 ES2023 方法
declare interface Array<T> {
  findLastIndex(predicate: (value: T, index: number, obj: T[]) => boolean, thisArg?: any): number;
}

// hmemory 模块声明
declare module "hmemory" {
  export interface MemoryConfig {
    embeddingDim?: number;
    maxResults?: number;
  }
  
  export class Memory {
    constructor(config?: MemoryConfig);
    add(entry: { content: string; metadata?: any }): Promise<void>;
    search(query: string, options?: { limit?: number }): Promise<Array<{ content: string; score: number; metadata?: any }>>;
    delete(id: string): Promise<void>;
    clear(): Promise<void>;
  }
  
  export class AgentMemory {
    constructor(agentId: string, config?: MemoryConfig);
    add(entry: { content: string; metadata?: any }): Promise<void>;
    search(query: string, options?: { limit?: number }): Promise<Array<{ content: string; score: number; metadata?: any }>>;
    save(): Promise<void>;
    load(): Promise<void>;
  }
}

// logger 模块声明（用于 http_client.js）
declare module "./logger.js" {
  export function createModuleLogger(name: string): any;
}

// AutoCompressionConfig 类型
declare interface AutoCompressionConfig {
  enabled: boolean;
  threshold?: number;
  ratio?: number;
}
