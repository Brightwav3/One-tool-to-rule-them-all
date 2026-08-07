const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fmtSize = bytes => { const n = Number(bytes || 0); if (!n) return ''; const u=['B','KB','MB','GB']; let v=n,i=0; while(v>=1024&&i<u.length-1){v/=1024;i++} return `${v.toFixed(v>=10||i===0?0:1)} ${u[i]}`; };
const fmtWhen = stamp => { const d = new Date(stamp); if (Number.isNaN(d.getTime())) return ''; const now=new Date();
  return d.toDateString()===now.toDateString() ? d.toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'}) : d.toLocaleDateString([], {day:'numeric',month:'short',year:'numeric'}); };
const byId = (items, key) => items.reduce((m, i) => { m[i[key]] = i; return m; }, {});
