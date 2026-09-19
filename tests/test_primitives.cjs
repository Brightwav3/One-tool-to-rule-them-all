const assert = require('node:assert/strict');
const primitives = require('../converter/ui/components/primitives.js');

const {
  buttonClass, buttonHtml, chipHtml, switchHtml, fieldHtml, inpHtml,
  checkHtml, segHtml, ctxItemHtml, menuItemHtml, optHtml,
} = primitives;

assert.equal(buttonClass({ family: 'btn', variant: 'primary' }), 'btn btn-primary press');
assert.equal(buttonClass({ family: 'btn', variant: 'ghost', size: 'sm' }), 'btn btn-ghost btn-sm press');
assert.equal(buttonClass({ family: 'pbtn', variant: 'pri' }), 'pbtn pri press');
assert.equal(buttonClass({ family: 'pbtn', variant: 'gh', off: true }), 'pbtn gh press off');
assert.equal(buttonClass({ family: 'u-add' }), 'u-add press');
assert.notEqual(buttonClass({ family: 'btn', variant: 'primary' }), buttonClass({ family: 'pbtn', variant: 'pri' }));
assert.notEqual(buttonClass({ family: 'u-add' }), buttonClass({ family: 'btn', variant: 'primary' }));
assert.notEqual(buttonClass({ family: 'pbtn' }), buttonClass({ family: 'u-add' }));

assert.equal(
  buttonHtml({ family: 'btn', variant: 'secondary', size: 'sm', act: 'recheck', html: 'Re-scan this machine' }),
  '<button class="btn btn-secondary btn-sm press" data-act="recheck">Re-scan this machine</button>',
);
assert.equal(
  buttonHtml({ family: 'pbtn', variant: 'pri', act: 'ed-save', html: 'Save' }),
  '<button class="pbtn pri press" data-act="ed-save">Save</button>',
);
assert.equal(
  buttonHtml({ family: 'u-add', act: 'add', html: 'Add files' }),
  '<button class="u-add press" data-act="add">Add files</button>',
);
assert.equal(
  buttonHtml({ family: 'action', variant: 'apply', act: 'apply-all', raw: 'disabled', html: 'Apply changes' }),
  '<button class="action apply" data-act="apply-all" disabled>Apply changes</button>',
);

assert.equal(
  chipHtml({ family: 'u-chip', act: 'history-filter', data: { filter: 'all' }, on: true, html: 'All<span class="n">0</span>' }),
  '<button class="u-chip press" data-act="history-filter" data-filter="all" data-on="true">All<span class="n">0</span></button>',
);
assert.equal(
  chipHtml({ family: 'pchip', style: 'background:var(--acc-tint);color:var(--acc-text)', html: 'Select' }),
  '<span class="pchip" style="background:var(--acc-tint);color:var(--acc-text)">Select</span>',
);
assert.equal(
  chipHtml({ family: 'set-chip', state: 'ok', html: 'Installed' }),
  '<span class="set-chip" data-state="ok">Installed</span>',
);
assert.equal(
  chipHtml({ family: 'badge', tone: 'ok', html: 'On disk' }),
  '<span class="badge ok">On disk</span>',
);

assert.equal(
  switchHtml({ family: 'sw', on: true, ariaLabel: 'Theme', act: 'settings-toggle', id: 'theme' }),
  '<button class="sw" role="switch" aria-checked="true" aria-label="Theme" data-act="settings-toggle" data-id="theme" data-on="true"><i></i></button>',
);
assert.equal(
  switchHtml({ family: 'switch', on: false, act: 'toggle-names' }),
  '<button class="switch" data-act="toggle-names" aria-pressed="false"><i></i></button>',
);
assert.match(switchHtml({ family: 'cr-toggle', on: true, act: 'cr-toggle', key: 'meta', html: 'Metadata' }), /width:30px;height:18px/);
assert.doesNotMatch(switchHtml({ family: 'sw', on: true, act: 'x', id: 'a', ariaLabel: 'A' }), /class="switch/);
assert.doesNotMatch(switchHtml({ family: 'switch', on: true, act: 'x' }), /class="sw"/);

assert.equal(
  fieldHtml({ family: 'field', forId: 'field-title', label: 'Title', control: '<input id="field-title">' }),
  '<div class="field"><label for="field-title">Title</label><input id="field-title"></div>',
);
assert.equal(
  inpHtml({ style: 'width:210px', html: '<input id="crQuery">' }),
  '<div class="inp" style="width:210px"><input id="crQuery"></div>',
);
assert.equal(
  checkHtml({ on: true, act: 'check-all', ariaLabel: 'Select all', html: '✓' }),
  '<button class="check press on" data-act="check-all" role="checkbox" aria-checked="true" aria-label="Select all">✓</button>',
);
assert.equal(
  segHtml({ act: 'ed-scope', items: [{ value: 'This page', on: true, html: 'This page' }, { value: 'All pages', on: false, html: 'All pages' }] }),
  '<div class="pseg"><button class="press" data-act="ed-scope" data-scope="This page" data-on="true">This page</button><button class="press" data-act="ed-scope" data-scope="All pages" data-on="false">All pages</button></div>',
);
assert.match(
  ctxItemHtml('Remove from queue', 'remove-queue', '<svg></svg>', { danger: true }),
  /class="ctx-item danger"/,
);
assert.equal(
  menuItemHtml({ act: 'settings-pick', id: 'theme', value: 'Dark', on: true, html: 'Dark' }),
  '<button role="menuitem" data-act="settings-pick" data-id="theme" data-value="Dark" data-on="true"><span class="tk" aria-hidden="true">✓</span><span class="nm">Dark</span></button>',
);
assert.match(
  optHtml({ current: true, act: 'choose-route', dataId: 'f1', converter: 'pdf', name: 'PDF', stateLabel: 'Ready', check: '✓' }),
  /class="opt press current"/,
);

console.log('UI primitive wrap tests passed');
