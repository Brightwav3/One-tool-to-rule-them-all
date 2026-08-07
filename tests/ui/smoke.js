/* Differential UI smoke harness.
 *
 * Paste into the console of a running One Tool UI and call `await smoke()`.
 * It returns a JSON report. Run it against the baseline build and against the
 * refactored build, then diff the two reports: a thrown error only counts as a
 * regression if it appears on the refactored side and not on the baseline.
 * That is what separates a real break from something that fails in a plain
 * browser because the Electron bridge (window.appWindow) is absent.
 *
 * Nothing here is app code. It observes and clicks; it does not patch
 * behaviour beyond wrapping console.error and the two global error events.
 */
(() => {
  /* Actions that spend real time or touch real files. Clicking them would make
     the two runs diverge for reasons that have nothing to do with the
     refactor, so they are recorded as skipped rather than fired. */
  const DESTRUCTIVE = /^(convert|apply-all|remove|delete|clear|reset|create|build|install|unlock|rename|again|retry|stop|cancel)/i;

  const sleep = ms => new Promise(r => setTimeout(r, ms));

  /* Some actions reach a hidden <input type="file"> and click it. That opens a
     native file dialog, which nothing in an automated run will ever dismiss, so
     the sweep stops there. Suppress just those clicks for the duration; the
     handler still runs, only the dialog does not open. */
  function muteFilePickers() {
    const real = HTMLInputElement.prototype.click;
    HTMLInputElement.prototype.click = function () {
      if (this.type === 'file') return;
      return real.apply(this, arguments);
    };
    return () => { HTMLInputElement.prototype.click = real; };
  }

  function instrument() {
    const errors = [];
    const origError = console.error;
    console.error = (...args) => { errors.push({ kind: 'console.error', text: args.map(String).join(' ') }); origError.apply(console, args); };
    const onError = e => errors.push({ kind: 'error', text: `${e.message} @ ${e.filename}:${e.lineno}` });
    const onReject = e => errors.push({ kind: 'unhandledrejection', text: String(e.reason && e.reason.message || e.reason) });
    addEventListener('error', onError);
    addEventListener('unhandledrejection', onReject);
    return {
      errors,
      stop() { console.error = origError; removeEventListener('error', onError); removeEventListener('unhandledrejection', onReject); },
    };
  }

  /* A view fingerprint that survives cosmetic reflow but changes when the
     rendered structure changes: tag names and class lists, no text, no ids. */
  function fingerprint(root = document.body) {
    const parts = [];
    root.querySelectorAll('*').forEach(el => {
      parts.push(el.tagName + '.' + [...el.classList].sort().join('.'));
    });
    return { count: parts.length, hash: cyrb53(parts.join('|')) };
  }

  function cyrb53(str) {
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

  const actionsOnPage = () =>
    [...new Set([...document.querySelectorAll('[data-act]')].map(el => el.dataset.act))].sort();

  async function visitPages(report, mon) {
    for (const name of ['convert', 'creator', 'editor']) {
      const btn = document.querySelector(`.navbtn[data-page="${name}"]`);
      if (!btn) { report.pages[name] = { reached: false }; continue; }
      const before = mon.errors.length;
      btn.click();
      await sleep(120);
      report.pages[name] = {
        reached: (typeof page !== 'undefined') && page === name,
        fingerprint: fingerprint(),
        actions: actionsOnPage(),
        newErrors: mon.errors.slice(before),
      };
    }
    document.querySelector('.navbtn[data-page="convert"]')?.click();
    await sleep(120);
  }

  async function sweepActions(report, mon) {
    for (const name of ['convert', 'creator', 'editor']) {
      document.querySelector(`.navbtn[data-page="${name}"]`)?.click();
      await sleep(100);
      for (const act of actionsOnPage()) {
        if (DESTRUCTIVE.test(act)) { report.actions.push({ page: name, act, result: 'skipped' }); continue; }
        const el = document.querySelector(`[data-act="${act}"]`);
        if (!el) { report.actions.push({ page: name, act, result: 'gone' }); continue; }
        const before = mon.errors.length;
        try { el.click(); } catch (e) { report.actions.push({ page: name, act, result: 'threw', text: String(e.message) }); continue; }
        await sleep(70);
        const raised = mon.errors.slice(before);
        report.actions.push({ page: name, act, result: raised.length ? 'raised' : 'ok', ...(raised.length ? { text: raised.map(r => r.text).join(' ; ') } : {}) });
        document.body.click();          /* dismiss whatever opened */
        await sleep(40);
      }
    }
  }

  async function probeGlobals(report) {
    const names = ['render', 'api', 'absorb', 'setPage', 'convert', 'renderConvert', 'renderEditor',
      'renderCreator', 'renderSettings', 'renderPanel', 'renderOverlays', 'showToast', 'openPalette',
      'contextItems', 'wireDrop', 'convertRows', 'visibleRows', 'unifiedRow', 'esc', 'fmtSize',
      'fmtWhen', 'ICON', 'creator', 'editor', 'tools', 'files'];
    report.globals = Object.fromEntries(names.map(n => {
      let t; try { t = eval(`typeof ${n}`); } catch (e) { t = 'THROWS:' + e.message; }
      return [n, t];
    }));
  }

  window.smoke = async function smoke() {
    const mon = instrument();
    const unmute = muteFilePickers();
    const report = {
      url: location.origin,
      scripts: [...document.scripts].map(s => s.src.replace(location.origin, '')),
      scriptCount: document.scripts.length,
      boot: { tools: (typeof tools !== 'undefined' ? tools.length : null), bodyLen: document.body.innerHTML.length },
      pages: {},
      actions: [],
      globals: {},
      errors: [],
    };
    await probeGlobals(report);
    await visitPages(report, mon);
    await sweepActions(report, mon);
    unmute();
    mon.stop();
    report.errors = mon.errors;
    report.summary = {
      actionsFired: report.actions.filter(a => a.result === 'ok').length,
      actionsRaised: report.actions.filter(a => a.result === 'raised' || a.result === 'threw').length,
      actionsSkipped: report.actions.filter(a => a.result === 'skipped').length,
      totalErrors: mon.errors.length,
    };
    return report;
  };
  return 'smoke() installed';
})();
