// Threat protection for the Security step: injection patterns (SQL, script/XSS, path traversal,
// command and NoSQL/prototype-pollution), size and nesting limits, IP allow and deny lists, and
// brute-force lockout after repeated failed answers.
const { createHash } = require('crypto');
const net = require('net');

// Each rule: id, label, patterns tested on lower-case text that was URL-decoded (twice, for
// double encoding). Patterns aim at attack syntax rather than words, to keep false positives low.
const RULES = {
  sqlInjection: {
    id: 'sql_injection',
    label: 'SQL injection',
    patterns: [
      /\bunion\b(\s+(all|distinct))?\s*(\/\*.*?\*\/\s*)*\(?\s*select\b/,
      /['"`]\s*(or|and|\|\||&&)\s*\(?\s*['"`]?\s*[\w$]+\s*['"`]?\s*(=|<>|!=|<=?|>=?|\blike\b|\bis\b)\s*\(?\s*['"`]?\s*[\w$]+/,
      /\b(or|and)\s+\(?\s*\d+\s*(=|<>|!=)\s*\d+/,
      /['"`]\s*(--(\s|$)|\/\*|#\s*$)/,
      /;\s*(drop|delete|insert|update|alter|truncate|create|exec|execute|shutdown|declare|grant|revoke)\s/,
      /\b(sleep|benchmark|pg_sleep|dbms_pipe\.receive_message)\s*\(/,
      /\bwaitfor\s+delay\s+['"]/,
      /\b(information_schema|sysobjects|syscolumns|pg_catalog|sqlite_master|xp_cmdshell)\b/,
      /\bload_file\s*\(|\binto\s+(out|dump)file\b/,
      /\b(exec|execute)\s*(\(|\s)\s*(sp_|xp_)\w+/,
    ],
  },
  scriptInjection: {
    id: 'script_injection',
    label: 'Script injection (XSS)',
    patterns: [
      /<\s*script\b/,
      /<\s*\/\s*script\s*>/,
      /\b(javascript|vbscript|livescript)\s*:/,
      /<[a-z][^>]*[\s/]on[a-z]{3,}\s*=/,
      /<\s*(iframe|frame|frameset|object|embed|applet)\b/,
      /\bdata\s*:\s*text\/html/,
      /\bexpression\s*\(|\bsrcdoc\s*=/,
    ],
  },
  pathTraversal: {
    id: 'path_traversal',
    label: 'Path traversal',
    patterns: [
      /(^|[\\/])\.\.([\\/]|$)/,
      /\0/,
      /\/etc\/(passwd|shadow|hosts)\b|\bc:\\windows\\|\bboot\.ini\b|\/proc\/self\//,
    ],
  },
  commandInjection: {
    id: 'command_injection',
    label: 'Command injection',
    patterns: [
      // Unmistakable commands after a shell separator; short words only with an argument or at the end.
      /(;|&&|\|\|?|`|\$\()\s*(whoami|uname|wget|curl|ncat|netcat|bash|zsh|powershell|pwsh|cmd(\.exe)?|python3?|perl|ruby|php|chmod|chown|nslookup)\b/,
      /(;|&&|\|\|?|`|\$\()\s*(cat|ls|id|nc|rm|sh|kill|ping|sleep)(\s+[-/~.$\d]|\s*($|[;|&`)]))/,
      /\$\{\s*(jndi|env|sys|java|lower|upper|date)\s*:/,
    ],
  },
};

// Keys that turn a JSON or query object into a database operator or reach Object.prototype.
const NOSQL_KEY = /^\$(where|ne|eq|gt|gte|lt|lte|in|nin|regex|exists|expr|or|and|not|nor|function|accumulator|elemMatch|jsonSchema|lookup|text)$/i;
const POLLUTION_KEY = /^(__proto__|constructor|prototype)$/;
const QUERY_OPERATOR = /\[\s*(\$\w+|__proto__|constructor|prototype)\s*\]/i;

const INJECTIONS = ['sqlInjection', 'scriptInjection', 'pathTraversal', 'commandInjection'];
// Headers whose values are not user input worth scanning (or are scanned by the HTTP parser).
const SKIP_HEADERS = new Set(['accept', 'accept-encoding', 'accept-language', 'content-type', 'content-length', 'connection', 'host', 'traceparent', 'tracestate', 'x-request-id', 'cache-control', 'pragma']);
const MAX_SCAN = 1024 * 1024;

const safeDecode = (text) => {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
};
const normalize = (text) => {
  let value = String(text).slice(0, MAX_SCAN);
  for (let round = 0; round < 2 && /%[0-9a-f]{2}/i.test(value); round += 1) value = safeDecode(value);
  // Entity-encoded markup (&lt;script) hides patterns too.
  return value.toLowerCase()
    .replace(/&(lt|#0*60|#x0*3c);?/g, '<').replace(/&(gt|#0*62|#x0*3e);?/g, '>')
    .replace(/&(quot|#0*34|#x0*22);?/g, '"').replace(/&(apos|#0*39|#x0*27);?/g, "'");
};
// SQL inline comments separate words (UNION/**/SELECT), so patterns also see them as spaces.
const withoutComments = (text) => (text.includes('/*') ? text.replace(/\/\*.*?\*\//gs, ' ') : text);

// Every value of a parsed JSON body: [location, text] pairs, plus a list of object keys.
const walkJson = (value, location, out, depth = 0) => {
  if (depth > 200 || out.values.length > 50000) return;
  if (typeof value === 'string') out.values.push([location, value]);
  else if (Array.isArray(value)) value.forEach((item, index) => walkJson(item, `${location}[${index}]`, out, depth + 1));
  else if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      out.keys.push([`${location}.${key}`, key]);
      out.values.push([`${location}.${key} (name)`, key]);
      walkJson(item, `${location}.${key}`, out, depth + 1);
    }
  }
};

// Depth and number of entries of a JSON value, without recursion limits of its own.
const measureJson = (value) => {
  let depth = 0;
  let entries = 0;
  const stack = [[value, 1]];
  while (stack.length) {
    const [item, level] = stack.pop();
    if (!item || typeof item !== 'object') continue;
    depth = Math.max(depth, level);
    const children = Array.isArray(item) ? item : Object.values(item);
    entries += children.length;
    children.forEach((child) => stack.push([child, level + 1]));
  }
  return { depth, entries };
};

// ---------------------------------------------------------------- IP addresses

const ipToBigInt = (address) => {
  const plain = address.replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/i, '');
  if (net.isIPv4(plain)) return { version: 4, value: plain.split('.').reduce((sum, part) => (sum << 8n) + BigInt(part), 0n) };
  if (!net.isIPv6(plain)) return null;
  const [head, tail = ''] = plain.split('::');
  const parts = (text) => (text ? text.split(':') : []);
  const groups = plain.includes('::')
    ? [...parts(head), ...Array(Math.max(0, 8 - parts(head).length - parts(tail).length)).fill('0'), ...parts(tail)]
    : parts(head);
  // IPv6 with an embedded IPv4 part (other than ::ffff:, handled above) is not supported in lists.
  if (groups.length !== 8 || groups.some((group) => !/^[0-9a-f]{1,4}$/i.test(group))) return null;
  return { version: 6, value: groups.reduce((sum, group) => (sum << 16n) + BigInt(parseInt(group || '0', 16)), 0n) };
};

// "10.0.0.0/8", "203.0.113.7", "2001:db8::/32" -> a matcher, or null when the text is not one.
const parseCidr = (text) => {
  const [address, bits] = String(text).trim().split('/');
  const ip = ipToBigInt(address || '');
  if (!ip) return null;
  const size = ip.version === 4 ? 32 : 128;
  const prefix = bits === undefined ? size : Number(bits);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > size) return null;
  const shift = BigInt(size - prefix);
  return { version: ip.version, network: ip.value >> shift, shift };
};
const inRanges = (address, ranges) => {
  const ip = ipToBigInt(address || '');
  return Boolean(ip) && ranges.some((range) => range.version === ip.version && (ip.value >> range.shift) === range.network);
};

// ---------------------------------------------------------------- brute force

// Failed answers per key on this gateway node. Keys are hashed, so user names never sit in memory.
const createFailureTracker = ({ maxKeys = 50000, now = () => Date.now() } = {}) => {
  const entries = new Map();
  const id = (scope, key) => createHash('sha256').update(`${scope}\n${key}`).digest('base64url');
  const prune = () => {
    const time = now();
    for (const [name, entry] of entries) {
      if (entry.until <= time && entry.windowEnds <= time) entries.delete(name);
      if (entries.size <= maxKeys * 0.9) break;
    }
    // Still full: drop the oldest entries.
    for (const name of entries.keys()) {
      if (entries.size <= maxKeys * 0.9) break;
      entries.delete(name);
    }
  };
  return {
    // Seconds the key stays locked out, 0 when it may try.
    lockedFor(scope, key) {
      const entry = entries.get(id(scope, key));
      const left = entry ? entry.until - now() : 0;
      return left > 0 ? Math.ceil(left / 1000) : 0;
    },
    // Counts one failure; true when it locked the key out.
    fail(scope, key, { maxFailures, windowSeconds, lockoutSeconds }) {
      const name = id(scope, key);
      const time = now();
      let entry = entries.get(name);
      if (!entry || entry.windowEnds <= time) entry = { count: 0, windowEnds: time + windowSeconds * 1000, until: 0 };
      entry.count += 1;
      entries.delete(name);
      entries.set(name, entry);
      if (entries.size > maxKeys) prune();
      if (entry.count >= maxFailures) {
        entry.until = time + lockoutSeconds * 1000;
        entry.count = 0;
        entry.windowEnds = entry.until;
        return true;
      }
      return false;
    },
    succeed(scope, key) {
      entries.delete(id(scope, key));
    },
    get size() {
      return entries.size;
    },
  };
};

// ---------------------------------------------------------------- the step

const KB = 1024;

// Inspects the request as the flow has it now. Returns { findings, reply?, watch? }:
// findings are { rule, label, location } (values themselves are never echoed or logged);
// reply is the answer when the request is blocked (mode "block"); watch asks the pipeline to
// count the final answer for brute-force protection.
//   ctx: { remoteAddress, clientId, tracker, scope }
const inspect = (config, request, ctx) => {
  const findings = [];
  const blocked = (status, error, message, finding, headers = {}) => ({ status, error, message, finding, headers });
  const monitor = config.mode === 'monitor';
  let block = null;
  const found = (finding, reply) => {
    findings.push(finding);
    if (!block && reply) block = reply;
  };

  // Who may call at all.
  const address = ctx.remoteAddress || '';
  if (config.ipDeny.length && inRanges(address, config.ipDeny.map(parseCidr).filter(Boolean))) {
    const finding = { rule: 'ip_denied', label: 'Address on the deny list', location: 'client address' };
    found(finding, blocked(403, 'access_denied', 'Requests from your address are not allowed', finding));
  } else if (config.ipAllow.length && !inRanges(address, config.ipAllow.map(parseCidr).filter(Boolean))) {
    const finding = { rule: 'ip_not_allowed', label: 'Address not on the allow list', location: 'client address' };
    found(finding, blocked(403, 'access_denied', 'Requests from your address are not allowed', finding));
  }

  // Brute force: refuse keys that failed too often; count this request's answer afterwards.
  let watch = null;
  if (config.bruteForce) {
    const key = bruteKey(config, request, ctx);
    if (key) {
      const seconds = ctx.tracker.lockedFor(ctx.scope, key);
      if (seconds) {
        const finding = { rule: 'brute_force', label: 'Too many failed attempts', location: config.bruteKey === 'ip' ? 'client address' : config.bruteKey === 'client' ? 'client ID' : `${config.bruteKey}.${config.bruteKeyName}` };
        found(finding, blocked(429, 'too_many_failures', `Too many failed attempts. Try again in ${seconds} seconds.`, finding, { 'retry-after': String(seconds) }));
      } else {
        watch = { scope: ctx.scope, key, statuses: config.bruteStatuses, maxFailures: config.bruteMax, windowSeconds: config.bruteWindow, lockoutSeconds: config.bruteLockout };
      }
    }
  }

  // Size and shape.
  const contentType = String(request.headers['content-type'] || '').toLowerCase();
  const isJson = /[/+]json\b/.test(contentType);
  let json;
  if (request.body.length && isJson) {
    try {
      json = JSON.parse(request.body.toString('utf8'));
    } catch {
      json = undefined;
    }
  }
  if (config.maxBodyKb && request.body.length > config.maxBodyKb * KB) {
    const finding = { rule: 'body_too_large', label: 'Body larger than allowed', location: 'body' };
    found(finding, blocked(413, 'payload_too_large', `The request body is larger than ${config.maxBodyKb} KB`, finding));
  }
  if (json !== undefined && (config.maxJsonDepth || config.maxJsonEntries)) {
    const size = measureJson(json);
    if (config.maxJsonDepth && size.depth > config.maxJsonDepth) {
      const finding = { rule: 'json_too_deep', label: 'JSON nested too deeply', location: 'body' };
      found(finding, blocked(400, 'request_too_complex', `The JSON body is nested deeper than ${config.maxJsonDepth} levels`, finding));
    }
    if (config.maxJsonEntries && size.entries > config.maxJsonEntries) {
      const finding = { rule: 'json_too_many_entries', label: 'JSON with too many entries', location: 'body' };
      found(finding, blocked(400, 'request_too_complex', `The JSON body has more than ${config.maxJsonEntries} entries`, finding));
    }
  }

  // What to scan, as [location, text].
  const targets = [];
  if (config.scanPath) targets.push(['path', request.path]);
  if (config.scanQuery) {
    for (const [name, value] of Object.entries(request.query || {})) {
      targets.push([`query.${name} (name)`, name]);
      [].concat(value).forEach((item) => targets.push([`query.${name}`, String(item)]));
    }
  }
  if (config.scanHeaders) {
    for (const [name, value] of Object.entries(request.headers || {})) {
      if (!SKIP_HEADERS.has(name)) [].concat(value).forEach((item) => targets.push([`header ${name}`, String(item)]));
    }
  }
  const keys = [];
  if (config.scanBody && request.body.length) {
    if (json !== undefined) {
      const out = { values: [], keys };
      walkJson(json, 'body', out);
      targets.push(...out.values);
    } else if (contentType.startsWith('application/x-www-form-urlencoded')) {
      for (const [name, value] of new URLSearchParams(request.body.toString('utf8'))) {
        targets.push([`body.${name} (name)`, name], [`body.${name}`, value]);
        keys.push([`body.${name}`, name]);
      }
    } else if (!contentType || /^text\/|[/+](xml|json)\b|javascript|graphql/.test(contentType)) {
      targets.push(['body', request.body.subarray(0, MAX_SCAN).toString('utf8')]);
    }
  }

  const reported = new Set();
  const injection = (finding) => {
    const key = `${finding.rule}:${finding.location}`;
    if (reported.has(key) || findings.length >= 20) return;
    reported.add(key);
    found(finding, blocked(403, 'request_blocked', `The request was blocked by the gateway's threat protection (${finding.label.toLowerCase()} in ${finding.location})`, finding));
  };
  const active = INJECTIONS.filter((name) => config[name]);
  for (const [location, raw] of targets) {
    if (findings.length >= 20) break;
    const text = normalize(raw);
    const flat = withoutComments(text);
    for (const name of active) {
      const rule = RULES[name];
      if (rule.patterns.some((pattern) => pattern.test(text) || (flat !== text && pattern.test(flat)))) injection({ rule: rule.id, label: rule.label, location });
    }
  }
  if (config.nosqlInjection) {
    const operatorKeys = [...keys];
    if (config.scanQuery) Object.keys(request.query || {}).forEach((name) => operatorKeys.push([`query.${name}`, name]));
    for (const [location, key] of operatorKeys) {
      if (NOSQL_KEY.test(key) || POLLUTION_KEY.test(key) || QUERY_OPERATOR.test(key)) {
        injection({ rule: 'nosql_injection', label: 'NoSQL operator or prototype key', location });
      }
    }
  }

  if (monitor) return { findings, watch };
  return { findings, watch: block ? null : watch, reply: block };
};

const bruteKey = (config, request, ctx) => {
  switch (config.bruteKey) {
    case 'client': return ctx.clientId || null;
    case 'header': {
      const value = request.headers[config.bruteKeyName];
      return value ? String(value) : null;
    }
    case 'body': {
      try {
        const data = JSON.parse(request.body.toString('utf8'));
        const value = config.bruteKeyName.split('.').reduce((item, part) => (item && typeof item === 'object' ? item[part] : undefined), data);
        return value === undefined || value === null || typeof value === 'object' ? null : String(value);
      } catch {
        const value = new URLSearchParams(request.body.toString('utf8')).get(config.bruteKeyName);
        return value || null;
      }
    }
    default: return (ctx.remoteAddress || '').replace(/^::ffff:/i, '') || null;
  }
};

// After the flows: a watched request whose answer is a failure counts towards the lockout;
// a success clears the key's count.
const recordAnswer = (watches, status, tracker) => {
  for (const watch of watches || []) {
    if (watch.statuses.includes(status)) tracker.fail(watch.scope, watch.key, watch);
    else if (status < 400) tracker.succeed(watch.scope, watch.key);
  }
};

module.exports = { inspect, recordAnswer, createFailureTracker, parseCidr, inRanges, normalize, RULES };
