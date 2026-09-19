/* One Tool UI primitives.
   Thin HTML wraps over the classes the prototypes already emit. Families are
   not interchangeable: .btn ≠ .pbtn ≠ .u-add, .sw ≠ .switch ≠ cr-toggle,
   .u-chip ≠ .pchip ≠ .set-chip ≠ .badge. Callers pass already-escaped text.
   Documented in docs/ui-primitives.md. */

function uiJoin(parts) {
  return parts.filter(part => part !== undefined && part !== null && part !== false && part !== '').join(' ').replace(/\s+/g, ' ').trim();
}
function uiFlag(name, on) {
  return on ? ` ${name}` : '';
}
function uiAttr(name, value) {
  if (value === undefined || value === null || value === false) return '';
  if (value === true) return ` ${name}`;
  return ` ${name}="${value}"`;
}
function uiBool(value) {
  return value ? 'true' : 'false';
}

function buttonClass(opts) {
  const family = opts.family;
  const variant = opts.variant || '';
  if (family === 'btn') {
    return uiJoin([
      'btn',
      variant ? `btn-${variant}` : '',
      opts.size === 'sm' ? 'btn-sm' : '',
      opts.press === false ? '' : 'press',
      opts.extra,
    ]);
  }
  if (family === 'pbtn') {
    return uiJoin(['pbtn', variant, 'press', opts.off ? 'off' : '', opts.extra]);
  }
  if (family === 'u-add') return uiJoin(['u-add', opts.press === false ? '' : 'press', opts.extra]);
  if (family === 'u-sort') return uiJoin(['u-sort', 'press', opts.extra]);
  if (family === 'action') return uiJoin(['action', variant, opts.extra]);
  if (family === 'go') return uiJoin(['btn', 'btn-primary', 'press', 'go', opts.success ? 'success' : '', opts.extra]);
  if (family === 'tool') return uiJoin(['tool', opts.press === false ? '' : 'press', opts.extra]);
  throw new Error(`unknown button family: ${family}`);
}

function buttonHtml(opts) {
  const attrs = [
    ['class', opts.className || buttonClass(opts)],
    ['id', opts.id],
    ['data-act', opts.act],
  ];
  if (opts.data) {
    Object.keys(opts.data).forEach(key => {
      attrs.push([key.indexOf('data-') === 0 ? key : `data-${key}`, opts.data[key]]);
    });
  }
  attrs.push(
    ['style', opts.style],
    ['title', opts.title],
    ['aria-label', opts.ariaLabel],
    ['aria-expanded', opts.ariaExpanded === undefined ? undefined : uiBool(opts.ariaExpanded)],
    ['aria-haspopup', opts.ariaHaspopup],
    ['aria-pressed', opts.ariaPressed === undefined ? undefined : uiBool(opts.ariaPressed)],
    ['aria-checked', opts.ariaChecked === undefined ? undefined : uiBool(opts.ariaChecked)],
    ['aria-hidden', opts.ariaHidden],
    ['role', opts.role],
  );
  let open = '<button';
  attrs.forEach(([name, value]) => { open += uiAttr(name, value); });
  if (opts.raw) open += (opts.raw.charAt(0) === ' ' ? opts.raw : ` ${opts.raw}`);
  return `${open}>${opts.html || ''}</button>`;
}

function chipHtml(opts) {
  const family = opts.family;
  let className = family;
  if (family === 'u-chip') className = uiJoin(['u-chip', opts.press === false ? '' : 'press', opts.extra]);
  else if (family === 'u-pill') className = uiJoin(['u-pill', opts.press ? 'press' : '', opts.extra]);
  else if (family === 'pchip') className = uiJoin(['pchip', opts.extra]);
  else if (family === 'set-chip') className = uiJoin(['set-chip', opts.extra]);
  else if (family === 'badge') className = uiJoin(['badge', opts.tone, opts.extra]);
  else if (family === 'pill') className = uiJoin(['pill', opts.extra]);
  else throw new Error(`unknown chip family: ${family}`);
  const tag = opts.tag || (family === 'pchip' || family === 'badge' || family === 'pill' || family === 'set-chip' ? 'span' : 'button');
  let open = `<${tag}${uiAttr('class', className)}${uiAttr('data-act', opts.act)}`;
  if (opts.data) Object.keys(opts.data).forEach(key => {
    open += uiAttr(key.indexOf('data-') === 0 ? key : `data-${key}`, opts.data[key]);
  });
  open += uiAttr('style', opts.style) + uiAttr('data-on', opts.on === undefined ? undefined : uiBool(opts.on));
  open += uiAttr('data-state', opts.state) + uiAttr('data-open', opts.open) + uiAttr('data-blocked', opts.blocked);
  if (opts.raw) open += (opts.raw.charAt(0) === ' ' ? opts.raw : ` ${opts.raw}`);
  return `${open}>${opts.html || ''}</${tag}>`;
}

function switchHtml(opts) {
  const on = Boolean(opts.on);
  if (opts.family === 'sw') {
    return `<button class="sw" role="switch" aria-checked="${uiBool(on)}" aria-label="${opts.ariaLabel}" data-act="${opts.act}" data-id="${opts.id}" data-on="${uiBool(on)}"><i></i></button>`;
  }
  if (opts.family === 'switch') {
    return `<button class="switch${on ? ' on' : ''}" data-act="${opts.act}" aria-pressed="${uiBool(on)}"><i></i></button>`;
  }
  if (opts.family === 'cr-toggle') {
    return `<button class="press" data-act="${opts.act}" data-key="${opts.key}" role="switch" aria-checked="${uiBool(on)}" style="display:flex;align-items:center;gap:10px;width:100%;min-height:29px;padding:0 9px;border-radius:7px;box-shadow:inset 0 0 0 1px var(--sep2)">
      <span style="flex:1;font:500 12px var(--ui);color:var(--t1);text-align:left">${opts.html}</span>
      <span style="width:30px;height:18px;flex:none;border-radius:999px;padding:2px;display:flex;justify-content:${on ? 'flex-end' : 'flex-start'};background:${on ? 'var(--acc)' : 'var(--sep2)'};transition:background var(--d-quick) ease"><span style="width:14px;height:14px;border-radius:50%;background:#fff;box-shadow:0 1px 2px rgba(0,0,0,.2)"></span></span>
    </button>`;
  }
  throw new Error(`unknown switch family: ${opts.family}`);
}

function uiFieldHtml(opts) {
  if (opts.family === 'field') {
    return `<div class="field"><label for="${opts.forId}">${opts.label}</label>${opts.control}</div>`;
  }
  throw new Error(`unknown field family: ${opts.family}`);
}

function inpHtml(opts) {
  return `<div class="inp"${uiAttr('style', opts.style)}>${opts.html || ''}</div>`;
}

function checkHtml(opts) {
  const on = Boolean(opts.on);
  return `<button class="check press${on ? ' on' : ''}" data-act="${opts.act}"${opts.id ? ` data-id="${opts.id}"` : ''} role="checkbox" aria-checked="${uiBool(on)}"${opts.ariaLabel ? ` aria-label="${opts.ariaLabel}"` : ''}>${opts.html || ''}</button>`;
}

function segHtml(opts) {
  const itemKey = opts.itemAttr || 'scope';
  const buttons = opts.items.map(item => {
    let extra = '';
    if (opts.key !== undefined) extra += uiAttr('data-key', opts.key);
    extra += uiAttr(`data-${itemKey}`, item.value);
    extra += uiAttr('data-on', uiBool(item.on));
    return `<button class="press" data-act="${opts.act}"${extra}>${item.html}</button>`;
  }).join('');
  return `<div class="pseg">${buttons}</div>`;
}

function ctxItemHtml(label, action, icon, options) {
  const opts = options || {};
  return `<button class="ctx-item ${opts.danger ? 'danger' : ''}" data-context-act="${action}" ${opts.disabled ? 'disabled' : ''} role="menuitem">
    <span class="ctx-icon" aria-hidden="true">${icon}</span><span>${label}</span>
  </button>`;
}

function menuItemHtml(opts) {
  return `<button role="menuitem" data-act="${opts.act}" data-id="${opts.id}" data-value="${opts.value}" data-on="${uiBool(opts.on)}"><span class="tk" aria-hidden="true">${opts.on ? '✓' : ''}</span><span class="nm">${opts.html}</span></button>`;
}

function optHtml(opts) {
  return `<button class="opt press${opts.current ? ' current' : ''}" data-act="${opts.act}"${opts.dataId ? ` data-id="${opts.dataId}"` : ''}${opts.converter ? ` data-converter="${opts.converter}"` : ''}${opts.to ? ` data-to="${opts.to}"` : ''}${uiFlag('disabled', opts.disabled)}>
        <span class="ck">${opts.check || ''}</span><span class="nm">${opts.name}</span><span class="st ${opts.stateClass || ''}">${opts.stateLabel}</span></button>`;
}

const OneToolPrimitives = {
  uiJoin, buttonClass, buttonHtml, chipHtml, switchHtml, fieldHtml: uiFieldHtml, inpHtml,
  checkHtml, segHtml, ctxItemHtml, menuItemHtml, optHtml,
};

if (typeof module !== 'undefined' && module.exports) module.exports = OneToolPrimitives;
