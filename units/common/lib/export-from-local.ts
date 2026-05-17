const LOCAL_SECRET = 42;

export { LOCAL_SECRET as PUBLIC_VALUE };

export function doubleLocal(n: number): number {
  return n * 2;
}
