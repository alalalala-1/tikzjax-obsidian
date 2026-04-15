declare module 'pako' {
  export class Inflate {
    err: number;
    msg?: string;
    result: Uint8Array;
    push(data: Uint8Array, mode?: boolean): void;
  }
}
