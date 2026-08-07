function wireDrop(zone) {
  if (!zone) return;
  zone.ondragover = e => { e.preventDefault(); zone.classList.add('over'); };
  zone.ondragleave = () => zone.classList.remove('over');
  zone.ondrop = async e => {
    e.preventDefault(); zone.classList.remove('over');
    pendingAdd = true; render(true);
    try {
    for (const file of [...e.dataTransfer.files]) {
      const source = shell?.getPathForFile?.(file) || file.path || '';
      try {
        if (source) await api('/api/add-path', {path: source});
        else {
          const res = await fetch('/api/upload', {method:'POST', headers:{'X-Filename':encodeURIComponent(file.name), 'X-File-Size':String(file.size)}, body:file});
          if (!res.ok) throw new Error('Upload failed');
          absorb(await res.json());
        }
      } catch (error) { showToast(error.message, false); }
    }
    } finally { pendingAdd = false; render(true); }
  };
}
