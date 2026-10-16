/** Subconjunto da Response do Express usado aqui (evita depender de @types/express). */
export interface HttpResponse {
  status(code: number): HttpResponse;
  json(body: unknown): void;
  send(body: unknown): void;
  setHeader(name: string, value: string): void;
}
