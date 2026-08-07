const helperNames = () => [...new Set(tools.flatMap(t => [t.helper?.name, ...(t.requirements||[]).map(r => r.name)]).filter(Boolean))];
const helperData = name => {
  const direct = tools.find(i => i.helper?.name === name)?.helper;
  if (direct) return direct;
  const requirement = tools.flatMap(i => i.requirements || []).find(i => i.name === name);
  return requirement || {name, why:`${name} is used by one or more converters.`, cmd:'', url:'', download:'', found:false};
};
const helperFound = name => Boolean(helperData(name).found);
const helperTools = name => tools.filter(t => t.helper?.name === name || t.requirements?.some(r => r.name === name));
const waitingOn = name => files.filter(f => toolMap[f.conv]?.helper?.name === name && isBlocked(f));
