function skeletonHtml() {
  const widths = [['58%','34%'], ['46%','28%'], ['64%','38%'], ['52%','31%']];
  return `<div class="skel">${widths.map(([w1, w2], i) => `<div class="skel-row">
    <span class="skel-b pulse" style="width:34px;height:44px;border-radius:var(--radius-xs);animation-delay:${i * 60}ms"></span>
    <span style="flex:1;display:flex;flex-direction:column;gap:var(--space-2)">
      <i class="skel-b pulse" style="height:10px;width:${w1};animation-delay:${i * 60}ms"></i>
      <i class="skel-b pulse" style="height:9px;width:${w2};animation-delay:${i * 60 + 120}ms"></i></span>
    <span class="skel-b pulse" style="width:96px;height:26px;border-radius:var(--radius-pill);animation-delay:${i * 60 + 60}ms"></span>
    <span class="skel-b pulse" style="width:132px;height:10px;animation-delay:${i * 60 + 180}ms"></span>
  </div>`).join('')}</div>`;
}
