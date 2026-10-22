const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const request = require('supertest');
const { app, resetDatabase, createUser, browser } = require('./helpers');
const docs = require('../services/docs');

describe('documentation pages', () => {
  let member;
  beforeEach(async () => {
    await resetDatabase();
    member = await createUser();
  });

  it('serves every page of the menu to any signed-in user', async () => {
    for (const page of docs.PAGES) {
      const res = await browser('get', page.slug ? `/developer/docs/${page.slug}` : '/developer/docs', member);
      assert.equal(res.status, 200, page.slug);
      assert.match(res.text, /class="doc-content"/);
    }
  });

  it('lists every Markdown file of docs/ in the menu', () => {
    const files = fs.readdirSync(path.join(__dirname, '..', 'docs'), { recursive: true })
      .filter((file) => file.endsWith('.md'))
      .map((file) => `docs/${file.split(path.sep).join('/')}`);
    const listed = new Set(docs.PAGES.map((page) => page.file));
    assert.deepEqual(files.filter((file) => !listed.has(file)), []);
  });

  it('answers 404 for anything else, and needs a sign-in', async () => {
    for (const url of ['/developer/docs/nope', '/developer/docs/../package.json', '/developer/docs/%2e%2e/%2e%2e/.env', '/developer/docs/guides']) {
      assert.equal((await browser('get', url, member)).status, 404, url);
    }
    const anonymous = await request(app).get('/developer/docs');
    assert.equal(anonymous.status, 302);
    assert.match(anonymous.headers.location, /\/login/);
  });

  it('links pages to each other, escapes raw HTML and names headings', () => {
    const { html, headings } = docs.render([
      '## Responses from the gateway',
      'See [Concepts](../concepts.md#products), [the gateway](../../gateway/README.md#settings), [a file](../../package.json) and [Node](https://nodejs.org).',
      '<script>alert(1)</script> <img src=x onerror=alert(1)>',
    ].join('\n\n'), 'docs/guides/example.md');
    assert.match(html, /<h2 id="responses-from-the-gateway">/);
    assert.deepEqual(headings.map((heading) => heading.id), ['responses-from-the-gateway']);
    assert.match(html, /href="\/developer\/docs\/concepts#products"/);
    assert.match(html, /href="\/developer\/docs\/gateway#settings"/);
    assert.match(html, /<span class="doc-file">a file<\/span>/);
    assert.match(html, /href="https:\/\/nodejs.org" target="_blank" rel="noopener noreferrer"/);
    assert.doesNotMatch(html, /<script|<img/);
    assert.match(html, /&lt;script&gt;/);
  });

  it('points each reader at the guide for their role', async () => {
    const admin = await createUser({ orgRole: 'admin' });
    const siteAdmin = await createUser({ role: 'admin' });
    const plain = await createUser({ orgRole: 'member' });
    const pages = await Promise.all([admin, siteAdmin, plain].map((user) => browser('get', '/developer/docs', user)));
    assert.match(pages[0].text, /href="\/developer\/docs\/users\/org-admins"[^>]*class="docs-role-callout"|class="docs-role-callout" href="\/developer\/docs\/users\/org-admins"/);
    assert.match(pages[1].text, /class="docs-role-callout" href="\/developer\/docs\/users\/site-admins"/);
    assert.match(pages[2].text, /class="docs-role-callout" href="\/developer\/docs\/users\/developers"/);
  });

  it('has a Docs link in the menu', async () => {
    const res = await browser('get', '/developer/dashboard', member);
    assert.match(res.text, /href="\/developer\/docs" class="app-nav-link"/);
  });

  it('keeps every link between documentation pages working', () => {
    for (const page of docs.PAGES) {
      const loaded = docs.loadPage(page.slug);
      for (const match of loaded.html.matchAll(/href="\/developer\/docs\/?([^"#]*)(?:#([^"]*))?"/g)) {
        const target = docs.loadPage(match[1]);
        assert.ok(target, `${page.file} links to a missing page ${match[1]}`);
        if (match[2]) assert.ok(target.html.includes(`id="${match[2]}"`), `${page.file} links to a missing heading ${match[1]}#${match[2]}`);
      }
    }
  });
});
