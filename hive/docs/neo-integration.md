# BTCLABS · NEO — integración en Munder Difflin

> Módulo añadido a `src/shared/integrations.ts` (plantilla `custom-rest` → `INTEGRATION_TEMPLATES`).
> Contrato descrito a nivel de **worker** (cómo un agente del piso llama a NEO). No toca broker ni registry.

## Qué añade
NEO (el director multi-agente local de BTCLABS, `http://127.0.0.1:8830`) aparece en el catálogo de
integraciones del piso como **`BTCLABS · NEO`** (`idSuggestion: neo`). Es **loopback `http`** (permitido
por `validateBaseUrl` para `custom-rest` locales) y **`authType: none`** → no pide key para los GET abiertos.

## Endpoints que un worker puede llamar
| Ruta | Método | Qué da | Auth |
|---|---|---|---|
| `/api/health` | GET | sondeo de los 9 servicios BTCLABS (array `services` + `up`) | abierto |
| `/api/state` | GET | estado del motor NEO (equity, nivel, posición, fuel) | abierto |
| `/api/usage` | GET | **fuel real** de clau (5h/7d) + director (saldo DeepSeek) + gpt | abierto |
| `/api/tasks` | GET | tareas/colas de NEO | abierto |
| `/api/neo/chat` | POST | intención → `{tag, reply, left, right}` (el cerebro de NEO) | **sesión/token** |

### Nota de auth (importante)
- Los GET de lectura son abiertos → se llaman con la integración `authType:'none'`.
- `/api/neo/chat` y el resto de POST requieren **sesión** (cookie `neo_session` o service-token de
  `hermes-hq`). El broker de Munder Difflin solo inyecta `bearer` / `header` / `none` — **no cookies**.
  Por eso el template se expone como **solo-lectura (no-auto)**: un worker que quiera "preguntar a NEO"
  tendría que pasarlo por una ruta con auth de header/token si se añade soporte en NEO, o usar solo los GET.

## Cómo se usa (en la app)
1. Pestaña Integrations → buscar **`BTCLABS · NEO`** en el catálogo (plantilla nueva).
2. Registrar el record con `baseUrl: http://127.0.0.1:8830` y **`enabled: true`**.
3. Un worker consulta vía el **broker loopback**: p. ej. `/api/health` o `/api/usage` para ver el fuel
   real antes de decidir si delega a clau/gpt/local.

## Para contribuir upstream
- Es un cambio **aditivo** a `INTEGRATION_TEMPLATES` (el patrón documentado: "Dwight extends the catalog
  by appending to INTEGRATION_TEMPLATES — no broker or registry changes needed").
- `npm install && npm run typecheck` debe quedar verde.
- PR requiere evidencia **before/after** (screenshot).
