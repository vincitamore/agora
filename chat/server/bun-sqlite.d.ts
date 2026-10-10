// The part of Bun's built-in SQLite the kit store uses, declared here so the kit carries no
// dependency for its types (`bun:sqlite` ships with the runtime; its types ship with bun-types).
declare module "bun:sqlite" {
  export type SQLValue = string | number | bigint | boolean | null | Uint8Array;
  export interface Statement<Row = Record<string, any>> {
    all(...params: SQLValue[]): Row[];
    get(...params: SQLValue[]): Row | null;
    run(...params: SQLValue[]): { changes: number, lastInsertRowid: number | bigint };
    finalize(): void;
  }
  export class Database {
    constructor(filename?: string, options?: { create?: boolean, readwrite?: boolean, readonly?: boolean, strict?: boolean });
    query<Row = Record<string, any>>(sql: string): Statement<Row>;
    prepare<Row = Record<string, any>>(sql: string): Statement<Row>;
    run(sql: string, ...params: SQLValue[]): { changes: number, lastInsertRowid: number | bigint };
    exec(sql: string): void;
    transaction<A extends any[], R>(fn: (...args: A) => R): (...args: A) => R;
    clearQueryCache(): void;
    close(throwOnError?: boolean): void;
  }
}
