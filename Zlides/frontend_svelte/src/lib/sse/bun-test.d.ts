declare module "bun:test" {
  export function describe(name: string, fn: () => void): void;
  export function test(name: string, fn: () => void): void;
  export function expect(actual: unknown): {
    toBe(expected: unknown): void;
    toEqual(expected: unknown): void;
    toHaveLength(length: number): void;
    toContain(expected: string): void;
    toBeGreaterThan(expected: number): void;
    toBeLessThan(expected: number): void;
    not: {
      toBe(expected: unknown): void;
      toContain(expected: string): void;
    };
  };
}

interface ImportMeta {
  readonly dir: string;
}

declare module "node:fs" {
  export function readFileSync(path: string, encoding: "utf8"): string;
}
