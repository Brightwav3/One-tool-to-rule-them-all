const destCount = () => new Set(tools.map(t => t.to)).size;
const commonFolder = () => { if (!files.length) return outputFolder || '~/Converted'; const raw = files[0].out || outputFolder || '~/Converted'; return raw.replace(/[\\/][^\\/]+$/, '') || outputFolder || '~/Converted'; };
const routeStateLabel = t => t.state === 'ready' ? 'Ready' : t.state === 'helper' ? 'Needs helper' : 'Not built yet';
const routeStateClass = t => t.state === 'ready' ? 'ready' : t.state === 'helper' ? 'helper' : '';
