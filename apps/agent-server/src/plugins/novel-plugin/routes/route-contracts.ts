import { Type } from 'typebox'

export const emptyParamsSchema = Type.Object({}, { additionalProperties: true })
export const emptyQuerySchema = Type.Object({}, { additionalProperties: true })

export const standardResponseSchema = {
  200: Type.Any(),
  400: Type.Any(),
  404: Type.Any(),
  409: Type.Any(),
}

/**
 * Registration-boundary guard for legacy route families that still own their
 * detailed Zod validation in the handler. This keeps Fastify's route metadata
 * complete while those families migrate to field-level TypeBox contracts.
 */
export function completeRouteContracts<T extends { method: string; path: string; schema?: Record<string, any> }>(
  routes: T[],
): T[] {
  return routes.map((route) => {
    const params = [...route.path.matchAll(/:([A-Za-z0-9_]+)/g)].reduce<Record<string, any>>((shape, match) => {
      shape[match[1]!] = Type.String({ minLength: 1 })
      return shape
    }, {})
    const existing = route.schema ?? {}
    return {
      ...route,
      schema: {
        params: existing.params ?? Type.Object(params, { additionalProperties: true }),
        querystring: existing.querystring ?? emptyQuerySchema,
        ...(existing.body || ['POST', 'PUT', 'PATCH'].includes(route.method)
          ? { body: existing.body ?? Type.Any() }
          : {}),
        response: existing.response ?? standardResponseSchema,
        ...existing,
      },
    }
  })
}
