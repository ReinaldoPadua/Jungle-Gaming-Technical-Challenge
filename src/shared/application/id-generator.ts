/** Gera ids ordenáveis no tempo (UUID v7): bons para índices B-tree e logs. */
export interface IdGenerator {
  next(): string;
}
export const ID_GENERATOR = Symbol('ID_GENERATOR');
export const uuidV7Generator: IdGenerator = { next: () => Bun.randomUUIDv7() };
