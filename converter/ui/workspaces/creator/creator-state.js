/* Creator state — one output file built from a list of source items.
   Pure data, like the editor's model: the format decides which options exist, the
   items decide the totals, and a recipe sets both in one click. */
(function initCreatorState(root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.OneToolCreatorState = factory();
}(typeof self !== 'undefined' ? self : this, () => {
  const GROUPS = [
    {name: 'Comics', items: [
      {id: 'CBZ', title: 'CBZ', desc: 'Zip of images. The safe default for comic readers.', unit: 'Pages', opts: ['compress', 'meta', 'rename']},
      {id: 'CBR', title: 'CBR', desc: 'Rar of images. Needs a helper to write.', needs: '7-Zip', unit: 'Pages', opts: ['compress', 'meta']},
      {id: 'CB7', title: 'CB7', desc: '7-Zip of images. Smallest, slowest.', needs: '7-Zip', unit: 'Pages', opts: ['compress', 'meta']},
      {id: 'EPUB', title: 'EPUB', desc: 'Fixed-layout book for e-readers.', unit: 'Pages', opts: ['meta', 'spread']},
    ]},
    {name: 'Documents', items: [
      {id: 'PDF', title: 'PDF', desc: 'One document, one page per image.', unit: 'Pages', opts: ['pageSize', 'ocr', 'compress']},
      {id: 'DJVU', title: 'DjVu', desc: 'Scanned pages at small sizes.', unit: 'Pages', opts: ['pageSize', 'ocr']},
      {id: 'MOBI', title: 'MOBI', desc: 'No route from the items you added.', dis: true, unit: 'Pages', opts: []},
      {id: 'TIFF', title: 'Multi-TIFF', desc: 'One image file, many pages.', unit: 'Pages', opts: ['pageSize']},
    ]},
    {name: 'Archives', items: [
      {id: 'ZIP', title: 'ZIP', desc: 'Anything, anywhere. Opens everywhere.', unit: 'Files', opts: ['compress', 'flatten', 'encrypt']},
      {id: '7Z', title: '7z', desc: 'Best ratio. Encryption available.', needs: '7-Zip', unit: 'Files', opts: ['compress', 'encrypt', 'flatten']},
      {id: 'TGZ', title: 'tar.gz', desc: 'Unix-friendly, preserves permissions.', unit: 'Files', opts: ['compress', 'flatten']},
      {id: 'ISO', title: 'ISO', desc: 'Disc image from a folder tree.', unit: 'Files', opts: ['flatten']},
    ]},
  ];
  const ALL = GROUPS.flatMap(g => g.items);
  const format = id => ALL.find(f => f.id === id) || ALL[0];
  const findIn = (groups, id) => groups.flatMap(g => g.items).find(f => f.id === id);

  const OPTS = {
    compress: {kind: 'seg', label: 'Compression', choices: ['Store', 'Normal', 'Max'], def: 'Normal'},
    pageSize: {kind: 'seg', label: 'Page size', choices: ['Original', 'A4', 'Letter'], def: 'Original'},
    spread: {kind: 'seg', label: 'Spreads', choices: ['Keep', 'Split'], def: 'Keep'},
    meta: {kind: 'toggle', label: 'Write ComicInfo.xml', def: true, hint: 'Series, volume and page count, read by most comic apps.'},
    ocr: {kind: 'toggle', label: 'OCR text layer', def: false, hint: 'Makes the result searchable. Roughly doubles the time.'},
    encrypt: {kind: 'toggle', label: 'Encrypt with password', def: false},
    flatten: {kind: 'toggle', label: 'Flatten folders', def: false},
    rename: {kind: 'toggle', label: 'Renumber pages', def: true, hint: 'Rewrites file names to 001, 002, … so readers keep the order.'},
    /* Free-text options. These carry the value the backend converter reads, so
       what is typed here is what the builder is given. */
    password: {kind: 'text', label: 'Password', def: '', secret: true, placeholder: 'none', hint: 'Encrypts the archive and hides the file names inside it.'},
    title: {kind: 'text', label: 'Title', def: '', placeholder: 'from the file name'},
    creator: {kind: 'text', label: 'Author', def: '', placeholder: 'Unknown'},
    dpi: {kind: 'text', label: 'DPI', def: '150', placeholder: '150'},
    quality: {kind: 'text', label: 'JPEG quality', def: '90', placeholder: '90'},
  };

  /* The recipes shipped with the app. Each one sets options the containers
     really have, and leaves the destination empty so it means "wherever the app
     is saving" rather than naming a folder that may not exist. */
  const RECIPES = [
    {id: 'cbz', name: 'Comic → CBZ', ext: 'CBZ', dest: '', opts: {compress: 'Normal', meta: true, rename: true}},
    {id: 'zip', name: 'Deliver → ZIP flat', ext: 'ZIP', dest: '', opts: {compress: 'Store', flatten: true}},
    {id: 'bk', name: 'Backup → 7z, max', ext: '7Z', dest: '', opts: {compress: 'Max', flatten: false}},
    {id: 'book', name: 'Pages → EPUB', ext: 'EPUB', dest: '', opts: {rename: true}},
  ];

  /* GB above 1024 MB, MB above 1, KB below — the same ladder the queue uses. */
  const fmtSize = mb => mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : mb >= 1 ? `${mb.toFixed(1)} MB` : `${Math.round(mb * 1024)} KB`;

  function createCreatorState(options = {}) {
    const state = {
      stage: 'pick', fmt: 'CBZ', query: '',
      name: options.name || 'Untitled', dest: options.dest || '~/Converted',
      values: {}, items: options.items ? options.items.map(i => ({...i})) : [], nextId: 100,
      sort: 'manual', recipes: RECIPES.map(r => ({...r})), recipe: null,
      job: null, pct: 0,
    };

    /* The containers this build can really write. They start as the declared
       list and are replaced by the registry's own once it has been fetched, so
       the picker can never offer a container with no route behind it. */
    let groups = GROUPS;
    const current = () => findIn(groups, state.fmt) || groups.flatMap(g => g.items)[0] || format(state.fmt);
    function setContainers(next) {
      if (!Array.isArray(next) || !next.length) return false;
      groups = next;
      api.GROUPS = groups;
      if (!findIn(groups, state.fmt)) state.fmt = groups[0].items[0].id;
      return true;
    }
    /* An option the user has not touched reads as its default, so a format change
       never carries a stale value into a container that does not have that option. */
    const value = key => key in state.values ? state.values[key] : (OPTS[key] || {}).def;
    const setValue = (key, next) => { state.values = {...state.values, [key]: next}; };

    function sortedItems() {
      const items = state.items.map((item, k) => ({...item, k}));
      if (state.sort === 'name') return items.slice().sort((a, b) => String(a.name).localeCompare(String(b.name)));
      if (state.sort === 'size') return items.slice().sort((a, b) => b.size - a.size);
      return items;
    }
    const totalUnits = () => state.items.reduce((n, i) => n + (i.pages || 0), 0);
    const totalSize = () => state.items.reduce((n, i) => n + (i.size || 0), 0);

    function estimate() {
      const f = current();
      const ratio = {Store: 1, Normal: 0.84, Max: 0.66}[value('compress')] || 0.9;
      const size = f.opts.includes('compress') ? totalSize() * ratio : totalSize() * 0.92;
      const secs = Math.max(3, Math.round(totalSize() / 6
        * (value('compress') === 'Max' ? 2 : 1)
        * (f.opts.includes('ocr') && value('ocr') ? 2 : 1)));
      return {size, secs};
    }

    function chooseFormat(id) { state.fmt = id; state.job = null; state.pct = 0; }
    function toBuild() { state.stage = 'build'; }
    function toPick() { state.stage = 'pick'; state.job = null; state.pct = 0; }

    function addItems(items) {
      state.items = [...state.items, ...items.map((item, k) => ({...item, id: state.nextId + k}))];
      state.nextId += items.length;
      state.job = null; state.pct = 0;
    }
    function removeItem(id) { state.items = state.items.filter(i => i.id !== id); state.job = null; state.pct = 0; }
    /* Reordering is only meaningful against the order you can see, so nudging a row
       drops the view back to manual rather than fighting a sort. */
    function moveItem(id, delta) {
      const items = state.items.slice();
      const at = items.findIndex(i => i.id === id);
      const to = at + delta;
      if (at < 0 || to < 0 || to >= items.length) return false;
      [items[to], items[at]] = [items[at], items[to]];
      state.items = items; state.sort = 'manual';
      return true;
    }
    function cycleSort() { state.sort = state.sort === 'manual' ? 'name' : state.sort === 'name' ? 'size' : 'manual'; }

    function pickRecipe(id) {
      const recipe = state.recipes.find(r => r.id === id);
      if (!recipe) return false;
      state.recipe = id; state.fmt = recipe.ext;
      // An empty destination means "leave it where the app is already saving".
      if (recipe.dest) state.dest = recipe.dest;
      state.values = {...recipe.opts}; state.job = null; state.pct = 0;
      return true;
    }
    function saveRecipe() {
      const f = current();
      const opts = {};
      f.opts.forEach(key => { opts[key] = value(key); });
      const id = `r${state.recipes.length + 1}`;
      // `saved` marks a recipe as the user's own, so only those are written to
      // disk and the shipped examples can change between versions.
      state.recipes = [...state.recipes, {id, name: `${state.name.split(' (')[0]} → ${f.title}`, ext: state.fmt, dest: state.dest, opts, saved: true}];
      state.recipe = id;
      return id;
    }

    const isBlocked = (installed = {}) => {
      const f = current();
      return Boolean(f.needs && !installed[f.needs]);
    };
    const canCreate = (installed = {}) =>
      state.items.length > 0 && state.job !== 'running' && !isBlocked(installed) && !current().dis;

    /* The registry knows the real extension — .tar.gz is not .tgz. */
    const outputName = () => `${state.name}${current().ext || `.${state.fmt.toLowerCase()}`}`;
    const outputPath = () => `${state.dest}/${outputName()}`;

    const api = {
      state, GROUPS, OPTS, ALL,
      format: current, formatById: format, value, setValue, setContainers,
      sortedItems, totalUnits, totalSize, estimate,
      chooseFormat, toBuild, toPick,
      addItems, removeItem, moveItem, cycleSort,
      pickRecipe, saveRecipe,
      isBlocked, canCreate, outputName, outputPath,
    };
    return api;
  }

  return {createCreatorState, GROUPS, OPTS, RECIPES, fmtSize, format};
}));
