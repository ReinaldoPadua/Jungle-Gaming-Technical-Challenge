import { z } from 'zod';

/**
 * Contratos de entrada. `amount` é SEMPRE string — um number no JSON é rejeitado
 * já aqui (a validação fina de formato/escala fica no Money do domínio).
 */
export const MoneySchema = z
  .object({
    amount: z.string({ invalid_type_error: 'amount must be a decimal string, not a number' }),
    currency: z.string(),
  })
  .strict();

export const UuidParam = z.string().uuid({ message: 'must be a UUID' });

export const CorrelationIdHeader = z
  .string()
  .max(128)
  .regex(/^[\w.:-]+$/)
  .optional();
