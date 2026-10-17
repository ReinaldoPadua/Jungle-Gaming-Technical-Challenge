import type { Subprocess } from 'bun';

export interface Instance {
  url: string;
  proc: Subprocess;
  post(path: string, body: unknown, headers?: Record<string, string>): Promise<{ status: number; body: any }>;
}

/** Sobe N processos independentes da aplicação e espera todos ficarem prontos. */
export async function spawnInstances(n: number, env: Record<string, string> = {}): Promise<Instance[]> {
  return Promise.all(Array.from({ length: n }, () => spawnInstance(env)));
}

export async function spawnInstance(env: Record<string, string> = {}): Promise<Instance> {
  const proc = Bun.spawn(['bun', 'test/helpers/instance-server.ts'], {
    env: { ...process.env, PORT: '0', DB_POOL_MAX: '10', ...env },
    stdout: 'pipe',
    stderr: 'inherit',
  });
  const reader = proc.stdout.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const deadline = Date.now() + 20_000;
  while (!buffer.includes('READY ')) {
    if (Date.now() > deadline) throw new Error('instance did not become ready');
    const { value, done } = await reader.read();
    if (done) throw new Error(`instance exited early: ${buffer}`);
    buffer += decoder.decode(value);
  }
  reader.releaseLock();
  const url = buffer.match(/READY (\S+)/)![1]!;
  return {
    url,
    proc,
    async post(path, body, headers = {}) {
      const res = await fetch(`${url}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(body),
      });
      return { status: res.status, body: await res.json() };
    },
  };
}

export async function stopInstances(instances: Instance[]): Promise<void> {
  for (const i of instances) i.proc.kill('SIGTERM');
  await Promise.all(instances.map((i) => i.proc.exited));
}

/**
 * Como o processo terminou, de forma portável. No Linux, `exited` de um processo morto por
 * sinal é 128+N (137, 143); no macOS o Bun expõe o sinal em `signalCode` e o código pode diferir.
 */
export async function termination(proc: Subprocess): Promise<{ code: number | null; signal: string | null }> {
  const code = await proc.exited;
  return { code, signal: proc.signalCode == null ? null : String(proc.signalCode) };
}

export const diedBy = (t: { code: number | null; signal: string | null }, signal: 'SIGKILL' | 'SIGTERM') =>
  t.signal === signal || t.code === (signal === 'SIGKILL' ? 137 : 143);
