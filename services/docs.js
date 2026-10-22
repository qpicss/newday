// The documentation shown in the console (/developer/docs): the Markdown files of docs/ and the
// gateway README, rendered to HTML. Only the files listed in SECTIONS are served, so a URL can
// never reach another file. Raw HTML in the Markdown is escaped, links between the files become
// console URLs, and headings get ids for the page's contents.
const fs = require('fs');
const path = require('path');
const { Marked } = require('marked');

const REPO = path.join(__dirname, '..');
const BASE_URL = '/developer/docs';

// The menu of the documentation, in reading order. `roles`: who the page is mainly for, so the
// overview can point each reader at their guide.
const SECTIONS = [
  {
    title: 'Start here',
    pages: [
      { slug: '', file: 'docs/README.md', title: 'Overview' },
      { slug: 'getting-started', file: 'docs/getting-started.md', title: 'Getting started' },
      { slug: 'concepts', file: 'docs/concepts.md', title: 'Concepts' },
      { slug: 'users', file: 'docs/users/README.md', title: 'Users and roles' },
    ],
  },
  {
    title: 'Guides by role',
    pages: [
      { slug: 'users/developers', file: 'docs/users/developers.md', title: 'Developers and members', roles: ['member'] },
      { slug: 'users/org-admins', file: 'docs/users/org-admins.md', title: 'Organization admins', roles: ['orgAdmin'] },
      { slug: 'users/site-admins', file: 'docs/users/site-admins.md', title: 'Site admins', roles: ['siteAdmin'] },
    ],
  },
  {
    title: 'Tutorials',
    pages: [
      { slug: 'tutorials/01-publish-your-first-api', file: 'docs/tutorials/01-publish-your-first-api.md', title: '1. Publish your first API' },
      { slug: 'tutorials/02-design-with-the-dictionary', file: 'docs/tutorials/02-design-with-the-dictionary.md', title: '2. Design with the dictionary' },
      { slug: 'tutorials/03-edit-schemas', file: 'docs/tutorials/03-edit-schemas.md', title: '3. Edit schemas' },
      { slug: 'tutorials/04-run-a-gateway', file: 'docs/tutorials/04-run-a-gateway.md', title: '4. Run a gateway' },
      { slug: 'tutorials/05-call-an-api', file: 'docs/tutorials/05-call-an-api.md', title: '5. Call an API' },
      { slug: 'tutorials/06-protect-an-api-with-a-flow', file: 'docs/tutorials/06-protect-an-api-with-a-flow.md', title: '6. Protect an API with a flow' },
      { slug: 'tutorials/07-work-as-a-team', file: 'docs/tutorials/07-work-as-a-team.md', title: '7. Work as a team' },
      { slug: 'tutorials/08-run-the-platform', file: 'docs/tutorials/08-run-the-platform.md', title: '8. Run the platform' },
    ],
  },
  {
    title: 'API',
    pages: [
      { slug: 'guides/api-reference', file: 'docs/guides/api-reference.md', title: 'REST API reference' },
      { slug: 'guides/api-examples', file: 'docs/guides/api-examples.md', title: 'API examples' },
      { slug: 'guides/managing-people', file: 'docs/guides/managing-people.md', title: 'Managing people' },
    ],
  },
  {
    title: 'Operate',
    pages: [
      { slug: 'guides/configuration', file: 'docs/guides/configuration.md', title: 'Configuration' },
      { slug: 'guides/operations', file: 'docs/guides/operations.md', title: 'Operations' },
      { slug: 'guides/security', file: 'docs/guides/security.md', title: 'Security' },
      { slug: 'gateway', file: 'gateway/README.md', title: 'Gateway reference' },
      { slug: 'guides/development', file: 'docs/guides/development.md', title: 'Development' },
    ],
  },
];

const PAGES = SECTIONS.flatMap((section) => section.pages.map((page) => ({ ...page, section: section.title })));
const BY_SLUG = new Map(PAGES.map((page) => [page.slug, page]));
const BY_FILE = new Map(PAGES.map((page) => [page.file, page]));

const escapeHtml = (text) => String(text)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

// GitHub's heading anchors, so links such as #responses-from-the-gateway keep working.
const slugify = (text) => text.toLowerCase().replace(/<[^>]*>/g, '').replace(/&[a-z#0-9]+;/g, '')
  .replace(/[`*]/g, '').replace(/[^a-z0-9 _-]/g, '').trim().replace(/ /g, '-');

const urlOf = (slug, hash = '') => `${slug ? `${BASE_URL}/${slug}` : BASE_URL}${hash ? `#${hash}` : ''}`;

// A link as written in `file`: another documentation page, a heading, an external address, or
// a file of the repository (shown as text, since the console doesn't serve it).
const resolveLink = (href, file) => {
  if (/^(https?:|mailto:)/i.test(href)) return { href, external: true };
  if (href.startsWith('#')) return { href };
  const [target, hash = ''] = href.split('#');
  const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(file), target));
  const page = BY_FILE.get(resolved);
  return page ? { href: urlOf(page.slug, hash) } : null;
};

const render = (markdown, file) => {
  const headings = [];
  const used = new Map();
  const marked = new Marked({ gfm: true });
  marked.use({
    renderer: {
      html({ text }) {
        return escapeHtml(text);
      },
      heading({ tokens, depth }) {
        const inner = this.parser.parseInline(tokens);
        let id = slugify(inner);
        const count = used.get(id) || 0;
        used.set(id, count + 1);
        if (count) id = `${id}-${count}`;
        if (depth === 2 || depth === 3) headings.push({ id, depth, text: inner.replace(/<[^>]*>/g, '') });
        return `<h${depth} id="${id}">${inner}</h${depth}>\n`;
      },
      link({ href, title, tokens }) {
        const inner = this.parser.parseInline(tokens);
        const target = resolveLink(href, file);
        if (!target) return `<span class="doc-file">${inner}</span>`;
        const titleAttr = title ? ` title="${escapeHtml(title)}"` : '';
        const externalAttr = target.external ? ' target="_blank" rel="noopener noreferrer"' : '';
        return `<a href="${escapeHtml(target.href)}"${titleAttr}${externalAttr}>${inner}</a>`;
      },
      image({ text }) {
        return escapeHtml(text);
      },
    },
  });
  const html = marked.parse(markdown);
  return { html, headings };
};

// Rendered pages, kept until their file changes.
const cache = new Map();

const loadPage = (slug) => {
  const page = BY_SLUG.get(slug);
  if (!page) return null;
  const absolute = path.join(REPO, page.file);
  let stat;
  try {
    stat = fs.statSync(absolute);
  } catch {
    return null;
  }
  const cached = cache.get(slug);
  if (cached && cached.mtimeMs === stat.mtimeMs) return cached.result;
  const markdown = fs.readFileSync(absolute, 'utf8');
  // The page title is the first heading; the page shows it in its header instead.
  const match = markdown.match(/^#\s+(.+)\s*$/m);
  const body = match ? markdown.replace(match[0], '') : markdown;
  const { html, headings } = render(body, page.file);
  const index = PAGES.indexOf(page);
  const result = {
    ...page,
    heading: match ? match[1].replace(/`/g, '') : page.title,
    html,
    headings,
    previous: index > 0 ? { title: PAGES[index - 1].title, url: urlOf(PAGES[index - 1].slug) } : null,
    next: index < PAGES.length - 1 ? { title: PAGES[index + 1].title, url: urlOf(PAGES[index + 1].slug) } : null,
  };
  cache.set(slug, { mtimeMs: stat.mtimeMs, result });
  return result;
};

// The menu, with each page's URL.
const navigation = () => SECTIONS.map((section) => ({
  title: section.title,
  pages: section.pages.map((page) => ({ slug: page.slug, title: page.title, url: urlOf(page.slug) })),
}));

// The guide for the reader's role: site admins, then org admins of the selected organization, then members.
const guideFor = (user) => {
  const role = user.role === 'admin' ? 'siteAdmin' : user.organizationId && user.orgRole === 'admin' ? 'orgAdmin' : 'member';
  const page = PAGES.find((item) => (item.roles || []).includes(role));
  return page ? { role, title: page.title, url: urlOf(page.slug) } : null;
};

module.exports = { loadPage, navigation, guideFor, render, slugify, PAGES, BASE_URL };
