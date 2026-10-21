---
title: Order Checkout and Payment Processing Service Spec
---

# Checkout Service

## Authors

- Abhi

## 1. Overview

The **checkout service** turns a cart into an order. It owns pricing, tax,
and payment capture, and it is the *only* writer of the `orders` table.

## 2. Requirements

- Carts expire after 30 minutes of inactivity.
- A cart may hold at most 50 line items.
- Prices are locked when the user reaches the payment step, and they stay
  locked for 10 minutes even if the catalog changes.
- Tax is computed by the [tax service](https://internal/tax) using the
  shipping address, never the billing address.

### 2.1 Payment capture

1. Authorize the card for the full amount.
2. Capture only after the warehouse confirms stock.
3. If capture fails, retry up to 3 times with exponential backoff.

> Note: refunds are out of scope for v1 and are handled by the
> returns service.

## 3. API

| Method | Path            | Description        |
|--------|-----------------|--------------------|
| POST   | /checkout       | Start checkout     |
| POST   | /checkout/{id}  | Submit payment     |

```json
{
  "cartId": "abc123",
  "paymentMethod": "card"
}
```

## 4. Open questions

- Should we support split payments? The team leans no.
- What happens when the tax service is down?
