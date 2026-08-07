(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.OneToolActionState = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function isSettled(files) {
    return Array.isArray(files) && files.length > 0
      && files.every(file => file.status === 'done' || file.status === 'error');
  }

  function nextActionStatus(current, files) {
  if (current === 'pending') {
    if (!isSettled(files)) return current;
    return files.some(file => file.status === 'done') ? 'success' : 'idle';
  }
  if (current === 'idle' && isSettled(files) && files.some(file => file.status === 'done')) {
    return 'success';
  }
  if (current === 'success') {
      return isSettled(files) && files.some(file => file.status === 'done')
        ? 'success'
        : 'idle';
    }
    return current;
  }

  function actionButtonClass(status) {
    return `btn btn-primary press go${status === 'success' ? ' success' : ''}`;
  }

  return {isSettled, nextActionStatus, actionButtonClass};
}));
