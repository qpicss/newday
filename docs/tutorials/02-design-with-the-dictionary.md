# Tutorial 2: Design an API with the data dictionary

In this tutorial you build parts of the **Orders** API from reusable dictionary fields and objects, instead of writing schemas by hand.

**You need:** the **Orders** API from [Tutorial 1](01-publish-your-first-api.md).

**Time:** about 15 minutes.

## How the dictionary works

- A **field** is one value with its rules: `orderId` is a string in UUID format, `quantity` is an integer of at least 1.
- An **object** is a set of properties, each a field or another object: `OrderLine` has a `sku` and a `quantity`.
- When an API uses an **object**, the object is written into the document's `components.schemas` and referenced from there.
- When an API uses a **field** as a parameter or body, the field's schema is copied in place.

Documents keep their copy when the dictionary changes. You decide when to update them.

## 1. Look at what the import added

Click **Dictionary** in the header. Importing `orders.yaml` added:

- fields such as `Status`, `customerId` and `orderId`;
- objects such as `Order`.

Open a field to see its rules and, on the right, the schema it becomes in an OpenAPI document. The **Used in** card lists the objects and APIs that use it.

## 2. Create fields

On the **Fields** tab, under **New field**, create these two:

| Name | Type | Rules |
|---|---|---|
| `sku` | string | Pattern `^[A-Z0-9-]{4,20}$`, example `CHAIR-01` |
| `quantity` | integer | Minimum `1`, maximum `999` |

The preview on the field page updates as you type.

## 3. Create an object from fields

1. Switch to the **Objects** tab.
2. Under **New object**, name it `OrderLine`.
3. Add a property `sku` from the field `sku` and mark it required.
4. Add a property `quantity` from the field `quantity` and mark it required.
5. Create the object.

The object page shows the schema `OrderLine` becomes in a document.

## 4. Add a parameter from a field

1. Open the **Orders** API and its **Design** tab.
2. Select **GET /orders** in the **Endpoints** list.
3. In **Parameters**, under **Add a parameter**, choose location `query` and field `quantity`. Enter the name `limit` and add it.

The parameter is written with the field's schema and marked with `x-dictionary-field`, so the console knows where it came from.

To change a parameter later, use its **edit** button. You can change its schema with the field form or as JSON. If it came from a field, you can also save the change to the field itself.

## 5. Use an object as the request body

1. Select **POST /orders**.
2. In **Request body**, set **Described by** to the object **OrderLine**, check **A list of these**, and save the body.

The console writes `OrderLine` into `components.schemas` and sets the body to a list of `OrderLine`. It appears under **Schemas in this document** with a **Dictionary** badge.

If the document already has a different schema named `OrderLine`, the console asks before replacing it. A schema with exactly the same content is simply taken over.

## 6. Create an object on the spot

You don't have to leave the Design tab to add something new:

- Next to **Save body**, **New object** opens the object builder in a dialog. The object is saved to the dictionary and used straight away.
- In **Add a parameter**, **New field instead** creates a field and uses it.

## 7. Keep documents up to date

Change the dictionary, then update the API:

1. Open the field `quantity` and change its maximum to `100`. Save it.
2. Open the **Orders** API's **Design** tab.

**Schemas in this document** now says the dictionary changed, and `OrderLine` has an **Out of date** badge. Click **Update from dictionary**: the schemas, parameters and bodies taken from the dictionary are rewritten with its current version. Documents are never changed without you asking.

## 8. Edit an inline body

A body described by a dictionary field is written in the endpoint itself, not as a named schema. Its row on the Design tab has two buttons:

- **View and edit** opens it in the schema editor. See [Tutorial 3](03-edit-schemas.md#edit-a-body-in-place).
- **Move to schemas** turns it into a named schema in `components.schemas`, so it is listed under **Schemas in this document** and other endpoints can use it.

## What you have

- New fields and an object in the dictionary, reusable in every API of the organization.
- An API whose parameter and body come from the dictionary, and a way to see when they're out of date.

Next, [edit schemas in the schema designer](03-edit-schemas.md).
