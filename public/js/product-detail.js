const productUrl = document.getElementById('infoForm').dataset.productUrl;

const saveProduct = async (body, message) => {
    await UI.sendJson(productUrl, { method: 'PUT', body });
    UI.flash(message);
    window.location.reload();
};

UI.bindForm(document.getElementById('infoForm'), {
    alert: document.getElementById('info-alert'),
    loadingLabel: 'Saving…',
    submit: (formData) => saveProduct({
        name: formData.get('name'),
        description: formData.get('description'),
    }, 'Product info saved'),
});

UI.bindForm(document.getElementById('addApiForm'), {
    alert: document.getElementById('api-alert'),
    loadingLabel: 'Adding…',
    submit: async (formData) => {
        await UI.sendJson(`${productUrl}/apis`, { body: { apiId: formData.get('apiId') } });
        UI.flash('API added to the product');
        window.location.reload();
    },
});

// Rate limit: show fields and a plain-language preview only when enabled.
const rateLimitForm = document.getElementById('rateLimitForm');
const rateEnabled = rateLimitForm.querySelector('[name="rateLimitEnabled"]');
const rateRequests = rateLimitForm.querySelector('[name="rateLimitRequests"]');
const ratePeriod = rateLimitForm.querySelector('[name="rateLimitPeriod"]');
const ratePreview = rateLimitForm.querySelector('[data-rate-limit-preview]');

function updateRateLimit() {
    const enabled = rateEnabled.checked;
    rateLimitForm.querySelector('[data-rate-limit-fields]').hidden = !enabled;
    rateRequests.required = enabled;
    const requests = Number(rateRequests.value);
    ratePreview.textContent = enabled && requests > 0
        ? `Each application can make up to ${requests.toLocaleString('en-US')} request${requests === 1 ? '' : 's'} per ${ratePeriod.value}.`
        : 'Applications can make unlimited requests.';
}
[rateEnabled, rateRequests, ratePeriod].forEach((input) => input.addEventListener('input', updateRateLimit));
updateRateLimit();

UI.bindForm(rateLimitForm, {
    alert: document.getElementById('rate-alert'),
    loadingLabel: 'Saving…',
    submit: (formData) => saveProduct({
        rateLimitEnabled: rateEnabled.checked,
        ...(rateEnabled.checked && {
            rateLimitRequests: Number(formData.get('rateLimitRequests')),
            rateLimitPeriod: formData.get('rateLimitPeriod'),
        }),
    }, 'Rate limit saved'),
});

// Billing: price fields for paid plans, interval only for flat fees.
const billingForm = document.getElementById('billingForm');

function updateBilling() {
    const plan = billingForm.querySelector('[name="billingPlan"]:checked')?.value || 'free';
    billingForm.querySelector('[data-billing-paid]').hidden = plan === 'free';
    billingForm.querySelector('[data-billing-interval]').hidden = plan !== 'flat';
    billingForm.querySelector('[data-price-label]').textContent = plan === 'usage' ? 'Price per 1,000 requests' : 'Price';
    billingForm.querySelector('[name="billingPrice"]').required = plan !== 'free';
}
billingForm.addEventListener('change', updateBilling);
updateBilling();

UI.bindForm(billingForm, {
    alert: document.getElementById('billing-alert'),
    loadingLabel: 'Saving…',
    submit: (formData) => {
        const plan = formData.get('billingPlan');
        return saveProduct({
            billingPlan: plan,
            ...(plan !== 'free' && {
                billingPrice: Number(formData.get('billingPrice')),
                billingCurrency: formData.get('billingCurrency'),
            }),
            ...(plan === 'flat' && { billingInterval: formData.get('billingInterval') }),
        }, 'Billing saved');
    },
});
