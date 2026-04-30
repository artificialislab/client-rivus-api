/**
 * validate middleware — wrapper Zod genérico.
 *
 * Uso:
 *   router.post('/', validateBody(LeadInputSchema), handler)
 *   router.get('/', validateQuery(LeadsListQuerySchema), handler)
 *
 * Se validação passa, sobrescreve req.body / req.query com o objeto
 * tipado (com defaults aplicados, transformações executadas).
 */
import { z } from 'zod';

function formatErrors(error) {
  return error.errors.map((e) => ({
    path: e.path.join('.'),
    message: e.message,
    code: e.code,
  }));
}

function makeValidator(source) {
  return (schema) => (req, res, next) => {
    const result = schema.safeParse(req[source] ?? {});
    if (!result.success) {
      return res.status(400).json({
        error: 'validation_failed',
        source,
        details: formatErrors(result.error),
      });
    }
    req[source] = result.data;
    next();
  };
}

export const validateBody   = makeValidator('body');
export const validateQuery  = makeValidator('query');
export const validateParams = makeValidator('params');

export const UuidParamSchema = z.object({ id: z.string().uuid() });
