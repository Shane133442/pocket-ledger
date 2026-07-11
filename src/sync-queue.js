export function createDebouncedQueue(callback) {
  let timer = null;
  return function queue(delay = 650) {
    clearTimeout(timer);
    timer = setTimeout(() => void callback(), delay);
  };
}
