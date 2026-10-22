# Tutorial 3: Edit schemas in the schema designer

In this tutorial you create and change schemas of the **Orders** document as trees, without editing YAML.

**You need:** the **Orders** API from [Tutorial 1](01-publish-your-first-api.md).

**Time:** about 10 minutes.

## The schema editor

The same editor appears in three places:

- the **Schemas** tab of an API, for `components.schemas`;
- **View and edit** on a request body or response of the Design tab, for a schema written in the endpoint;
- the page of an object field in the dictionary, for its structure.

It shows a schema as a tree. Select a row to edit it in the inspector on the right. Each row holds one of these:

| Holds | Becomes |
|---|---|
| A value | a string, number, integer, boolean or array of values, with the same rules as a dictionary field |
| An object | `type: object` with properties, the rows under it |
| A list of objects | `type: array` with object items, whose properties are the rows under it |
| A schema | a `$ref` to another schema of the document, or to a dictionary object |
| JSON | anything else, edited as JSON |

Keyboard: arrow keys move between rows, Left and Right fold them, Ctrl+Z and Ctrl+Y undo and redo, Ctrl+S saves.

## 1. Create a schema

1. Open the **Orders** API and its **Schemas** tab.
2. Click **New**, name it `Customer`, keep **Starts as: An object**, and create it.

## 2. Build it

1. Select the root row `Customer`, then **Add property**.
2. Name it `email`. Under **Holds**, keep **A value**, choose type `string` and format `email`. Check **Required**.
3. Add another property, `address`, and set **Holds** to **An object**.
4. With `address` selected, add `city` (a string) and `zip` (a string with pattern `^[0-9]{5}$`).
5. Select the root again and add `orders`. Set **Holds** to **A schema**, pick `Order`, and check **A list of these**.

Switch to the **JSON**, **YAML** and **Example** tabs to see the result. **Example** builds a payload from your examples, formats and allowed values, ready to copy.

## 3. Save

Click **Save schema**. The console checks the structure and that every reference points at a schema of the document, then saves.

If you picked a dictionary object under **A schema** that the document doesn't have yet, it is written into the document when you save.

## 4. Rename and delete

- Select the root row and change its name to rename the schema. Every reference in the document is updated when you save.
- The **Used by** card under the editor lists the endpoints and schemas that refer to it. A schema can be deleted only when nothing uses it.

## 5. Share it through the dictionary

Click **Add to dictionary**. The schema, and the schemas it refers to, become dictionary objects, so other APIs can use them.

A schema written from the dictionary shows a banner with a link to its object. Saving a change on the Schemas tab makes it the document's own; to change it for every API, change the dictionary object instead.

## Edit a body in place

Bodies and responses described by a dictionary field are written in the endpoint itself:

1. Open the **Design** tab and select an endpoint with such a body.
2. Click **View and edit** on its row.

The schema opens in the same editor. When it came from a dictionary field, the page says so:

- A change saved normally stays in this API, and the body is no longer linked to the field.
- Check **Also save the change to** the field to update the dictionary too and keep the link.

At the bottom, **Move to the document's schemas** turns it into a named schema in `components.schemas`, and the body then refers to it.

## Next

[Run a gateway](04-run-a-gateway.md) so the API can be called.
