const catalogForm = document.getElementById('catalogForm');
const catalogUrl = catalogForm.dataset.catalogUrl;

UI.bindForm(catalogForm, {
    alert: document.getElementById('catalog-alert'),
    loadingLabel: 'Saving…',
    submit: async (formData) => {
        await UI.sendJson(catalogUrl, { method: 'PUT', body: { name: formData.get('name'), description: formData.get('description') } });
        UI.flash('Catalog saved');
        window.location.reload();
    },
});

const productForm = document.getElementById('productForm');
UI.bindForm(productForm, {
    alert: document.getElementById('product-alert'),
    loadingLabel: 'Creating…',
    submit: async (formData) => {
        const result = await UI.sendJson('/api/org/products', {
            body: { name: formData.get('name'), catalogId: productForm.dataset.catalogId },
        });
        UI.flash(`${result.product.name} was created. Add APIs, then publish it.`);
        window.location.href = `/developer/products/${encodeURIComponent(result.product.id)}`;
    },
});

// Attaching checks on the server that the gateway is running.
const attachForm = document.getElementById('attachForm');
if (attachForm) {
    UI.bindForm(attachForm, {
        alert: document.getElementById('attach-alert'),
        loadingLabel: 'Checking the gateway…',
        submit: async (formData) => {
            const result = await UI.sendJson(`/api/org/gateways/${encodeURIComponent(formData.get('gatewayId'))}`, {
                method: 'PUT',
                body: { catalogId: attachForm.dataset.catalogId },
            });
            UI.flash(`${result.gateway.name} now serves this catalog. Push to deploy its products.`);
            window.location.reload();
        },
    });
}

const pushButton = document.getElementById('pushCatalog');
pushButton.addEventListener('click', async () => {
    UI.setLoading(pushButton, true, 'Pushing…');
    try {
        const { ok, results } = await UI.sendJson(`${catalogUrl}/push`);
        const failed = results.filter((result) => !result.ok).map((result) => result.gateway.name);
        UI.flash(ok
            ? `Pushed to ${results.map((result) => result.gateway.name).join(', ')}`
            : `Push did not complete for ${failed.join(', ')}. Open the gateway for details.`, ok ? 'success' : 'error');
        window.location.reload();
    } catch (error) {
        UI.toast(error.message, 'error');
        UI.setLoading(pushButton, false);
    }
});
