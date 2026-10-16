/**
 * JSON canônico: chaves de objeto ordenadas lexicograficamente (code points),
 * recursivamente; arrays preservam ordem; propriedades `undefined` omitidas;
 * sem espaços. Aceita apenas string, boolean, null, objetos simples e arrays —
 * números são rejeitados de propósito (nenhum campo de negócio do hash é numérico,
 * e isso elimina ambiguidades como 1 vs 1.0).
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return JSON.stringify(value);
    case 'object': {
      if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
      const proto = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null) {
        throw new TypeError(`canonicalJson: unsupported object type ${proto?.constructor?.name ?? 'unknown'}`);
      }
      const entries = Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
      return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
    }
    default:
      throw new TypeError(`canonicalJson: unsupported value type ${typeof value}`);
  }
}
