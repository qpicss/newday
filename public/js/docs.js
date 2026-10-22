// Documentation pages: copy buttons on code blocks, the menu folded on narrow screens, and the
// "On this page" list following the section being read.
(function () {
    const content = document.querySelector('[data-doc-content]');

    // A copy button on each code block.
    content.querySelectorAll('pre').forEach((pre) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'btn btn-ghost btn-sm docs-copy';
        button.textContent = 'Copy';
        button.setAttribute('aria-label', 'Copy this code');
        button.addEventListener('click', async () => {
            try {
                await navigator.clipboard.writeText(pre.querySelector('code') ? pre.querySelector('code').textContent : pre.textContent);
                button.textContent = 'Copied';
            } catch (error) {
                button.textContent = 'Press Ctrl+C';
                const range = document.createRange();
                range.selectNodeContents(pre);
                const selection = window.getSelection();
                selection.removeAllRanges();
                selection.addRange(range);
            }
            setTimeout(() => { button.textContent = 'Copy'; }, 1600);
        });
        const wrap = document.createElement('div');
        wrap.className = 'docs-code';
        pre.replaceWith(wrap);
        wrap.append(pre, button);
    });

    // Wide tables scroll inside their own box.
    content.querySelectorAll('table').forEach((table) => {
        const wrap = document.createElement('div');
        wrap.className = 'docs-table';
        table.replaceWith(wrap);
        wrap.append(table);
    });

    // The menu starts folded on phones, so the page comes first.
    const menu = document.querySelector('[data-docs-menu]');
    if (menu && window.matchMedia('(max-width: 960px)').matches) menu.open = false;

    // Marks the section in view in "On this page".
    const links = [...document.querySelectorAll('[data-toc-link]')];
    if (!links.length || !('IntersectionObserver' in window)) return;
    const byId = new Map(links.map((link) => [decodeURIComponent(link.hash.slice(1)), link]));
    const visible = new Set();
    const observer = new IntersectionObserver((entries) => {
        entries.forEach((entry) => {
            if (entry.isIntersecting) visible.add(entry.target.id);
            else visible.delete(entry.target.id);
        });
        const first = [...byId.keys()].find((id) => visible.has(id));
        if (!first) return;
        links.forEach((link) => link.removeAttribute('aria-current'));
        byId.get(first).setAttribute('aria-current', 'true');
    }, { rootMargin: '-72px 0px -60% 0px' });
    byId.forEach((link, id) => {
        const heading = document.getElementById(id);
        if (heading) observer.observe(heading);
    });
})();
