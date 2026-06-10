declare module 'tunnelmole' {
  export function tunnelmole(options: { port: number | string; [key: string]: unknown }): Promise<string>;
}
