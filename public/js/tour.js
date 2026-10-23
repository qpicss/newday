// Guided tours: the help button in the header walks through the current page, one highlighted part
// at a time. The dashboard has the platform tour and offers it on a first visit. Steps whose element
// isn't on the page (another role, an empty list, a narrow screen) are skipped. Seen tours are
// remembered per browser, only to stop offering them again.
//
// A step: { target: selector or [selectors, first visible wins] or null (centered), title, body }.
(function () {
    const NAV = (href) => [`#app-nav a[href="${href}"]`, '[data-nav-toggle]'];

    const TOURS = [
        {
            id: 'platform',
            match: /^\/developer\/dashboard\/?$/,
            title: 'Platform tour',
            steps: [
                { target: null, title: 'Welcome to OAuth Server', body: 'This console is where you publish APIs and control who can call them. You describe APIs in catalogs, bundle them into products, and run gateways that serve the traffic. Developers create applications, get access to products and call the APIs with OAuth tokens.' },
                { target: '[data-org-switcher]', title: 'Your organization', body: 'Everything you see belongs to the organization selected here. You can belong to several and switch between them. Your role is shown underneath: admins manage the organization, members use its APIs.' },
                { target: NAV('/developer/catalogs'), title: 'Catalogs', body: 'A catalog groups the APIs and products you publish together. Admins import OpenAPI files and design the APIs here; members browse the published products.' },
                { target: NAV('/developer/dictionary'), title: 'Data dictionary', body: 'Fields and objects defined once and reused in every API: parameters, request bodies and responses. Importing an API fills it for you.' },
                { target: NAV('/developer/applications'), title: 'Applications', body: 'An application is a client that calls your APIs. It gets a client ID and secret, asks for access to products, and exchanges its credentials for a token at /oauth/token.' },
                { target: NAV('/developer/gateways'), title: 'Gateways', body: 'Gateways serve a catalog\'s published products. Here you run nodes, open ports, write policies and flows, set upstream connections and watch live requests.' },
                { target: NAV('/developer/organization'), title: 'Members', body: 'Invite people by email, change their roles and see pending invitations. An organization always keeps at least one admin.' },
                { target: NAV('/developer/docs'), title: 'Docs', body: 'The documentation: a guide for your role, step-by-step tutorials and the REST API reference.' },
                { target: NAV('/developer/admin'), title: 'Platform admin', body: 'Platform admins manage every user, organization and application, and can work inside any organization.' },
                { target: '.setup-card', title: 'Setup checklist', body: 'The steps that take a new organization from nothing to an API that developers can call. Each one links to the page where you do it.' },
                { target: '.stats', title: 'At a glance', body: 'Your applications, the products they are approved for and your role in this organization.' },
                { target: '[data-tour-start]', title: 'A tour on every page', body: 'Use this button on any page to tour it: the API designer, the schema editor, gateways, policies and more.' },
            ],
        },
        {
            id: 'catalogs',
            match: /^\/developer\/catalogs\/?$/,
            title: 'Catalogs',
            steps: [
                { target: 'section[aria-label="Catalogs"]', title: 'Your catalogs', body: 'Each catalog holds products and the APIs inside them. A gateway serves exactly one catalog, so a catalog is also a unit of deployment.' },
                { target: '.card:has(#catalogForm)', title: 'Create a catalog', body: 'Give it a name, then open it to import APIs and create products.' },
            ],
        },
        {
            id: 'catalog',
            match: /^\/developer\/catalogs\/[^/]+\/?$/,
            title: 'Catalog',
            steps: [
                { target: '#product-grid', title: 'Published products', body: 'Open a product to see its APIs and its plan, and to request access for one of your applications.' },
                { target: '.stats', title: 'What it holds', body: 'Products, APIs and how many are published. Only published products reach a gateway.' },
                { target: '#products', title: 'Products', body: 'A product bundles APIs with a rate limit and a price. Developers request access to products, not to single APIs.' },
                { target: '#apis', title: 'APIs', body: 'Import an OpenAPI 3 file or describe the endpoints by hand. Open an API to design its endpoints and schemas.' },
                { target: '#gateway', title: 'Gateway', body: 'Attach a running gateway to serve this catalog\'s published products.' },
                { target: '#pushCatalog', title: 'Push', body: 'Sends the latest configuration to the attached gateway. With auto-push on, this happens a few seconds after each change.' },
            ],
        },
        {
            id: 'catalog-product',
            match: /^\/developer\/catalog\/[^/]+\/?$/,
            title: 'Product',
            steps: [
                { target: '.card:has(#applicationId)', title: 'Request access', body: 'Choose one of your applications. An admin of the organization approves the request, then the gateway lets the application through.' },
                { target: '.card:has(#token-command)', title: 'Call it', body: 'Ready-made commands: get a token with your client ID and secret, then call the API through the gateway with it.' },
            ],
        },
        {
            id: 'api',
            match: /^\/developer\/apis\/[^/]+\/?$/,
            title: 'API overview',
            steps: [
                { target: '.page-tabs', title: 'Four views of the API', body: 'Overview for gateway settings, Design for endpoints, Schemas for the document\'s schemas, Source for the raw OpenAPI file.' },
                { target: '.card:has(#operationForm)', title: 'Endpoints', body: 'Every operation of the OpenAPI document. The gateway only lets through requests that match one of them.' },
                { target: '#details', title: 'Details', body: 'Name, version and description, shown to developers. The upstream server the gateway calls is the first servers URL of the document, changed on the Source tab.' },
                { target: '#gateway', title: 'Gateway settings', body: 'The base path clients call on the gateway, the policy (flow) that runs for each request, and the connection used to reach the upstream.' },
            ],
        },
        {
            id: 'api-design',
            match: /^\/developer\/apis\/[^/]+\/design\/?$/,
            title: 'API designer',
            steps: [
                { target: '#designOps', title: 'Endpoints', body: 'Pick an endpoint to edit it. Add new ones on the Overview tab.' },
                { target: '#schemas', title: 'Schemas in this document', body: 'The named schemas under components.schemas. Badges show which came from the dictionary and whether they are out of date.' },
                { target: '#importToDictionary', title: 'Fill the dictionary', body: 'Adds this document\'s schemas and parameters to the data dictionary, so other APIs can reuse them.' },
                { target: '.card:has(#infoForm)', title: 'Endpoint details', body: 'Summary, operation ID, description and whether the endpoint is deprecated.' },
                { target: '#parameters', title: 'Parameters', body: 'Path, query, header and cookie parameters. Add one from a dictionary field, or create a new field on the spot. Edit an existing one with its pencil button.' },
                { target: '#request-body', title: 'Request body', body: 'Described by a dictionary object, a schema of this document or a dictionary field. Use View and edit to open it in the schema editor, or Move to schemas to make it a named schema.' },
                { target: '#responses', title: 'Responses', body: 'One entry per status code, each with an optional body described the same way.' },
            ],
        },
        {
            id: 'content-schema',
            match: /^\/developer\/apis\/[^/]+\/design\/schema\/?$/,
            title: 'Body schema',
            steps: [
                { target: '.content-schema-head', title: 'Which schema this is', body: 'The endpoint, the body or response, and its content type.' },
                { target: '.schema-main', title: 'The schema as a tree', body: 'Select a row to edit it. Add properties, nest objects or lists, and switch to JSON, YAML or an example payload. Ctrl+Z and Ctrl+Y undo and redo, Ctrl+S saves.' },
                { target: '.schema-inspector', title: 'The selected row', body: 'Its name, whether it is required, its description and what it holds: a value, an object, a list of objects, another schema or raw JSON.' },
                { target: '.content-schema-field:has(#updateField)', title: 'Linked to a dictionary field', body: 'Changes stay in this API unless you also save them to the field.' },
                { target: '.card:has(#moveForm)', title: 'Make it a named schema', body: 'Moves it into components.schemas, so it is listed on the Schemas tab and other endpoints can use it.' },
            ],
        },
        {
            id: 'api-schemas',
            match: /^\/developer\/apis\/[^/]+\/schemas\/?$/,
            title: 'Schema designer',
            steps: [
                { target: '.design-sidebar', title: 'The document\'s schemas', body: 'Every entry of components.schemas. Badges mark the ones written from the dictionary.' },
                { target: '[data-new-schema]', title: 'New schema', body: 'Start from an object, a list of objects or a single value.' },
                { target: '.schema-main', title: 'Edit it as a tree', body: 'Select a row to edit it, drag it up or down with the arrows, and switch to JSON, YAML or an example payload.' },
                { target: '.schema-inspector', title: 'Inspector', body: 'A property can hold a value (with the same rules as a dictionary field), an object, a list of objects or a reference to another schema. Picking a dictionary object adds it to the document when you save.' },
                { target: '[data-save]', title: 'Save', body: 'Checks the schema and every reference before saving. Renaming a schema updates every place that refers to it.' },
                { target: '[data-to-dictionary]', title: 'Add to the dictionary', body: 'Copies this schema and the schemas it uses into the data dictionary, to reuse in other APIs.' },
            ],
        },
        {
            id: 'api-source',
            match: /^\/developer\/apis\/[^/]+\/source\/?$/,
            title: 'Source editor',
            steps: [
                { target: '.source-card', title: 'The OpenAPI document', body: 'Edit the whole document as JSON or YAML. Shared parameters and bodies (components) are changed here.' },
                { target: '#validateSource', title: 'Check', body: 'Validates the document without saving, and points at the line of the first problem.' },
                { target: '#saveSource', title: 'Save', body: 'Saves the document. If someone else saved in the meantime, you are told instead of overwriting their change.' },
            ],
        },
        {
            id: 'product',
            match: /^\/developer\/products\/[^/]+\/?$/,
            title: 'Product',
            steps: [
                { target: '.page-header', title: 'Draft or published', body: 'Only published products are shown to developers and served by gateways.' },
                { target: '#apis', title: 'APIs', body: 'The APIs that come with this product. They must be in the same catalog.' },
                { target: '#access', title: 'Access requests', body: 'Applications that asked to use this product. Approve, reject or revoke them.' },
                { target: '#rate-limit', title: 'Rate limit', body: 'Requests allowed per application in a time window. The gateway enforces it.' },
                { target: '#billing', title: 'Billing', body: 'The plan shown to developers: free, flat rate or per request. Stored for your records; nothing is charged.' },
            ],
        },
        {
            id: 'dictionary',
            match: /^\/developer\/dictionary\/?$/,
            title: 'Data dictionary',
            steps: [
                { target: '.page-tabs', title: 'Fields and objects', body: 'A field is one value with its rules (type, format, length, allowed values). An object is a set of properties, each a field or another object.' },
                { target: '.card:has(#dictionaryList)', title: 'The list', body: 'Search it, and open an entry to see where it is used and how it looks in an OpenAPI document.' },
                { target: ['.card:has(#fieldForm)', '.card:has(#objectForm)'], title: 'Add one', body: 'Create a field or an object here, or on the fly from an API\'s Design tab.' },
                { target: '.card:has(#importForm)', title: 'Fill from an API', body: 'Adds the schemas and parameters of one of your APIs. A name already used for something different gets a qualified name, such as Order.id.' },
            ],
        },
        {
            id: 'dictionary-field',
            match: /^\/developer\/dictionary\/fields\/[^/]+\/?$/,
            title: 'Dictionary field',
            steps: [
                { target: '#fieldForm', title: 'Rules', body: 'The type and the rules a value must follow. Changes apply to the objects using this field; APIs keep their copy until you update them.' },
                { target: '#fieldPreview', title: 'In an OpenAPI document', body: 'The schema this field becomes, updated as you type.' },
                { target: '[data-structure]', title: 'Structure', body: 'For an object field: its properties, edited in the schema editor and saved with the field.' },
            ],
        },
        {
            id: 'dictionary-object',
            match: /^\/developer\/dictionary\/objects\/[^/]+\/?$/,
            title: 'Dictionary object',
            steps: [
                { target: '#objectForm .card', title: 'Properties', body: 'Each property is a field or another object, optionally a list, optionally required.' },
                { target: '#objectForm .card:nth-of-type(2)', title: 'In an OpenAPI document', body: 'The schemas this object writes into a document, including the objects it uses.' },
            ],
        },
        {
            id: 'gateways',
            match: /^\/developer\/gateways\/?$/,
            title: 'Gateways',
            steps: [
                { target: '.page-tabs', title: 'Runtime settings', body: 'Gateways, the policies (request flows) they run and the connections they use to reach upstream services.' },
                { target: '.card:has(#gatewayForm)', title: 'New gateway', body: 'Create one, then follow its setup steps: download the credentials, start a node with Docker or on Linux, attach it to a catalog.' },
                { target: '.grid-2 > .stack > .card:last-child', title: 'Certificate authority', body: 'The console issues the certificates that console and gateways use to trust each other (mutual TLS).' },
            ],
        },
        {
            id: 'gateway',
            match: /^\/developer\/gateways\/[^/]+\/?$/,
            title: 'Gateway',
            steps: [
                { target: '[data-setup-mode]', title: 'Console or node first', body: 'Usually the console connects to the node: it checks it every 30 seconds, sends it the configuration and opens its admin UI, and the node needs no route back. Or the node connects to the console, which must then be reachable from the node.' },
                { target: '#pushConfig', title: 'Push configuration', body: 'Sends the catalog\'s published products, approved applications, policies and handlers to the nodes. The header tells you when there are changes not deployed yet.' },
                { target: 'a[href$="/requests"]', title: 'Live requests', body: 'Every request the nodes served, with status, timings, application and trace ID. Headers and bodies are never stored.' },
                { target: '#nodes', title: 'Nodes', body: 'The processes that serve traffic. The console checks push nodes every 30 seconds and marks one that doesn\'t answer as Unreachable; pull nodes connect to the console by themselves. The arrow button opens a node\'s admin UI, signed in.' },
                { target: '#handlers', title: 'Connection handlers', body: 'The ports for API traffic, HTTP or HTTPS, each optionally with a port policy that runs before the API\'s own.' },
                { target: '#observability', title: 'Observability', body: 'Metrics, tracing, the request log, off-loading records to your collector and usage metering. Each can be turned on or off.' },
                { target: '#run', title: 'Add a node', body: 'The exact commands to start a node, for Docker or a Linux server.' },
                { target: '#credentials', title: 'Credentials', body: 'The certificates of this gateway. Renew them before they expire, revoke a leaked one.' },
            ],
        },
        {
            id: 'gateway-requests',
            match: /^\/developer\/gateways\/[^/]+\/requests\/?$/,
            title: 'Live requests',
            steps: [
                { target: '#filters', title: 'Filters', body: 'Narrow down by status class or API, or search.' },
                { target: '#toggleLive', title: 'Follow live', body: 'Keeps the list updating as requests come in.' },
                { target: '#requests', title: 'Requests', body: 'Open one to see its timings, the policy steps it went through and its trace ID.' },
            ],
        },
        {
            id: 'policies',
            match: /^\/developer\/policies\/?$/,
            title: 'Policies',
            steps: [
                { target: '.page-header', title: 'Policies are flows', body: 'A policy is a flow of steps a request goes through on the gateway: checks, scripts, conditions and calls to services. Attach it to an API, or to a port as a port policy.' },
                { target: '.card:has(#policyForm)', title: 'New policy', body: 'Start from an empty flow and build it in the flow editor.' },
            ],
        },
        {
            id: 'policy',
            match: /^\/developer\/policies\/[^/]+\/?$/,
            title: 'Flow editor',
            steps: [
                { target: '.flow-palette', title: 'Steps', body: 'Gateway script runs your code, If branches on the request, Invoke service calls another URL, Validate request and Validate body check against the OpenAPI document, Security blocks attacks and brute force.' },
                { target: '.flow-canvas-card', title: 'The flow', body: 'Drag steps and connect them from Input to Output. Select a step to configure it; select a line to remove it.' },
                { target: '#inspector', title: 'Settings', body: 'The settings of the selected step, or of the policy itself.' },
                { target: '#test', title: 'Test', body: 'Runs the unsaved flow on one of your gateway nodes against a sample request. Nothing is deployed and no upstream is called.' },
            ],
        },
        {
            id: 'connections',
            match: /^\/developer\/connections\/?$/,
            title: 'Connections',
            steps: [
                { target: '.page-header', title: 'How upstreams are called', body: 'Timeouts, retries, a circuit breaker, upstream credentials and TLS settings, shared by the APIs that use the connection.' },
                { target: '.card:has(#connectionForm)', title: 'New connection', body: 'Create one, then choose it on an API\'s Overview tab.' },
            ],
        },
        {
            id: 'applications',
            match: /^\/developer\/applications\/?$/,
            title: 'Applications',
            steps: [
                { target: '.page-header .btn-primary', title: 'New application', body: 'Creates a client ID and secret. The secret is shown once, so copy it when you see it.' },
                { target: '#applications-table', title: 'Your applications', body: 'Open one to manage its credentials, redirect URIs and the products it can use.' },
            ],
        },
        {
            id: 'application',
            match: /^\/developer\/applications\/[^/]+\/?$/,
            title: 'Application',
            steps: [
                { target: '.card:has(#applicationForm)', title: 'Settings', body: 'Name, description and redirect URIs (https, or http on localhost).' },
                { target: '#api-access', title: 'API access', body: 'The products this application can use or has asked for. Request access from a product in the catalog.' },
                { target: '#credentials', title: 'Credentials', body: 'Up to 10 extra client ID and secret pairs, so you can rotate secrets without downtime. All of them act as this application.' },
            ],
        },
        {
            id: 'organization',
            match: /^\/developer\/organization\/?$/,
            title: 'Organization',
            steps: [
                { target: '#organizations', title: 'Your organizations', body: 'Create another organization, switch to one or leave it.' },
                { target: '#members', title: 'Members', body: 'Everyone in this organization and their role. Admins manage catalogs, gateways and members; members use the APIs.' },
                { target: '.card:has(#inviteForm)', title: 'Invite', body: 'Sends an invitation by email, or gives you a link to share when email isn\'t set up.' },
            ],
        },
        {
            id: 'docs',
            match: /^\/developer\/docs(\/.*)?$/,
            title: 'Docs',
            steps: [
                { target: '.docs-role-callout', title: 'Your guide', body: 'Everything you can do with your role, page by page.' },
                { target: ['.docs-nav', '.docs-menu-toggle'], title: 'Contents', body: 'Guides by role, tutorials to follow step by step, the REST API reference with examples, and how to run the platform. Filter the list to find a page.' },
                { target: '.docs-toc', title: 'On this page', body: 'Jump to a section. The one you are reading is highlighted.' },
                { target: '.docs-pager', title: 'Read on', body: 'The pages follow a reading order: go to the previous or next one here.' },
            ],
        },
        {
            id: 'requests',
            match: /^\/developer\/requests\/?$/,
            title: 'Access requests',
            steps: [
                { target: '#pending', title: 'Waiting for a decision', body: 'Applications asking to use your products. An approved application can call the product\'s APIs through the gateway.' },
            ],
        },
    ];

    // Remembered per browser; storage may be unavailable (private windows), which only means offering again.
    const store = {
        get(key) { try { return window.localStorage.getItem(`tour.${key}`); } catch (error) { return null; } },
        set(key, value) { try { window.localStorage.setItem(`tour.${key}`, value); } catch (error) { /* ignore */ } },
    };
    const reducedMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    const visible = (element) => {
        if (!element || element.closest('[hidden]')) return false;
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && getComputedStyle(element).visibility !== 'hidden';
    };
    const find = (target) => {
        for (const selector of Array.isArray(target) ? target : [target]) {
            let element = null;
            try { element = document.querySelector(selector); } catch (error) { element = null; }
            if (visible(element)) return element;
        }
        return null;
    };

    const tourForPage = () => TOURS.find((tour) => tour.match.test(window.location.pathname)) || null;

    let active = null; // { tour, steps, index, returnFocus, nodes }

    function el(tag, className, text) {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined) node.textContent = text;
        return node;
    }

    function build() {
        const backdrop = el('div', 'tour-backdrop');
        const spotlight = el('div', 'tour-spotlight');
        const card = el('div', 'tour-card');
        card.setAttribute('role', 'dialog');
        card.setAttribute('aria-modal', 'false');
        card.setAttribute('aria-labelledby', 'tourTitle');
        card.setAttribute('aria-describedby', 'tourBody');
        card.tabIndex = -1;
        const top = el('div', 'tour-top');
        const count = el('span', 'tour-count');
        const close = el('button', 'btn btn-ghost btn-sm btn-icon tour-close');
        close.type = 'button';
        close.setAttribute('aria-label', 'End the tour');
        close.innerHTML = '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6L6 18M6 6l12 12"/></svg>';
        top.append(count, close);
        const title = el('h2', 'tour-title');
        title.id = 'tourTitle';
        const body = el('p', 'tour-body');
        body.id = 'tourBody';
        const progress = el('div', 'tour-progress');
        const actions = el('div', 'tour-actions');
        const back = el('button', 'btn btn-ghost btn-sm', 'Back');
        back.type = 'button';
        const next = el('button', 'btn btn-primary btn-sm', 'Next');
        next.type = 'button';
        actions.append(back, next);
        card.append(top, title, body, progress, actions);
        document.body.append(backdrop, spotlight, card);

        backdrop.addEventListener('click', () => end(false));
        close.addEventListener('click', () => end(false));
        back.addEventListener('click', () => go(active.index - 1));
        next.addEventListener('click', () => (active.index === active.steps.length - 1 ? end(true) : go(active.index + 1)));
        return { backdrop, spotlight, card, count, title, body, progress, back, next };
    }

    function place() {
        if (!active) return;
        const { nodes } = active;
        const step = active.steps[active.index];
        const target = step.target ? find(step.target) : null;
        const narrow = window.innerWidth < 760;
        nodes.card.classList.toggle('is-docked', narrow);
        if (!target) {
            nodes.spotlight.hidden = true;
            nodes.backdrop.classList.add('is-dim');
            nodes.card.classList.add('is-centered');
            nodes.card.style.top = '';
            nodes.card.style.left = '';
            return;
        }
        nodes.backdrop.classList.remove('is-dim');
        nodes.card.classList.remove('is-centered');
        const pad = 6;
        const rect = target.getBoundingClientRect();
        nodes.spotlight.hidden = false;
        Object.assign(nodes.spotlight.style, {
            top: `${rect.top - pad}px`,
            left: `${rect.left - pad}px`,
            width: `${rect.width + pad * 2}px`,
            height: `${rect.height + pad * 2}px`,
        });
        if (narrow) {
            nodes.card.style.top = '';
            nodes.card.style.left = '';
            return;
        }
        // Below the element when there is room, otherwise above, otherwise beside it; kept on screen.
        const gap = 14;
        const card = nodes.card.getBoundingClientRect();
        const room = { below: window.innerHeight - rect.bottom, above: rect.top };
        let top;
        let left = rect.left + rect.width / 2 - card.width / 2;
        if (room.below >= card.height + gap + pad) top = rect.bottom + pad + gap;
        else if (room.above >= card.height + gap + pad) top = rect.top - pad - gap - card.height;
        else {
            // A tall element: beside it, level with the visible part.
            top = Math.max(16, Math.min(window.innerHeight - card.height - 16, rect.top));
            left = rect.right + pad + gap + card.width < window.innerWidth ? rect.right + pad + gap : rect.left - pad - gap - card.width;
        }
        left = Math.max(16, Math.min(window.innerWidth - card.width - 16, left));
        nodes.card.style.top = `${Math.round(top)}px`;
        nodes.card.style.left = `${Math.round(left)}px`;
    }

    function go(index) {
        if (!active || index < 0 || index >= active.steps.length) return;
        active.index = index;
        const { nodes, steps } = active;
        const step = steps[index];
        nodes.count.textContent = `${active.tour.title} · ${index + 1} of ${steps.length}`;
        nodes.title.textContent = step.title;
        nodes.body.textContent = step.body;
        nodes.progress.style.setProperty('--tour-progress', `${((index + 1) / steps.length) * 100}%`);
        nodes.back.hidden = index === 0;
        nodes.next.textContent = index === steps.length - 1 ? 'Done' : 'Next';
        const target = step.target ? find(step.target) : null;
        if (target) {
            const rect = target.getBoundingClientRect();
            const fits = rect.top >= 72 && rect.bottom <= window.innerHeight - (window.innerWidth < 760 ? 260 : 24);
            if (!fits) target.scrollIntoView({ block: rect.height > window.innerHeight * 0.6 ? 'start' : 'center', behavior: reducedMotion ? 'auto' : 'smooth' });
        }
        place();
        // Smooth scrolling moves the element after this frame; follow it until it settles.
        let frames = reducedMotion ? 0 : 40;
        const follow = () => {
            if (!active || active.index !== index) return;
            place();
            if (frames-- > 0) window.requestAnimationFrame(follow);
        };
        window.requestAnimationFrame(follow);
        nodes.card.focus({ preventScroll: true });
    }

    function onKey(event) {
        if (!active) return;
        if (event.key === 'Escape') { event.preventDefault(); end(false); }
        else if (event.key === 'ArrowRight' && !event.target.closest('input, textarea, select')) { event.preventDefault(); active.nodes.next.click(); }
        else if (event.key === 'ArrowLeft' && !event.target.closest('input, textarea, select')) { event.preventDefault(); go(active.index - 1); }
        else if (event.key === 'Tab') {
            // Keep keyboard focus inside the tour card while it is open.
            const focusable = [...active.nodes.card.querySelectorAll('button:not([hidden])')];
            const first = focusable[0];
            const last = focusable[focusable.length - 1];
            if (event.shiftKey && (document.activeElement === first || document.activeElement === active.nodes.card)) { event.preventDefault(); last.focus(); }
            else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
        }
    }

    function start(tour) {
        if (active) end(false);
        const steps = tour.steps.filter((step) => !step.target || find(step.target));
        if (!steps.length) return;
        dismissOffer();
        active = { tour, steps, index: 0, returnFocus: document.activeElement, nodes: build() };
        document.documentElement.classList.add('tour-open');
        document.addEventListener('keydown', onKey, true);
        window.addEventListener('resize', place);
        window.addEventListener('scroll', place, true);
        go(0);
    }

    function end(finished) {
        if (!active) return;
        const { nodes, tour, returnFocus } = active;
        active = null;
        store.set(tour.id, finished ? 'done' : 'seen');
        Object.values(nodes).forEach((node) => { if (node.parentNode === document.body) node.remove(); });
        document.documentElement.classList.remove('tour-open');
        document.removeEventListener('keydown', onKey, true);
        window.removeEventListener('resize', place);
        window.removeEventListener('scroll', place, true);
        document.querySelectorAll('[data-tour-start]').forEach((button) => button.classList.remove('is-new'));
        if (returnFocus && typeof returnFocus.focus === 'function') returnFocus.focus({ preventScroll: true });
    }

    // First visit to the dashboard: offer the platform tour once, without starting it.
    let offer = null;
    function dismissOffer() {
        if (offer) { offer.remove(); offer = null; }
    }
    function showOffer(tour) {
        offer = el('div', 'tour-offer');
        offer.setAttribute('role', 'status');
        const text = el('div', 'tour-offer-text');
        text.append(el('strong', '', 'New here?'), el('span', '', 'Take a short tour of what you can do in the console.'));
        const actions = el('div', 'tour-actions');
        const later = el('button', 'btn btn-ghost btn-sm', 'Not now');
        later.type = 'button';
        const begin = el('button', 'btn btn-primary btn-sm', 'Start the tour');
        begin.type = 'button';
        actions.append(later, begin);
        offer.append(text, actions);
        document.body.append(offer);
        later.addEventListener('click', () => { store.set(tour.id, 'seen'); dismissOffer(); });
        begin.addEventListener('click', () => start(tour));
    }

    function init() {
        const tour = tourForPage();
        const buttons = document.querySelectorAll('[data-tour-start]');
        buttons.forEach((button) => {
            if (!tour) {
                button.hidden = true;
                return;
            }
            button.setAttribute('aria-label', `Tour this page: ${tour.title}`);
            button.title = `Tour this page`;
            if (!store.get(tour.id)) button.classList.add('is-new');
            button.addEventListener('click', () => start(tour));
        });
        if (tour && tour.id === 'platform' && !store.get(tour.id) && buttons.length) showOffer(tour);
    }

    window.Tour = { start: (id) => { const tour = TOURS.find((item) => item.id === id); if (tour) start(tour); }, tours: TOURS };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
})();
