/**
 * Tiny builder for JSON Schemas that OpenAI "strict" structured outputs accept:
 * every object has additionalProperties:false and lists every property as required
 * (optional values are expressed as nullable). Keeps feature code short and correct.
 *
 *   const Out = S.obj({ title: S.str('Headline'), rooms: S.arr(S.str()), price: S.nullable(S.num()) })
 *   type Out = Infer<typeof Out>
 */
export type Schema =
  | { type: 'string'; description?: string; enum?: readonly string[] }
  | { type: 'number' | 'integer' | 'boolean'; description?: string }
  | { type: 'array'; items: Schema; description?: string }
  | { type: 'object'; properties: Record<string, Schema>; required: string[]; additionalProperties: false; description?: string }
  | { anyOf: Schema[]; description?: string };

type Str<E extends string = string> = { type: 'string'; description?: string; enum?: readonly E[]; __t?: E };
type Num = { type: 'number' | 'integer'; description?: string; __t?: number };
type Bool = { type: 'boolean'; description?: string; __t?: boolean };
type Arr<I> = { type: 'array'; items: I; description?: string; __t?: InferT<I>[] };
type Obj<P extends Record<string, unknown>> = { type: 'object'; properties: P; required: string[]; additionalProperties: false; description?: string; __t?: { [K in keyof P]: InferT<P[K]> } };
type Nullable<T> = { anyOf: [T, { type: 'null' }]; description?: string; __t?: InferT<T> | null };
type InferT<T> = T extends { __t?: infer U } ? U : unknown;
export type Infer<T> = InferT<T>;

export const S = {
  str: (description?: string): Str => ({ type: 'string', ...(description ? { description } : {}) }),
  enum: <E extends string>(values: readonly E[], description?: string): Str<E> => ({ type: 'string', enum: values, ...(description ? { description } : {}) }),
  num: (description?: string): Num => ({ type: 'number', ...(description ? { description } : {}) }),
  int: (description?: string): Num => ({ type: 'integer', ...(description ? { description } : {}) }),
  bool: (description?: string): Bool => ({ type: 'boolean', ...(description ? { description } : {}) }),
  arr: <I>(items: I, description?: string): Arr<I> => ({ type: 'array', items, ...(description ? { description } : {}) }),
  obj: <P extends Record<string, unknown>>(properties: P, description?: string): Obj<P> =>
    ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false, ...(description ? { description } : {}) }),
  nullable: <T>(inner: T, description?: string): Nullable<T> => ({ anyOf: [inner, { type: 'null' }], ...(description ? { description } : {}) }),
};

/** Validates a parsed value against a schema built with S (defence in depth after strict mode). */
export function conforms(schema: unknown, v: unknown): boolean {
  const s = schema as Record<string, unknown>;
  if (Array.isArray(s.anyOf)) return (s.anyOf as unknown[]).some((x) => conforms(x, v));
  switch (s.type) {
    case 'null': return v === null;
    case 'string': return typeof v === 'string' && (!s.enum || (s.enum as string[]).includes(v));
    case 'number': return typeof v === 'number' && Number.isFinite(v);
    case 'integer': return typeof v === 'number' && Number.isInteger(v);
    case 'boolean': return typeof v === 'boolean';
    case 'array': return Array.isArray(v) && v.every((x) => conforms(s.items, x));
    case 'object': {
      if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
      const props = s.properties as Record<string, unknown>;
      return Object.keys(props).every((k) => k in (v as object) && conforms(props[k], (v as Record<string, unknown>)[k]));
    }
    default: return true;
  }
}
