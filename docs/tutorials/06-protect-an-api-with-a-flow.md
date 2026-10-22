# Tutorial 6: Protect an API with a flow

In this tutorial you build a policy that checks requests against the OpenAPI document, blocks attacks, adds a header with a script and calls the real upstream. Then you attach it to the **Orders** API.

**You need:** the gateway and application from [Tutorials 4](04-run-a-gateway.md) and [5](05-call-an-api.md).

**Time:** about 15 minutes.

## Flows

A policy is a flow: a request enters at **Input**, goes through steps joined by lines, and leaves at **Output**, which answers the client. If no step produced a response, Output answers `200` with the request's own body. That is why the API answered an empty `200` in Tutorial 5.

| Step | Does |
|---|---|
| Gateway script | Runs your JavaScript on the request, and optionally on the response |
| If | Sends the request down its *true* or *false* line, by conditions on the request |
| Invoke service | Calls the API's backend or any URL, and keeps the answer as the response or in a variable |
| Validate request | Checks headers and query parameters against the matched OpenAPI operation (`422` if not) |
| Validate body | Checks the body against the operation's `requestBody` (`422`, or `415` for a wrong content type) |
| Security | Blocks injection attempts, limits sizes, filters client addresses and locks out brute force |

## 1. Create the policy

1. Click **Gateways**, then the **Policies** tab.
2. Under **New policy**, name it `Orders checks` and create it.

The flow editor opens with **Input** joined to **Output**.

## 2. Add the steps

From **Add a step** on the left, add these in order. Each new step is inserted before Output and joined to the previous one:

1. **Security.** Keep the defaults. To only log findings at first, choose monitor mode.
2. **Validate request.** Optionally refuse query parameters the document doesn't declare.
3. **Validate body.**
4. **Gateway script**, with this code:

   ```js
   module.exports = {
     async onRequest(callcontext) {
       callcontext.headers['x-shop-channel'] = 'gateway';
     },
   };
   ```

5. **Invoke service.** Choose **The API's backend** and leave **Backend URL** empty, so the server of the API's OpenAPI document (`https://httpbin.org/anything`) is used. Check **Add the request's path and query to the URL**, so `/shop/orders` calls `https://httpbin.org/anything/orders`.

Select a step to see its settings on the right. The editor lists problems, such as a step that isn't joined, before you can save.

## 3. Test it before deploying

The **Test** panel runs the unsaved flow on one of your gateway nodes:

1. Set **Run as API** to **Orders**.
2. Choose `POST` and the path `/orders`, with the body `{"note": 5}`.
3. Click **Run test**.

The result shows the `422` the Validate body step answers, and lists each problem: `customerId` is required, and `note` must be a string. Nothing is deployed and no upstream is called during a test.

Save the policy.

## 4. Attach it to the API

1. Open the **Orders** API, **Overview** tab.
2. In **Gateway**, set **Policy** to **Orders checks** and save.
3. Push the gateway, unless auto-push is on.

## 5. Try it

```bash
# Valid: reaches httpbin.org, which echoes what the gateway sent, including x-shop-channel
curl -H "Authorization: Bearer $ACCESS_TOKEN" "http://localhost:8080/shop/orders?status=open"

# Invalid query value: 422 from Validate request
curl -H "Authorization: Bearer $ACCESS_TOKEN" "http://localhost:8080/shop/orders?status=lost"

# Missing required property: 422 from Validate body
curl -H "Authorization: Bearer $ACCESS_TOKEN" -H "Content-Type: application/json" \
  -d '{"note": "no customer"}' http://localhost:8080/shop/orders

# An injection attempt: 403 from Security
curl -H "Authorization: Bearer $ACCESS_TOKEN" "http://localhost:8080/shop/orders?status=open'%20OR%201=1--"
```

**Live requests** shows each call, and which step answered it.

## Port policies

A connection handler can have its own policy, chosen in **Connection handlers** as **Port policy**. It runs before the API's policy for every request on that port. For example, use a Security step there to protect every API served on a public port.

## Connections

To control how the backend is called, create a connection under **Gateways → Connections** and choose it on the API's Overview tab. It sets timeouts, retries for idempotent methods, a circuit breaker, credentials for the upstream (basic, bearer or an API key header) and TLS with your own CA or a client certificate.

## Next

[Work as a team](07-work-as-a-team.md). For the script API in full, see [Policies](../../gateway/README.md#policies) in the gateway README.
