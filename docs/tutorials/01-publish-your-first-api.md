# Tutorial 1: Publish your first API

In this tutorial you import an OpenAPI document, bundle it into a product and publish it, so developers in your organization can find it and request access.

**You need:** the console running and an account that is an admin of an organization. Registering a new account gives you one. See [Getting started](../getting-started.md).

**Time:** about 10 minutes.

## 1. Create a catalog

A catalog holds the APIs and products you publish together, and is what a gateway serves.

1. Click **Catalogs** in the header.
2. Under **New catalog**, enter `Shop` and create it.
3. Open the **Shop** catalog.

## 2. Import an OpenAPI document

Save this document as `orders.yaml`. Its server is `https://httpbin.org/anything`, a public service that echoes every request back, so you can see exactly what the gateway sends later.

```yaml
openapi: 3.0.3
info:
  title: Orders
  version: 1.0.0
  description: Orders of the shop
servers:
  - url: https://httpbin.org/anything
paths:
  /orders:
    get:
      operationId: listOrders
      summary: List orders
      parameters:
        - name: status
          in: query
          schema:
            $ref: '#/components/schemas/Status'
      responses:
        '200':
          description: The orders
          content:
            application/json:
              schema:
                type: array
                items:
                  $ref: '#/components/schemas/Order'
    post:
      operationId: createOrder
      summary: Create an order
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [customerId]
              properties:
                customerId:
                  type: string
                  format: uuid
                note:
                  type: string
                  maxLength: 500
      responses:
        '201':
          description: Created
  /orders/{orderId}:
    get:
      operationId: getOrder
      summary: Get an order
      parameters:
        - name: orderId
          in: path
          required: true
          schema:
            type: string
            format: uuid
      responses:
        '200':
          description: The order
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/Order'
        '404':
          description: No such order
components:
  schemas:
    Status:
      type: string
      enum: [open, paid, shipped]
    Order:
      type: object
      required: [id, status]
      properties:
        id:
          type: string
          format: uuid
        status:
          $ref: '#/components/schemas/Status'
        total:
          type: number
          minimum: 0
```

In the **Shop** catalog:

1. In the **APIs** card, click **Import OpenAPI**.
2. Drop `orders.yaml` on the page, or paste its content, and import it.

The console checks the document, creates the **Orders** API and adds its schemas and parameters to your [data dictionary](../concepts.md#data-dictionary). The result tells you how many fields and objects were added.

## 3. Look at the API

Open the **Orders** API. It has four tabs:

- **Overview** lists the endpoints, and holds the gateway settings.
- **Design** edits one endpoint at a time. You use it in [Tutorial 2](02-design-with-the-dictionary.md).
- **Schemas** edits `components.schemas`. See [Tutorial 3](03-edit-schemas.md).
- **Source** is the whole document as JSON or YAML.

On **Overview**, in the **Gateway** card, set **Base path** to `/shop` and save. Clients will call the API on the gateway at `<gateway address>/shop/orders`.

Leave **Policy** empty for now. An API without a policy doesn't call its upstream: it answers `200` with the body of the request it received. That is enough to check that the gateway works. You add a policy that calls `httpbin.org` in [Tutorial 6](06-protect-an-api-with-a-flow.md).

## 4. Create a product

Developers request access to products, not to single APIs.

1. Go back to the **Shop** catalog.
2. In the **Products** card, enter `Shop Starter` and create it.
3. Open **Shop Starter**.
4. In the **APIs** card, add **Orders**.
5. In **Rate limit**, turn the limit on and set `60` requests per `minute`. The gateway enforces this for each application.
6. In **Billing**, keep **Free**. Billing is shown to developers and stored; nothing is charged.

## 5. Publish it

At the top of the product page, click **Publish**. The badge changes from **Draft** to **Published**.

Members of your organization now see **Shop Starter** when they open the **Shop** catalog, and can request access for their applications.

## What you have

- A catalog, **Shop**, with one API and one published product.
- A data dictionary filled from the document.

The API isn't reachable yet, because no gateway serves the catalog. You set one up in [Tutorial 4](04-run-a-gateway.md). Next, [design the API with the dictionary](02-design-with-the-dictionary.md).
