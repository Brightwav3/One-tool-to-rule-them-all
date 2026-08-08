/* Golden trace: a behavioural fingerprint of the UI.
 *
 * Phase A of the decomposition had a free oracle - every commit reassembled
 * into the previous file byte for byte. Controllers, typed errors and an event
 * bus all change bytes by definition, so that oracle is gone. This replaces it.
 *
 * The insight is that a controller refactor does not change what the app does,
 * only how it is wired. So record what it does: which requests it makes, in
 * what order, with what bodies; which toasts it raises; how many render passes
 * it runs; and what the page looks like at the end, by structure and by
 * computed style. Run the same script against ui-monolith-baseline and against
 * the working tree, and diff. An identical trace means the refactor was
 * behaviour-preserving. A diff points at the exact step that changed.
 *
 * Load it into a page and call `await trace()`. It returns a plain object;
 * compare with tests/ui/trace-diff.cjs.
 */
(() => {
  const STYLE_PROPS = [
    'display', 'position', 'top', 'right', 'bottom', 'left', 'width', 'height',
    'margin', 'padding', 'color', 'background-color', 'background-image',
    'border-width', 'border-style', 'border-color', 'border-radius', 'box-shadow',
    'font-family', 'font-size', 'font-weight', 'line-height', 'letter-spacing',
    'opacity', 'transform', 'transition', 'z-index', 'flex', 'gap', 'overflow',
    'align-items', 'justify-content', 'text-align', 'visibility', 'pointer-events',
  ];

  const sleep = ms => new Promise(r => setTimeout(r, ms));

  function hash(str) {
    let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
    for (let i = 0; i < str.length; i++) {
      const ch = str.charCodeAt(i);
      h1 = Math.imul(h1 ^ ch, 2654435761);
      h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return ((h2 >>> 0) * 4294967296 + (h1 >>> 0)).toString(16);
  }

  /* ---------- instrumentation ----------
     Every wrapper restores the original in stop(), so a trace run leaves the
     page exactly as it found it and two runs in one session cannot stack. */
  function instrument() {
    const t = { requests: [], toasts: [], renders: 0, errors: [] };

    const realFetch = window.fetch;
    window.fetch = function (input, init) {
      const url = typeof input === 'string' ? input : input?.url;
      /* The 700ms state poll from bootstrap.js is wall-clock noise: how many
         times it has fired by the end of a run depends on machine speed, not on
         behaviour. Record it as a flag, never as an ordered entry. */
      const polled = url === '/api/state' && (!init || !init.method || init.method === 'GET');
      if (polled) { t.polled = true; return realFetch.apply(this, arguments); }
      t.requests.push({ url, method: init?.method || 'GET', body: init?.body ?? null });
      return realFetch.apply(this, arguments);
    };

    const realToast = window.showToast;
    if (typeof realToast === 'function') {
      window.showToast = function (title, ok = true, sub = '') {
        t.toasts.push({ title: String(title), ok: Boolean(ok), sub: String(sub) });
        return realToast.apply(this, arguments);
      };
    }

    const realRender = window.render;
    if (typeof realRender === 'function') {
      window.render = function () { t.renders += 1; return realRender.apply(this, arguments); };
    }

    /* File inputs open a native dialog that nothing dismisses in an automated
       run. The handler still runs; only the dialog is suppressed. */
    const realClick = HTMLInputElement.prototype.click;
    HTMLInputElement.prototype.click = function () {
      if (this.type === 'file') return;
      return realClick.apply(this, arguments);
    };

    const onError = e => t.errors.push(`${e.message} @ ${e.filename}:${e.lineno}`);
    const onReject = e => t.errors.push(String(e.reason?.message ?? e.reason));
    addEventListener('error', onError);
    addEventListener('unhandledrejection', onReject);

    t.stop = () => {
      window.fetch = realFetch;
      if (typeof realToast === 'function') window.showToast = realToast;
      if (typeof realRender === 'function') window.render = realRender;
      HTMLInputElement.prototype.click = realClick;
      removeEventListener('error', onError);
      removeEventListener('unhandledrejection', onReject);
    };
    return t;
  }

  /* ---------- the scripted sequence ----------
     Fixed and ordered, so two runs are comparable. Actions that spend real time
     or touch real files are deliberately absent: they would make the two builds
     diverge for reasons that have nothing to do with the refactor. */
  const SCRIPT = [
    ['page', 'convert'],
    ['act', 'toggle-folder-menu'], ['act', 'toggle-folder-menu'],
    ['act', 'check-all'], ['act', 'check-all'],
    ['act', 'history-filter'], ['act', 'history-sort'],
    ['act', 'cycle-scope'],
    ['key', 'k', true],            /* command palette open */
    ['key', 'Escape', false],
    ['click', '#settingsBtn'],
    ['act', 'close-settings'],
    ['page', 'creator'],
    ['act', 'cr-format'], ['act', 'cr-continue'], ['act', 'cr-back'],
    ['page', 'editor'],
    ['act', 'ed-select-all'], ['act', 'ed-page'], ['act', 'ed-revert'],
    ['page', 'convert'],
  ];

  /* The regular script predates the FreeDF session bridge and intentionally
     leaves the Editor empty.  This second, session-backed sequence is run only
     after it, so its original coverage and ordering stay intact.  `editor-open`
     deliberately calls the action through its public UI controller rather than
     opening the native picker: the latter cannot be dismissed by a trace, while
     the former is exactly the path the picker reaches after Electron supplies a
     real local-file path.  The fixture path is supplied by the Electron run;
     keeping it out of this checked-in script makes the trace portable. */
  const EDITOR_SCRIPT = [
    ['editor-open'],
    ['act', 'ed-page'], ['act', 'ed-rotate'],
    ['editor-reader'],
    ['act', 'ed-undo'], ['act', 'ed-redo'],
    ['act', 'ed-grid'],
    ['editor-select-delete-target'],
    ['act', 'ed-delete'], ['act', 'ed-insert'],
    ['editor-reader'], ['act', 'ed-tool', 'crop'],
    ['editor-crop-drag'], ['act', 'ed-scope', 'All pages'], ['act', 'ed-crop-apply'],
    ['act', 'ed-grid'],
  ];

  async function waitFor(predicate, label, timeout = 10000) {
    const until = Date.now() + timeout;
    while (!predicate()) {
      if (Date.now() >= until) throw new Error(`Timed out waiting for ${label}`);
      await sleep(25);
    }
  }

  function firstAction(act, value) {
    const selector = value === undefined
      ? `[data-act="${act}"]`
      : `[data-act="${act}"][data-tool="${value}"], [data-act="${act}"][data-scope="${value}"]`;
    const element = document.querySelector(selector);
    if (!element) return null;
    element.click();
    return element;
  }

  async function dragCrop() {
    const canvas = document.querySelector('[data-act="ed-canvas"]');
    if (!canvas) throw new Error('Trace crop canvas is not available');
    const bounds = canvas.getBoundingClientRect();
    const point = (x, y) => ({clientX: bounds.left + bounds.width * x, clientY: bounds.top + bounds.height * y});
    canvas.dispatchEvent(new PointerEvent('pointerdown', {...point(.2, .2), bubbles: true, pointerId: 1, button: 0}));
    canvas.dispatchEvent(new PointerEvent('pointermove', {...point(.8, .8), bubbles: true, pointerId: 1, buttons: 1}));
    canvas.dispatchEvent(new PointerEvent('pointerup', {...point(.8, .8), bubbles: true, pointerId: 1, button: 0}));
    await waitFor(() => Boolean(editor.state.cropRect), 'crop rectangle');
  }

  async function step(kind, arg, extra, options, strict = false) {
    if (kind === 'page') document.querySelector(`.navbtn[data-page="${arg}"]`)?.click();
    if (kind === 'act') {
      /* Tool selection rebuilds the side pane synchronously in the app, but
         Electron can paint that replacement after the next trace step.  Wait
         for Crop's scope control before resolving the strict selector. */
      if (arg === 'ed-scope' && extra === 'All pages') {
        await waitFor(() => Boolean(document.querySelector('[data-act="ed-scope"][data-scope="All pages"]')), 'crop scope control');
      }
      const element = firstAction(arg, extra);
      if (strict && !element) throw new Error(`Trace action is not available: ${arg}`);
    }
    if (kind === 'click') document.querySelector(arg)?.click();
    if (kind === 'key') {
      document.dispatchEvent(new KeyboardEvent('keydown', {
        key: arg, ctrlKey: Boolean(extra), bubbles: true, cancelable: true,
      }));
    }
    if (kind === 'editor-open') {
      if (!options.fixturePath) throw new Error('Editor trace requires options.fixturePath from the local Electron run');
      /* The legacy sequence may leave an overlay mounted in Electron even
         after its close action has rendered once.  Reset those transient
         layers before entering the session-backed editor steps. */
      if (typeof closeSettings === 'function') closeSettings();
      if (typeof paletteOpen !== 'undefined') paletteOpen = false;
      document.querySelector('.navbtn[data-page="editor"]')?.click();
      if (typeof render === 'function') render(true);
      await OneToolEditorActions.openDocument([options.fixturePath]);
      await waitFor(() => Boolean(editor.state.sessionId), 'editor session');
      if (editor.state.pages.length < 2) throw new Error('Editor trace fixture must contain at least two pages');
    }
    if (kind === 'editor-reader') {
      if (!editor.current()) throw new Error('Trace editor has no current page');
      editor.openReader(editor.current().id);
      render(true);
    }
    if (kind === 'editor-select-delete-target') {
      const target = document.querySelectorAll('[data-act="ed-page"]')[1];
      if (!target) throw new Error('Trace editor needs a second page to delete');
      target.click();
    }
    if (kind === 'editor-crop-drag') await dragCrop();
    if (kind === 'act' && arg === 'ed-tool' && extra === 'crop') {
      await waitFor(() => Boolean(document.querySelector('[data-act="ed-scope"][data-scope="All pages"]')), 'crop tool pane');
    }
    if (kind === 'act' && ['ed-rotate', 'ed-undo', 'ed-redo', 'ed-delete', 'ed-insert', 'ed-crop-apply'].includes(arg)) {
      await waitFor(() => !editor.state.pending, `${arg} response`);
      /* Give the async action's final render a fixed window before the next
         scripted step records its counters. */
      await sleep(200);
    }
    await sleep(150);
  }

  function snapshot() {
    const struct = [], styled = [];
    document.querySelectorAll('body *:not(script)').forEach(el => {
      const id = el.tagName + '.' + [...el.classList].sort().join('.');
      struct.push(id);
      const cs = getComputedStyle(el);
      styled.push(id + '{' + STYLE_PROPS.map(p => cs.getPropertyValue(p)).join('|') + '}');
    });
    return {
      elements: struct.length,
      structure: hash(struct.join('|')),
      computed: hash(styled.join('\n')),
    };
  }

  window.trace = async function trace(options = {}) {
    const t = instrument();
    const steps = [];
    const stableIds = new Map();
    const normalizeRequest = request => request.replace(/ed_[0-9a-f]{32}/g, 'ed_<session>').replace(/page_[0-9a-f]{32}/g, id => {
      if (!stableIds.has(id)) stableIds.set(id, `page_<${stableIds.size + 1}>`);
      return stableIds.get(id);
    });
    try {
      const allSteps = [...SCRIPT, ...EDITOR_SCRIPT];
      for (let index = 0; index < allSteps.length; index += 1) {
        const [kind, arg, extra] = allSteps[index];
        const before = { req: t.requests.length, toast: t.toasts.length, render: t.renders };
        await step(kind, arg, extra, options, index >= SCRIPT.length);
        steps.push({
          step: `${kind}:${arg}`,
          requests: t.requests.slice(before.req).map(r => normalizeRequest(`${r.method} ${r.url} ${r.body ?? ''}`.trim())),
          toasts: t.toasts.slice(before.toast).map(x => `${x.ok ? 'ok' : 'err'} ${x.title}`),
          renders: t.renders - before.render,
          page: typeof page !== 'undefined' ? page : null,
        });
      }
      /* Freeze motion while hashing so repeated Electron runs do not land on
         different animation frames.  The temporary style is removed in the
         same turn, leaving the page untouched after instrumentation stops. */
      const freeze = document.createElement('style');
      freeze.textContent = '*,*::before,*::after{animation:none!important;transition:none!important}';
      document.head.appendChild(freeze);
      await sleep(50);
      const final = snapshot();
      freeze.remove();
      return {
        steps,
        final,
        totals: {
          requests: t.requests.length,
          toasts: t.toasts.length,
          renders: t.renders,
          errors: t.errors.length,
        },
        errors: t.errors,
        polled: Boolean(t.polled),
      };
    } finally {
      t.stop();
    }
  };
  return 'trace() installed';
})();
