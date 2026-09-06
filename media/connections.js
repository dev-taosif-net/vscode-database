// @ts-check
/**
 * The connection editor. The host owns the profiles and every secret; this
 * file owns the draft the user is typing into and the derived readings that
 * have to update as they type (the header chips, the transport dot, the
 * connection string). A password is never sent from the host to this page, so
 * the field starts empty and only carries what the user just typed.
 */
(function () {
  const vscode = acquireVsCodeApi();

  const ENVIRONMENTS = [
    { id: 'dev', label: 'Development', short: 'DEV', hint: 'No extra guards. Metadata is cached for the whole session so the object tree opens instantly.' },
    { id: 'qa', label: 'QA', short: 'QA', hint: 'An UPDATE or DELETE with no WHERE clause asks for confirmation before it runs.' },
    { id: 'uat', label: 'UAT', short: 'UAT', hint: 'The same guard as QA, and the environment name goes into the query history.' },
    { id: 'prod', label: 'Production', short: 'PROD', hint: 'Sessions open read-only, connecting asks for confirmation, no credential is kept by default, and schema changes are refused until the session is switched to read-write.' }
  ];

  const SECTIONS = [
    { id: 'identity', label: 'Identity' },
    { id: 'server', label: 'Server' },
    { id: 'auth', label: 'Authentication' },
    { id: 'transport', label: 'Transport' },
    { id: 'credentials', label: 'Credentials' },
    { id: 'network', label: 'Network' },
    { id: 'session', label: 'Session' },
    { id: 'properties', label: 'Properties' }
  ];

  const ENCRYPT_HINT = {
    strict: 'The channel is encrypted before the login packet leaves the machine and the certificate must validate. Needs SQL Server 2022 or Azure SQL.',
    mandatory: 'The connection is refused when the server cannot encrypt. The driver default, and the right choice almost everywhere.',
    optional: 'Falls back to an unencrypted channel when the server does not offer encryption. Reasonable only on a loopback host.'
  };

  const SSL_HINT = {
    disable: 'No encryption at all. Reasonable only on a loopback host.',
    allow: 'Tries plain text first and only encrypts if the server insists. Offers no real protection.',
    prefer: 'Encrypts when it can and silently falls back when it cannot. The libpq default, and weaker than it looks.',
    require: 'Always encrypts, but never checks who the server is. Stops passive sniffing, not interception.',
    'verify-ca': 'Encrypts and checks that the certificate came from a trusted authority.',
    'verify-full': 'Encrypts, checks the issuer, and checks the host name against the certificate. Use this anywhere but a development machine.'
  };

  const ICONS = {
    search: '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3"><circle cx="7" cy="7" r="4.2"/><path d="M10.2 10.2 14 14"/></svg>',
    add: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3"><path d="M8 3.4v9.2M3.4 8h9.2"/></svg>',
    more: '<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><circle cx="3.4" cy="8" r="1"/><circle cx="8" cy="8" r="1"/><circle cx="12.6" cy="8" r="1"/></svg>',
    caret: '<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M4.5 6.5 8 10l3.5-3.5"/></svg>',
    caretGroup: '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M4.5 6.5 8 10l3.5-3.5"/></svg>',
    refresh: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3"><path d="M13.1 7.4A5.2 5.2 0 1 0 12 11.5"/><path d="M13.5 3.9v3.6H9.9"/></svg>',
    eye: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2"><path d="M1.4 8S3.9 3.7 8 3.7 14.6 8 14.6 8 12.1 12.3 8 12.3 1.4 8 1.4 8z"/><circle cx="8" cy="8" r="2.1"/></svg>',
    copy: '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2"><rect x="5.6" y="5.6" width="8.2" height="8.8" rx="1.2"/><path d="M10.6 5.6V3a1 1 0 0 0-1-1H3.2a1 1 0 0 0-1 1v7.6a1 1 0 0 0 1 1h1.2"/></svg>',
    flask: '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2"><path d="M6.4 2.2h3.2M8 2.2v4.1L12 12a1.4 1.4 0 0 1-1.2 2.1H5.2A1.4 1.4 0 0 1 4 12l4-5.7"/></svg>',
    ok: '<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3"><circle cx="8" cy="8" r="6.3"/><path d="m5.3 8.2 2 2 3.5-4.3"/></svg>',
    error: '<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3"><circle cx="8" cy="8" r="6.3"/><path d="m5.9 5.9 4.2 4.2M10.1 5.9l-4.2 4.2"/></svg>',
    warn: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2"><path d="M8 2.3 14.2 13.2H1.8z"/><path d="M8 6.5v3.1M8 11.2v.6"/></svg>',
    info: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2"><circle cx="8" cy="8" r="6.3"/><path d="M8 7.3v3.7M8 5v.8"/></svg>',
    spinner: '<svg class="spin" width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="8" cy="8" r="6" stroke-dasharray="28 12" stroke-linecap="round"/></svg>',
    shield: '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3"><path d="M8 1.9l5.4 2.1v4.3c0 3.3-2.2 5.8-5.4 6.8-3.2-1-5.4-3.5-5.4-6.8V4z"/></svg>',
    server: '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3"><rect x="2" y="2.6" width="12" height="4.4" rx="1.1"/><rect x="2" y="9" width="12" height="4.4" rx="1.1"/><path d="M4.4 4.8h.01M4.4 11.2h.01"/></svg>',
    key: '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3"><circle cx="5.4" cy="9.6" r="2.7"/><path d="M7.3 7.7 13 2M11 4l1.5 1.5M12.4 2.6l1.5 1.5"/></svg>',
    lock: '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3"><rect x="3.2" y="7" width="9.6" height="6.8" rx="1.2"/><path d="M5.4 7V5a2.6 2.6 0 0 1 5.2 0v2"/></svg>',
    tunnel: '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3"><circle cx="4" cy="4" r="2"/><circle cx="12" cy="12" r="2"/><path d="M4 6v4a2 2 0 0 0 2 2h4"/></svg>',
    clock: '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3"><circle cx="8" cy="8" r="6.3"/><path d="M8 4.6V8l2.4 1.6"/></svg>',
    list: '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3"><path d="M2.6 4.4h10.8M2.6 8h10.8M2.6 11.6h10.8"/></svg>',
    mssql: '<svg viewBox="0 0 24 24" fill="currentColor"><ellipse cx="12" cy="5.4" rx="7.6" ry="2.9"/><path d="M4.4 8.6v3.2c0 1.6 3.4 2.9 7.6 2.9s7.6-1.3 7.6-2.9V8.6c-1.5 1.2-4.3 1.9-7.6 1.9s-6.1-.7-7.6-1.9z"/><path d="M4.4 14.6v3.2c0 1.6 3.4 2.9 7.6 2.9s7.6-1.3 7.6-2.9v-3.2c-1.5 1.2-4.3 1.9-7.6 1.9s-6.1-.7-7.6-1.9z"/></svg>',
    postgres: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 1.8 20.4 6.7v9.8L12 21.4 3.6 16.5V6.7z"/><circle cx="12" cy="11.6" r="3.1" fill="var(--bg-editor)"/></svg>'
  };

  /** @type {any} */
  let state = { profiles: [], selectedId: null, connected: [], busy: null, hasSecret: {}, results: {} };
  /** @type {any} */
  let draft = null;
  /** @type {any} */
  let baseline = null;
  /** @type {string | undefined} typed password, cleared whenever the selection moves */
  let secretDraft;
  let revealSecret = false;
  let activeSection = 'identity';
  let filter = '';

  const root = document.getElementById('root');

  window.addEventListener('message', (event) => {
    const message = event.data;
    if (message.type === 'state') {
      const selectionMoved = message.selectedId !== state.selectedId;
      state = message;
      if (message.reload || selectionMoved || !draft || draft.id !== message.selectedId) {
        loadDraft();
      } else {
        baseline = state.profiles.find((p) => p.id === state.selectedId) || baseline;
      }
      render();
    } else if (message.type === 'databases') {
      if (draft && draft.id === message.profileId) {
        draft.__databases = message.databases;
        render();
      }
    } else if (message.type === 'patch') {
      // The host applied something on our behalf, such as "trust it once".
      if (draft && draft.id === message.profileId) {
        Object.assign(draft, message.patch);
        render();
      }
    }
  });

  function loadDraft() {
    const profile = state.profiles.find((p) => p.id === state.selectedId);
    baseline = profile || null;
    draft = profile ? JSON.parse(JSON.stringify(profile)) : null;
    secretDraft = undefined;
    revealSecret = false;
    activeSection = 'identity';
  }

  /* ------------------------------------------------------------- helpers */

  function el(tag, attrs, ...children) {
    const node = document.createElement(tag);
    if (attrs) {
      for (const [key, value] of Object.entries(attrs)) {
        if (value === undefined || value === null || value === false) {
          continue;
        }
        if (key === 'class') {
          node.className = String(value);
        } else if (key === 'html') {
          node.innerHTML = String(value); // only ever a constant from ICONS
        } else if (key.startsWith('on') && typeof value === 'function') {
          node.addEventListener(key.slice(2).toLowerCase(), value);
        } else if (key === 'style' && typeof value === 'object') {
          Object.assign(node.style, value);
        } else if (value === true) {
          node.setAttribute(key, '');
        } else {
          node.setAttribute(key, String(value));
        }
      }
    }
    for (const child of children.flat()) {
      if (child === null || child === undefined || child === false) {
        continue;
      }
      node.append(typeof child === 'string' || typeof child === 'number' ? String(child) : child);
    }
    return node;
  }

  function icon(name, extra) {
    return el('span', { class: extra ? `ico ${extra}` : 'ico', html: ICONS[name], 'aria-hidden': 'true' });
  }

  function engineMark(driver, size) {
    const wrap = el('span', {
      class: 'ico',
      html: driver === 'postgres' ? ICONS.postgres : ICONS.mssql,
      style: { display: 'inline-flex', color: `var(--eng-${driver})`, width: `${size}px`, height: `${size}px` }
    });
    const svg = wrap.firstElementChild;
    if (svg) {
      svg.setAttribute('width', String(size));
      svg.setAttribute('height', String(size));
    }
    return wrap;
  }

  function enginePlate(driver, plateSize, markSize) {
    return el(
      'span',
      {
        class: 'plate',
        style: {
          width: `${plateSize}px`,
          height: `${plateSize}px`,
          background: `color-mix(in srgb, var(--eng-${driver}) 14%, transparent)`
        }
      },
      engineMark(driver, markSize)
    );
  }

  function envOf(id) {
    return ENVIRONMENTS.find((e) => e.id === id) || ENVIRONMENTS[0];
  }

  function transportStrength(p) {
    if (p.driver === 'mssql') {
      if (p.encrypt === 'optional') {
        return 'weakened';
      }
      return p.trustServerCertificate ? 'weakened' : 'verified';
    }
    if (p.sslMode === 'disable' || p.sslMode === 'allow') {
      return 'off';
    }
    if (p.sslMode === 'prefer' || p.sslMode === 'require') {
      return 'weakened';
    }
    return 'verified';
  }

  function strengthColour(strength) {
    if (strength === 'verified') {
      return 'var(--chip-ok)';
    }
    return strength === 'weakened' ? 'var(--chip-warn)' : 'var(--chip-bad)';
  }

  function transportLabel(p) {
    if (p.driver === 'mssql') {
      if (p.trustServerCertificate) {
        return 'TLS unverified';
      }
      if (p.encrypt === 'strict') {
        return 'TLS strict';
      }
      return p.encrypt === 'mandatory' ? 'TLS required' : 'TLS optional';
    }
    return `SSL ${p.sslMode}`;
  }

  function authLabel(p) {
    if (p.driver === 'mssql') {
      return { sql: 'SQL login', 'entra-mfa': 'Entra MFA', ntlm: 'Windows NTLM' }[p.mssqlAuth] || 'Auth';
    }
    return { password: 'SCRAM', certificate: 'Client cert', none: 'No credential' }[p.pgAuth] || 'Auth';
  }

  function needsSecret(p) {
    return p.driver === 'mssql' ? p.mssqlAuth === 'sql' || p.mssqlAuth === 'ntlm' : p.pgAuth === 'password';
  }

  function chip(label, tone) {
    return el(
      'span',
      {
        class: 'chip',
        style: {
          color: `var(--chip-${tone})`,
          background: `color-mix(in srgb, var(--chip-${tone}) 13%, transparent)`,
          borderColor: `color-mix(in srgb, var(--chip-${tone}) 38%, transparent)`
        }
      },
      label
    );
  }

  function isDirty() {
    if (!draft || !baseline) {
      return false;
    }
    if (secretDraft !== undefined) {
      return true;
    }
    return JSON.stringify(stripLocal(draft)) !== JSON.stringify(stripLocal(baseline));
  }

  function stripLocal(profile) {
    const copy = { ...profile };
    delete copy.__databases;
    delete copy.updatedAt;
    return copy;
  }

  function connectionString(p) {
    const port = p.port ? `${p.port}` : '';
    if (p.driver === 'mssql') {
      const user = p.user || 'user';
      const auth =
        p.mssqlAuth === 'entra-mfa'
          ? 'Authentication=Active Directory Interactive'
          : p.mssqlAuth === 'ntlm'
            ? `Integrated Security=True${p.domain ? `;Domain=${p.domain}` : ''}`
            : `User ID=${user};Password=********`;
      const encrypt = p.encrypt === 'strict' ? 'Strict' : p.encrypt === 'optional' ? 'Optional' : 'Mandatory';
      return [
        `Server=${p.host}${port ? `,${port}` : ''}`,
        `Database=${p.database}`,
        auth,
        `Encrypt=${encrypt}`,
        `TrustServerCertificate=${p.trustServerCertificate ? 'True' : 'False'}`,
        `Application Name=${p.applicationName}`,
        `Connect Timeout=${p.connectTimeoutSeconds}`
      ].join(';');
    }
    const credential = p.pgAuth === 'password' ? `${p.user || 'user'}:********@` : p.user ? `${p.user}@` : '';
    return (
      `postgresql://${credential}${p.host}${port ? `:${port}` : ''}/${p.database}` +
      `?sslmode=${p.sslMode}&connect_timeout=${p.connectTimeoutSeconds}` +
      `&application_name=${encodeURIComponent(p.applicationName)}`
    );
  }

  function post(type, payload) {
    vscode.postMessage({ type, ...payload });
  }

  /** Everything the host needs to attempt or save, including a typed secret. */
  function payload() {
    return { id: draft.id, patch: stripLocal(draft), secret: secretDraft };
  }

  /* -------------------------------------------------------------- render */

  function render() {
    if (!root) {
      return;
    }
    const scroll = root.querySelector('.form')?.scrollTop ?? 0;
    root.replaceChildren(
      el('div', { class: 'page' }, renderRail(), draft ? renderDetail() : renderEmpty())
    );
    const form = root.querySelector('.form');
    if (form) {
      form.scrollTop = scroll;
      form.addEventListener('scroll', onFormScroll, { passive: true });
    }
  }

  function renderRail() {
    const search = el(
      'div',
      { class: 'rail-search' },
      icon('search'),
      el('input', {
        type: 'text',
        placeholder: 'Filter connections',
        value: filter,
        'aria-label': 'Filter connections',
        oninput: (e) => {
          filter = e.target.value;
          const list = root.querySelector('.rail-list');
          if (list) {
            list.replaceChildren(...groupNodes());
          }
          const count = root.querySelector('.rail-count');
          if (count) {
            count.textContent = countLabel();
          }
        }
      })
    );

    return el(
      'aside',
      { class: 'rail' },
      el(
        'div',
        { class: 'rail-head' },
        search,
        el('button', {
          class: 'icon',
          title: 'New connection',
          'aria-label': 'New connection',
          html: ICONS.add,
          onclick: () => post('create')
        })
      ),
      el('div', { class: 'rail-list', role: 'tree' }, ...groupNodes()),
      el(
        'div',
        { class: 'rail-foot' },
        el('span', { style: { flex: '1' } }),
        el('span', { class: 'rail-count' }, countLabel())
      )
    );
  }

  function visibleProfiles() {
    const needle = filter.trim().toLowerCase();
    if (!needle) {
      return state.profiles;
    }
    return state.profiles.filter(
      (p) => p.name.toLowerCase().includes(needle) || p.host.toLowerCase().includes(needle)
    );
  }

  function countLabel() {
    const shown = visibleProfiles().length;
    const total = state.profiles.length;
    const noun = total === 1 ? 'connection' : 'connections';
    return shown === total ? `${total} ${noun}` : `${shown} of ${total} ${noun}`;
  }

  function groupNodes() {
    const shown = visibleProfiles();
    const nodes = [];
    for (const env of ENVIRONMENTS) {
      const items = shown.filter((p) => p.environment === env.id);
      if (!items.length) {
        continue;
      }
      nodes.push(
        el(
          'div',
          { class: 'group' },
          el(
            'div',
            { class: 'group-head' },
            el('span', { class: 'caret ico', html: ICONS.caretGroup }),
            el('span', { class: 'dot', style: { width: '7px', height: '7px', borderRadius: '50%', flexShrink: '0', background: `var(--env-${env.id})` } }),
            el('span', { class: 'name', style: { color: `var(--env-${env.id})` } }, env.label.toUpperCase()),
            el('span', { style: { flex: '1' } }),
            el('span', { class: 'count' }, String(items.length))
          ),
          ...items.map(connectionRow)
        )
      );
    }
    if (!nodes.length) {
      nodes.push(
        el('div', { style: { padding: '12px 14px', fontSize: '12px', color: 'var(--fg-dim)' } },
          state.profiles.length ? 'Nothing matches that filter.' : 'No connections yet.')
      );
    }
    return nodes;
  }

  function connectionRow(profile) {
    const selected = profile.id === state.selectedId;
    const live = state.connected.includes(profile.id);
    return el(
      'button',
      {
        class: selected ? 'conn selected' : 'conn',
        role: 'treeitem',
        'aria-selected': selected ? 'true' : 'false',
        title: `${profile.name}\n${profile.host}${profile.port ? `:${profile.port}` : ''}`,
        style: selected
          ? { background: `color-mix(in srgb, var(--env-${profile.environment}) 14%, transparent)` }
          : undefined,
        onclick: () => post('select', { id: profile.id })
      },
      el('span', { class: 'bar', style: { background: `var(--env-${profile.environment})` } }),
      engineMark(profile.driver, 13),
      el('span', { class: 'label' }, profile.name || 'Untitled connection'),
      el('span', { class: live ? 'live on' : 'live', title: live ? 'Connected' : '' })
    );
  }

  function renderEmpty() {
    return el(
      'div',
      { class: 'detail' },
      el(
        'div',
        { class: 'empty' },
        el('h1', {}, 'Connect to a database'),
        el(
          'p',
          {},
          'Three fields get you connected. Encryption, timeouts and driver properties all have safe defaults and stay out of the way until you need them.'
        ),
        el(
          'div',
          { class: 'cards' },
          engineCard('mssql', 'Microsoft SQL Server', '2016 and newer, Azure SQL Database, Managed Instance, and Amazon RDS.'),
          engineCard('postgres', 'PostgreSQL', '12 and newer, plus Aurora, Cloud SQL, Neon, Supabase and Timescale.')
        )
      )
    );
  }

  function engineCard(driver, name, description) {
    return el(
      'button',
      { class: 'card', onclick: () => post('create', { driver }) },
      enginePlate(driver, 42, 25),
      el('span', { class: 'name' }, name),
      el('span', { class: 'desc' }, description)
    );
  }

  function renderDetail() {
    return el(
      'div',
      { class: 'detail' },
      renderNarrowPicker(),
      renderHead(),
      el('div', { class: 'body' }, renderIndex(), renderForm()),
      renderResult(),
      renderActions()
    );
  }

  function renderNarrowPicker() {
    return el(
      'div',
      { class: 'narrow-picker' },
      el(
        'div',
        { class: 'select' },
        el(
          'select',
          {
            'aria-label': 'Connection',
            onchange: (e) => post('select', { id: e.target.value })
          },
          ...state.profiles.map((p) =>
            el('option', { value: p.id, selected: p.id === state.selectedId }, `${p.name} · ${envOf(p.environment).label}`)
          )
        ),
        el('span', { class: 'caret', html: ICONS.caret })
      ),
      el('button', { class: 'icon', title: 'New connection', html: ICONS.add, onclick: () => post('create') })
    );
  }

  function renderHead() {
    const env = envOf(draft.environment);
    const chips = [chip(transportLabel(draft), toneFor(transportStrength(draft))), chip(authLabel(draft), 'auth')];
    if (draft.readOnly) {
      chips.push(chip('Read-only', 'ok'));
    }
    if (draft.sshEnabled) {
      chips.push(chip('SSH tunnel', 'auth'));
    }

    const port = draft.port ? `:${draft.port}` : '';
    const subtitle = `${draft.driver === 'mssql' ? 'Microsoft SQL Server' : 'PostgreSQL'}  ·  ${draft.host || 'no server yet'}${port}  ·  ${draft.database || 'default database'}`;

    return el(
      'div',
      {
        class: 'head',
        style: {
          background: `linear-gradient(90deg, color-mix(in srgb, var(--env-${draft.environment}) 11%, transparent) 0%, transparent 42%)`
        }
      },
      el('div', { class: 'env-bar', style: { background: `var(--env-${draft.environment})` } }),
      enginePlate(draft.driver, 34, 20),
      el(
        'div',
        { style: { minWidth: '0' } },
        el('div', { class: 'title' }, draft.name || 'Untitled connection'),
        el('div', { class: 'meta' }, el('span', {}, subtitle), ...chips)
      ),
      el('span', { style: { flex: '1' } }),
      isDirty() ? el('span', { class: 'dirty' }, 'Unsaved changes') : null,
      el(
        'span',
        { class: 'pill', style: { color: `var(--env-${env.id})`, background: `color-mix(in srgb, var(--env-${env.id}) 16%, transparent)` } },
        el('span', { class: 'dot', style: { background: `var(--env-${env.id})` } }),
        env.short
      ),
      el('button', {
        class: 'icon',
        title: 'More actions',
        'aria-label': 'More actions',
        html: ICONS.more,
        onclick: () => post('menu', { id: draft.id })
      })
    );
  }

  function toneFor(strength) {
    return strength === 'verified' ? 'ok' : strength === 'weakened' ? 'warn' : 'bad';
  }

  function renderIndex() {
    const strength = transportStrength(draft);
    return el(
      'nav',
      { class: 'index', 'aria-label': 'Sections' },
      ...SECTIONS.map((section) =>
        el(
          'button',
          {
            class: section.id === activeSection ? 'active' : '',
            onclick: () => goTo(section.id)
          },
          el('span', { class: 'label' }, section.label),
          el('span', {
            class: 'dot',
            style: section.id === 'transport' ? { background: strengthColour(strength) } : undefined,
            title: section.id === 'transport' ? `Transport is ${strength}` : undefined
          })
        )
      )
    );
  }

  function goTo(id) {
    activeSection = id;
    const target = document.getElementById(`section-${id}`);
    if (target) {
      target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
    for (const button of root.querySelectorAll('.index button')) {
      button.classList.remove('active');
    }
    const index = SECTIONS.findIndex((s) => s.id === id);
    const buttons = root.querySelectorAll('.index button');
    if (index >= 0 && buttons[index]) {
      buttons[index].classList.add('active');
    }
  }

  /** Keeps the index in step with the scroll position. */
  function onFormScroll(event) {
    const container = event.currentTarget;
    const top = container.getBoundingClientRect().top;
    let current = SECTIONS[0].id;
    for (const section of SECTIONS) {
      const node = document.getElementById(`section-${section.id}`);
      // Measured against the scroller itself, so the index does not drift when
      // the header above it changes height.
      if (node && node.getBoundingClientRect().top - top <= 40) {
        current = section.id;
      }
    }
    if (current !== activeSection) {
      activeSection = current;
      const buttons = root.querySelectorAll('.index button');
      buttons.forEach((button, i) => button.classList.toggle('active', SECTIONS[i].id === current));
    }
  }

  /* ---------------------------------------------------------- form pieces */

  /**
   * Writes a field into the draft. `structural` fields change which other
   * fields exist, so they rebuild the form; everything else only refreshes the
   * derived readings, which keeps the caret where the user left it.
   */
  function set(key, value, structural) {
    draft[key] = value;
    if (structural) {
      const focused = document.activeElement?.id;
      render();
      if (focused) {
        document.getElementById(focused)?.focus();
      }
    } else {
      refreshHeaderAndActions();
    }
  }

  function refreshHeaderAndActions() {
    const detail = root.querySelector('.detail');
    const head = detail && detail.querySelector('.head');
    const actions = detail && detail.querySelector('.actions');
    if (!detail || !head || !actions) {
      return;
    }
    const focusedId = document.activeElement && document.activeElement.id;
    const focusWasInBar = Boolean(focusedId) && actions.contains(document.activeElement);
    detail.replaceChild(renderHead(), head);
    detail.replaceChild(renderActions(), actions);
    if (focusWasInBar) {
      document.getElementById(focusedId)?.focus();
    }
    const dot = root.querySelector('.index button:nth-child(4) .dot');
    if (dot) {
      dot.style.background = strengthColour(transportStrength(draft));
    }
    const preview = root.querySelector('.conn-string');
    if (preview) {
      preview.textContent = connectionString(draft);
      preview.style.borderLeftColor = `var(--eng-${draft.driver})`;
    }
    const hint = root.querySelector('#transport-hint');
    if (hint) {
      applyTransportHint(hint);
    }
    const warning = root.querySelector('#trust-warning');
    if (warning) {
      warning.hidden = !draft.trustServerCertificate;
    }
  }

  function field(labelText, controlId, control, hintText, wide) {
    return el(
      'div',
      { class: wide ? 'field wide' : 'field' },
      controlId ? el('label', { for: controlId }, labelText) : el('span', { class: 'label' }, labelText),
      control,
      hintText ? el('div', { class: 'hint' }, hintText) : null
    );
  }

  function textInput(id, key, options = {}) {
    return el('input', {
      type: options.password ? 'password' : 'text',
      id,
      class: options.mono ? 'mono' : undefined,
      value: options.value !== undefined ? options.value : draft[key] ?? '',
      placeholder: options.placeholder,
      inputmode: options.numeric ? 'numeric' : undefined,
      'aria-invalid': options.invalid ? 'true' : undefined,
      oninput: (e) => {
        const raw = e.target.value;
        set(key, options.numeric ? numberOrNull(raw) : raw, false);
      }
    });
  }

  function numberOrNull(raw) {
    if (raw.trim() === '') {
      return null;
    }
    const n = Number(raw);
    return Number.isFinite(n) ? Math.round(n) : raw;
  }

  function selectInput(id, key, options, structural) {
    return el(
      'div',
      { class: 'select' },
      el(
        'select',
        {
          id,
          onchange: (e) => set(key, e.target.value, structural)
        },
        ...options.map(([value, label]) =>
          el('option', { value, selected: String(draft[key]) === String(value) }, label)
        )
      ),
      el('span', { class: 'caret', html: ICONS.caret })
    );
  }

  function checkbox(id, key, labelText, structural) {
    return el(
      'div',
      { class: 'check' },
      el('input', {
        type: 'checkbox',
        id,
        checked: Boolean(draft[key]),
        onchange: (e) => set(key, e.target.checked, structural)
      }),
      el('label', { for: id }, labelText)
    );
  }

  function sectionNode(id, iconName, title, ...content) {
    return el(
      'section',
      { class: 'section', id: `section-${id}` },
      el(
        'div',
        { class: 'section-head' },
        el('span', { class: 'ico', html: ICONS[iconName], style: { display: 'inline-flex', color: sectionColour(id) } }),
        el('span', { class: 'name' }, title),
        el('span', { class: 'rule' })
      ),
      ...content
    );
  }

  function sectionColour(id) {
    switch (id) {
      case 'auth':
      case 'credentials':
        return 'var(--chip-auth)';
      case 'transport':
        return strengthColour(transportStrength(draft));
      case 'session':
        return 'var(--chip-warn)';
      case 'properties':
        return 'var(--fg-dim)';
      default:
        return 'var(--accent)';
    }
  }

  function renderForm() {
    const isMssql = draft.driver === 'mssql';
    return el(
      'div',
      { class: 'form' },
      sectionIdentity(),
      sectionServer(),
      sectionAuth(isMssql),
      sectionTransport(isMssql),
      sectionCredentials(),
      sectionNetwork(),
      sectionSession(isMssql),
      sectionProperties()
    );
  }

  function sectionIdentity() {
    const env = envOf(draft.environment);
    return sectionNode(
      'identity',
      'shield',
      'Identity',
      el(
        'div',
        { class: 'grid' },
        field(
          'Server type',
          'f-driver',
          el(
            'div',
            { class: 'row' },
            enginePlate(draft.driver, 26, 16),
            selectInput('f-driver', 'driver', [['mssql', 'Microsoft SQL Server'], ['postgres', 'PostgreSQL']], true)
          ),
          'Switching driver resets the port and the transport defaults to match it.'
        ),
        field(
          'Connection name',
          'f-name',
          textInput('f-name', 'name', { placeholder: 'Billing-DB', invalid: !draft.name.trim() }),
          'Shown in the list, the status bar and every editor opened against this server.'
        ),
        field(
          'Environment',
          'f-env',
          el(
            'div',
            { class: 'row' },
            selectInput('f-env', 'environment', ENVIRONMENTS.map((e) => [e.id, e.label]), false),
            el(
              'span',
              { class: 'pill', style: { color: `var(--env-${env.id})`, background: `color-mix(in srgb, var(--env-${env.id}) 16%, transparent)` } },
              el('span', { class: 'dot', style: { background: `var(--env-${env.id})` } }),
              env.short
            )
          ),
          env.hint,
          true
        )
      )
    );
  }

  function sectionServer() {
    const databases = draft.__databases || (draft.database ? [draft.database] : []);
    const portInvalid = draft.port !== null && (!Number.isInteger(draft.port) || draft.port < 1 || draft.port > 65535);

    return sectionNode(
      'server',
      'server',
      'Server',
      el(
        'div',
        { class: 'grid' },
        field(
          draft.driver === 'mssql' ? 'Server' : 'Host',
          'f-host',
          el(
            'div',
            { class: 'row' },
            el('div', { style: { flex: '1' } }, textInput('f-host', 'host', { invalid: !draft.host.trim() })),
            el('div', { style: { width: '78px' } }, textInput('f-port', 'port', { numeric: true, invalid: portInvalid, placeholder: draft.driver === 'mssql' ? '1433' : '5432' }))
          ),
          portInvalid
            ? 'A port has to be between 1 and 65535.'
            : draft.driver === 'mssql'
              ? 'Host name, or host and instance for a named instance. Leave the port blank for 1433.'
              : 'Host name or address. Leave the port blank for 5432.'
        ),
        field(
          'Database',
          'f-database',
          el(
            'div',
            { class: 'row' },
            databases.length
              ? selectInput('f-database', 'database', databases.map((d) => [d, d]), false)
              : el('div', { style: { flex: '1' } }, textInput('f-database', 'database', { placeholder: "The login's default" })),
            el('button', {
              class: 'icon',
              title: 'Read the database list from the server',
              'aria-label': 'Read the database list from the server',
              html: ICONS.refresh,
              onclick: () => post('reloadDatabases', payload())
            })
          ),
          draft.__databases
            ? 'Read from the server just now.'
            : 'Read from the server when you ask. Leave it blank to use the login’s default.'
        )
      )
    );
  }

  function sectionAuth(isMssql) {
    const rows = [];

    if (isMssql) {
      rows.push(
        field(
          'Method',
          'f-auth',
          selectInput(
            'f-auth',
            'mssqlAuth',
            [
              ['entra-mfa', 'Microsoft Entra ID, MFA'],
              ['sql', 'SQL Server login'],
              ['ntlm', 'Windows authentication, NTLM']
            ],
            true
          )
        )
      );
    } else {
      rows.push(
        field(
          'Method',
          'f-pgauth',
          selectInput(
            'f-pgauth',
            'pgAuth',
            [
              ['password', 'Password, SCRAM-SHA-256'],
              ['certificate', 'Client certificate'],
              ['none', 'No credential, trust or peer']
            ],
            true
          )
        )
      );
    }

    const wantsUser = isMssql ? draft.mssqlAuth !== 'entra-mfa' : draft.pgAuth !== 'none';
    if (wantsUser) {
      rows.push(field('User name', 'f-user', textInput('f-user', 'user')));
    }

    if (isMssql && draft.mssqlAuth === 'ntlm') {
      rows.push(field('Domain', 'f-domain', textInput('f-domain', 'domain', { placeholder: 'NORTHWIND' })));
    }

    if (needsSecret(draft)) {
      const stored = state.hasSecret[draft.id];
      rows.push(
        field(
          'Password',
          'f-password',
          el(
            'div',
            {},
            el(
              'div',
              { class: 'row' },
              el(
                'div',
                { style: { flex: '1' } },
                el('input', {
                  type: revealSecret ? 'text' : 'password',
                  id: 'f-password',
                  value: secretDraft ?? '',
                  placeholder: stored ? 'Kept in the secret store' : 'Not stored yet',
                  autocomplete: 'off',
                  oninput: (e) => {
                    secretDraft = e.target.value;
                    refreshHeaderAndActions();
                  }
                })
              ),
              el('button', {
                class: 'icon',
                title: revealSecret ? 'Hide the password' : 'Show the password',
                'aria-label': revealSecret ? 'Hide the password' : 'Show the password',
                html: ICONS.eye,
                onclick: () => {
                  revealSecret = !revealSecret;
                  const input = document.getElementById('f-password');
                  if (input) {
                    input.type = revealSecret ? 'text' : 'password';
                    input.focus();
                  }
                }
              })
            ),
            stored
              ? el(
                  'div',
                  { class: 'row', style: { marginTop: '9px' } },
                  el('button', { class: 'btn ghost', style: { fontSize: '12px' }, onclick: () => post('clearSecret', { id: draft.id }) }, 'Forget the stored password')
                )
              : null
          ),
          'Held by the operating system keychain through the VS Code secret store. It is never written to settings.json and never carried by Settings Sync.'
        )
      );
    }

    if (!isMssql && draft.pgAuth === 'certificate') {
      rows.push(
        field('Client certificate', 'f-sslcert', textInput('f-sslcert', 'clientCertPath', { mono: true, placeholder: '~/.postgresql/postgresql.crt' })),
        field('Client key', 'f-sslkey', textInput('f-sslkey', 'clientKeyPath', { mono: true, placeholder: '~/.postgresql/postgresql.key' }), 'The key never leaves the machine.')
      );
    }

    if (isMssql && draft.mssqlAuth === 'entra-mfa') {
      rows.push(
        field('Tenant', 'f-tenant', textInput('f-tenant', 'tenant', { placeholder: 'Leave blank for the home tenant' })),
        el(
          'div',
          { class: 'field wide' },
          el(
            'div',
            { class: 'note info' },
            el('span', { class: 'ico', html: ICONS.info, style: { display: 'inline-flex', color: 'var(--info)' } }),
            el('span', {}, 'Signed in through the VS Code Microsoft account provider. The token is requested when you connect and is never stored by this extension.')
          )
        )
      );
    }

    if (isMssql && draft.mssqlAuth === 'ntlm') {
      rows.push(
        el(
          'div',
          { class: 'field wide' },
          el(
            'div',
            { class: 'note info' },
            el('span', { class: 'ico', html: ICONS.info, style: { display: 'inline-flex', color: 'var(--info)' } }),
            el('span', {}, 'NTLM sends the domain, user and password itself. Fully integrated single sign-on needs a native driver and is not in this release.')
          )
        )
      );
    }

    return sectionNode('auth', 'key', 'Authentication', el('div', { class: 'grid' }, ...rows));
  }

  function applyTransportHint(node) {
    const strength = transportStrength(draft);
    node.className = `hint ${strength === 'verified' ? '' : strength === 'weakened' ? 'warn' : 'bad'}`.trim();
    node.textContent =
      draft.driver === 'mssql' ? ENCRYPT_HINT[draft.encrypt] || '' : SSL_HINT[draft.sslMode] || '';
  }

  function sectionTransport(isMssql) {
    const hint = el('div', { class: 'hint', id: 'transport-hint' });
    applyTransportHint(hint);

    const rows = [];
    if (isMssql) {
      rows.push(
        el(
          'div',
          { class: 'field' },
          el('label', { for: 'f-encrypt' }, 'Encrypt'),
          selectInput(
            'f-encrypt',
            'encrypt',
            [
              ['strict', 'Strict, TDS 8.0'],
              ['mandatory', 'Mandatory, encrypt or fail'],
              ['optional', 'Optional, encrypt only if offered']
            ],
            false
          ),
          hint
        ),
        field(
          'Name in certificate',
          'f-certhost',
          textInput('f-certhost', 'certificateHostname', { placeholder: 'Same as the server address' }),
          'Set this when the certificate was issued for a listener or an alias.'
        ),
        el(
          'div',
          { class: 'field wide' },
          checkbox('f-trust', 'trustServerCertificate', 'Trust the server certificate without validating it', false),
          el(
            'div',
            { class: 'note warn', id: 'trust-warning', hidden: !draft.trustServerCertificate },
            el('span', { class: 'ico', html: ICONS.warn, style: { display: 'inline-flex', color: 'var(--warn)' } }),
            el(
              'span',
              {},
              'Traffic stays encrypted, but the server’s identity is no longer checked, so the connection is open to interception on the way. Add the issuing authority to the machine trust store instead wherever you can.'
            )
          )
        )
      );
    } else {
      rows.push(
        el(
          'div',
          { class: 'field' },
          el('label', { for: 'f-sslmode' }, 'SSL mode'),
          selectInput(
            'f-sslmode',
            'sslMode',
            [
              ['disable', 'disable'],
              ['allow', 'allow'],
              ['prefer', 'prefer'],
              ['require', 'require'],
              ['verify-ca', 'verify-ca'],
              ['verify-full', 'verify-full']
            ],
            false
          ),
          hint
        ),
        field(
          'Root certificate',
          'f-rootcert',
          textInput('f-rootcert', 'rootCertPath', { mono: true, placeholder: '~/.postgresql/root.crt' }),
          'Blank falls back to ~/.postgresql/root.crt, the libpq default. Type "system" to use the machine trust store instead.'
        )
      );
    }
    return sectionNode('transport', 'shield', 'Transport', el('div', { class: 'grid' }, ...rows));
  }

  function sectionCredentials() {
    return sectionNode(
      'credentials',
      'lock',
      'Credentials',
      el(
        'div',
        { class: 'grid' },
        field(
          'Store',
          'f-credstore',
          selectInput(
            'f-credstore',
            'credentialStore',
            [
              ['secret', 'VS Code secret store, the OS keychain'],
              ['prompt', 'Ask me every time I connect'],
              ['none', 'Do not keep a credential']
            ],
            false
          ),
          'Production connections default to asking every time, so an unattended laptop cannot open a live session on its own.'
        ),
        field(
          'Retry',
          null,
          checkbox('f-reprompt', 'repromptOnReject', 'Ask again when a stored credential is rejected', false)
        )
      )
    );
  }

  function sectionNetwork() {
    const rows = [
      el(
        'div',
        { class: 'field wide' },
        checkbox('f-ssh', 'sshEnabled', 'Reach the server through an SSH tunnel', true),
        draft.sshEnabled
          ? el(
              'div',
              { class: 'note info' },
              el('span', { class: 'ico', html: ICONS.info, style: { display: 'inline-flex', color: 'var(--info)' } }),
              el('span', {}, 'Tunnel details are saved with the profile, but the tunnel itself is not opened in this release. Connecting still goes direct.')
            )
          : null
      )
    ];

    if (draft.sshEnabled) {
      rows.push(
        field(
          'Jump host',
          'f-sshhost',
          el(
            'div',
            { class: 'row' },
            el('div', { style: { flex: '1' } }, textInput('f-sshhost', 'sshHost', { placeholder: 'bastion.example.com' })),
            el('div', { style: { width: '66px' } }, textInput('f-sshport', 'sshPort', { numeric: true }))
          )
        ),
        field(
          'Identity',
          'f-sshuser',
          el(
            'div',
            { class: 'row' },
            el('div', { style: { flex: '1' } }, textInput('f-sshuser', 'sshUser', { placeholder: 'User name' })),
            el('div', { style: { flex: '1.3' } }, textInput('f-sshkey', 'sshKeyPath', { mono: true, placeholder: '~/.ssh/id_ed25519' }))
          )
        )
      );
    }

    return sectionNode('network', 'tunnel', 'Network', el('div', { class: 'grid' }, ...rows));
  }

  function sectionSession(isMssql) {
    const behaviour = [checkbox('f-readonly', 'readOnly', 'Open new sessions read-only', false)];
    if (isMssql) {
      behaviour.push(
        checkbox('f-mars', 'multipleActiveResultSets', 'Allow multiple active result sets', false),
        checkbox('f-msf', 'multiSubnetFailover', 'Multi-subnet failover', false),
        el(
          'div',
          { class: 'hint' },
          'SQL Server has no session-level read-only switch, so this flag is applied by the query gate rather than by the server.'
        )
      );
    }

    const rows = [
      field(
        'Connect timeout',
        'f-connect-timeout',
        el(
          'div',
          { class: 'row' },
          el('div', { style: { width: '78px' } }, textInput('f-connect-timeout', 'connectTimeoutSeconds', { numeric: true })),
          el('span', { style: { fontSize: '12px', color: 'var(--fg-dim)' } }, 'seconds')
        )
      ),
      field(
        'Query timeout',
        'f-query-timeout',
        el(
          'div',
          { class: 'row' },
          el('div', { style: { width: '78px' } }, textInput('f-query-timeout', 'queryTimeoutSeconds', { numeric: true })),
          el('span', { style: { fontSize: '12px', color: 'var(--fg-dim)' } }, 'seconds')
        ),
        'Set this to zero to let a query run without a limit.'
      ),
      field(
        'Application name',
        'f-appname',
        textInput('f-appname', 'applicationName'),
        'Sent to the server so a database administrator can tell these sessions apart.'
      ),
      field(
        'Rows per fetch',
        'f-rows',
        el(
          'div',
          { class: 'row' },
          el('div', { style: { width: '92px' } }, textInput('f-rows', 'rowsPerFetch', { numeric: true })),
          el('span', { style: { fontSize: '12px', color: 'var(--fg-dim)' } }, 'rows')
        ),
        'Results stream in pages of this size. Raising it costs memory on wide tables.'
      ),
      el('div', { class: 'field wide' }, el('span', { class: 'label' }, 'Behaviour'), ...behaviour)
    ];

    if (!isMssql) {
      rows.push(field('Schema search path', 'f-searchpath', textInput('f-searchpath', 'searchPath', { mono: true })));
    }

    return sectionNode('session', 'clock', 'Session', el('div', { class: 'grid' }, ...rows));
  }

  function sectionProperties() {
    const rows = draft.properties.map((property, i) =>
      el(
        'div',
        { class: 'prop-row' },
        el('div', {}, el('input', {
          type: 'text',
          class: 'mono',
          value: property.name,
          'aria-label': `Property ${i + 1} name`,
          oninput: (e) => {
            draft.properties[i].name = e.target.value;
            refreshHeaderAndActions();
          }
        })),
        el('div', {}, el('input', {
          type: 'text',
          class: 'mono',
          value: property.value,
          'aria-label': `Property ${i + 1} value`,
          oninput: (e) => {
            draft.properties[i].value = e.target.value;
            refreshHeaderAndActions();
          }
        }))
      )
    );

    return sectionNode(
      'properties',
      'list',
      'Properties',
      el(
        'div',
        { class: 'props' },
        el('div', { class: 'prop-row head' }, el('div', {}, 'NAME'), el('div', {}, 'VALUE')),
        ...rows,
        el(
          'button',
          {
            class: 'btn ghost',
            style: { width: '100%', height: '30px', justifyContent: 'flex-start', color: 'var(--link)', fontSize: '12px' },
            onclick: () => {
              draft.properties.push({ name: '', value: '' });
              set('properties', draft.properties, true);
            }
          },
          el('span', { class: 'ico', html: ICONS.add, style: { display: 'inline-flex' } }),
          'Add a property'
        )
      ),
      el(
        'div',
        { style: { marginTop: '22px', maxWidth: '620px' } },
        el('span', { class: 'label' }, 'Connection string'),
        el('div', { class: 'conn-string mono', style: { borderLeftColor: `var(--eng-${draft.driver})` } }, connectionString(draft)),
        el(
          'div',
          { class: 'row', style: { marginTop: '10px' } },
          el(
            'button',
            { class: 'btn secondary', onclick: () => post('copyConnectionString', { text: connectionString(draft) }) },
            el('span', { class: 'ico', html: ICONS.copy, style: { display: 'inline-flex' } }),
            'Copy'
          )
        ),
        el('div', { class: 'hint' }, 'The secret is masked here and in every log line the extension writes.')
      )
    );
  }

  /* ------------------------------------------------------- result + bar */

  function renderResult() {
    const busy = state.busy === draft.id;
    if (busy) {
      return el(
        'div',
        { class: 'result busy', role: 'status', 'aria-live': 'polite' },
        el('span', { class: 'ico', html: ICONS.spinner, style: { display: 'inline-flex', color: 'var(--accent)' } }),
        el('span', {}, `Resolving ${draft.host || 'the server'}, then opening a socket on ${draft.port ?? (draft.driver === 'mssql' ? 1433 : 5432)}`),
        el('span', { style: { flex: '1' } }),
        el('button', { class: 'btn ghost', style: { fontSize: '12px' }, onclick: () => post('cancel', { id: draft.id }) }, 'Cancel')
      );
    }

    const result = state.results[draft.id];
    if (!result) {
      return el('div', { class: 'result idle', role: 'status', 'aria-live': 'polite' }, 'Not tested yet. Connecting tests it first.');
    }

    if (result.ok) {
      const info = result.info;
      const readOnly = info.readOnly ? ' · read-only' : '';
      return el(
        'div',
        { class: 'result ok', role: 'status', 'aria-live': 'polite' },
        el('span', { class: 'ico', html: ICONS.ok, style: { display: 'inline-flex', color: 'var(--ok)' } }),
        el(
          'span',
          {},
          el('span', { class: 'strong', style: { color: 'var(--ok)' } }, `Connected in ${info.latencyMs} ms.`),
          ' ',
          el('span', { class: 'muted' }, `${info.serverVersion} · signed in as ${info.principal}${readOnly}`)
        )
      );
    }

    const failure = result.failure;
    return el(
      'div',
      { class: 'result error', role: 'alert', 'aria-live': 'polite' },
      el('span', { class: 'ico', html: ICONS.error, style: { display: 'inline-flex', color: 'var(--err)', marginTop: '2px' } }),
      el(
        'div',
        { class: 'error-body' },
        el('div', { class: 'strong', style: { color: 'var(--err)' } }, failure.title),
        el('div', { class: 'error-detail' }, failure.detail),
        failure.actions.length
          ? el(
              'div',
              { class: 'error-actions' },
              ...failure.actions.map((action) =>
                el(
                  'button',
                  {
                    class: action.weakening ? 'btn ghost weakening' : 'btn secondary',
                    onclick: () => post('action', { id: draft.id, actionId: action.id, raw: failure.raw })
                  },
                  action.label
                )
              )
            )
          : null
      )
    );
  }

  function renderActions() {
    const busy = state.busy === draft.id;
    const connected = state.connected.includes(draft.id);
    const dirty = isDirty();
    const invalid = !draft.name.trim() || !draft.host.trim();

    return el(
      'div',
      { class: 'actions' },
      el(
        'button',
        { class: 'btn secondary', disabled: busy || invalid, onclick: () => post('test', payload()) },
        el('span', { class: 'ico', html: ICONS.flask, style: { display: 'inline-flex', color: 'var(--chip-ok)' } }),
        'Test connection'
      ),
      el('span', { style: { flex: '1' } }),
      el(
        'div',
        { class: 'check', style: { marginRight: '6px' } },
        el('input', {
          type: 'checkbox',
          id: 'f-readonly-bar',
          checked: Boolean(draft.readOnly),
          onchange: (e) => {
            draft.readOnly = e.target.checked;
            const mirror = document.getElementById('f-readonly');
            if (mirror) {
              mirror.checked = e.target.checked;
            }
            refreshHeaderAndActions();
          }
        }),
        el('label', { for: 'f-readonly-bar', style: { fontSize: '12px', color: 'var(--fg-dim)' } }, 'Read-only session')
      ),
      el('button', { class: 'btn ghost', disabled: !dirty, onclick: () => post('revert', { id: draft.id }) }, 'Revert'),
      el('button', { class: 'btn secondary', disabled: !dirty || invalid, onclick: () => post('save', payload()) }, 'Save'),
      connected
        ? el('button', { class: 'btn secondary', onclick: () => post('disconnect', { id: draft.id }) }, 'Disconnect')
        : null,
      el('button', { class: 'btn primary', disabled: busy || invalid, onclick: () => post('connect', payload()) }, 'Connect')
    );
  }

  window.addEventListener('keydown', (event) => {
    if (!draft) {
      return;
    }
    const mod = event.ctrlKey || event.metaKey;
    if (mod && event.key === 'Enter') {
      event.preventDefault();
      post('connect', payload());
    } else if (mod && event.key.toLowerCase() === 's') {
      event.preventDefault();
      if (isDirty()) {
        post('save', payload());
      }
    } else if (event.altKey && event.key.toLowerCase() === 't') {
      event.preventDefault();
      post('test', payload());
    } else if (event.key === 'Escape' && state.busy === draft.id) {
      event.preventDefault();
      post('cancel', { id: draft.id });
    }
  });

  post('ready');
})();
