# Architecture v2

## Services

- `shop-service` (`server/index.js` + `server/services/shop-service/*`)
- `sourcing-service` (`server/services/sourcing-service/*`)
- `automation-worker` (`server/services/automation-worker/runner.js`)
- `ai-service` (`server/services/ai-service/*`)

## Communication

- REST: client/admin -> `shop-service`, internal API calls to sourcing + ai modules.
- Queue/worker: `automation-worker` schedules sourcing and automation cycles.
- Events: in-process bus with contracts in `server/services/events/contracts.js`.

## Event contracts

- `product_created`
- `product_viewed`
- `product_clicked`
- `order_completed`

## Ranking model

Implemented in `server/services/ranking/engine.js`:

- `ctr = (clicks + 1) / (views + 10)`
- `cvr = (orders + 1) / (clicks + 5)`
- weighted score -> boost/deprioritize/remove actions

## Auto mode

Implemented in `server/services/sourcing-service/auto-approval.js`:

- if score above threshold and risk below threshold => auto publish
- else route to admin review path

## Multi-provider abstraction

Implemented in `server/services/sourcing-service/providers/*`:

- eBay adapter
- Amazon adapter (stub)
- AliExpress adapter (stub)
- shared provider registry for fan-out discovery
